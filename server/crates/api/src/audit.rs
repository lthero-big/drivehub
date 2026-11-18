//! Audit system core (DEPTAI-475): rich events, a single ordered writer that appends rows to
//! `audit_log` as a SHA-256 hash chain (tampering / deletion is detected by [`verify`]),
//! retention purge (moves the chain anchor), and alert rules evaluated on every event
//! (burst of downloads/deletes, login from a new network) delivered to log / webhook / e-mail.
use crate::auth::{now, Auth, Mail, Principal};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Default, Serialize)]
pub struct AuditEvent {
    pub ts: i64,
    pub user_id: Option<i64>,
    pub username: String,
    pub ip: String,
    pub ua: String,
    /// web | android | webdav | api
    pub client: String,
    /// api | webdav | auth | share | admin
    pub channel: String,
    pub action: String,
    pub path: String,
    pub storage: String,
    pub allowed: bool,
    pub bytes: i64,
    pub share_id: Option<i64>,
    pub detail: String,
}

impl AuditEvent {
    pub fn new(
        p: &Principal,
        channel: &str,
        action: &str,
        path: &str,
        allowed: bool,
        detail: &str,
    ) -> Self {
        let path = format!("/{}", path.trim_matches('/'));
        let storage = path
            .trim_start_matches('/')
            .split('/')
            .next()
            .unwrap_or("")
            .to_string();
        Self {
            ts: 0,
            user_id: p.uid(),
            username: p.name(),
            ip: p.ip.clone(),
            ua: p.ua.clone(),
            client: p.client.to_string(),
            channel: channel.into(),
            action: action.into(),
            path,
            storage,
            allowed,
            bytes: 0,
            share_id: None,
            detail: detail.into(),
        }
    }
    pub fn bytes(mut self, n: i64) -> Self {
        self.bytes = n;
        self
    }
    pub fn share(mut self, id: i64) -> Self {
        self.share_id = Some(id);
        self
    }
}

/// Hash of one chain link: H(prev ‖ id ‖ every stored field).
pub fn chain_hash(prev: &str, id: i64, e: &AuditEvent) -> String {
    let mut h = Sha256::new();
    let fields: [String; 16] = [
        prev.to_string(),
        id.to_string(),
        e.ts.to_string(),
        e.user_id.map(|v| v.to_string()).unwrap_or_default(),
        e.username.clone(),
        e.ip.clone(),
        e.ua.clone(),
        e.client.clone(),
        e.channel.clone(),
        e.action.clone(),
        e.path.clone(),
        e.storage.clone(),
        (e.allowed as i64).to_string(),
        e.bytes.to_string(),
        e.share_id.map(|v| v.to_string()).unwrap_or_default(),
        e.detail.clone(),
    ];
    for f in fields {
        h.update(f.as_bytes());
        h.update([0x1f]);
    }
    data_encoding::HEXLOWER.encode(&h.finalize())
}

pub const COLS: &str = "id, ts, user_id, username, ip, ua, client, channel, action, path, storage, allowed, bytes, share_id, detail, prev_hash, hash";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AuditRow {
    pub id: i64,
    pub ts: i64,
    pub user_id: Option<i64>,
    pub username: String,
    pub ip: String,
    pub ua: String,
    pub client: String,
    pub channel: String,
    pub action: String,
    pub path: String,
    pub storage: String,
    pub allowed: bool,
    pub bytes: i64,
    pub share_id: Option<i64>,
    pub detail: String,
    pub prev_hash: String,
    pub hash: String,
}

impl AuditRow {
    pub fn event(&self) -> AuditEvent {
        AuditEvent {
            ts: self.ts,
            user_id: self.user_id,
            username: self.username.clone(),
            ip: self.ip.clone(),
            ua: self.ua.clone(),
            client: self.client.clone(),
            channel: self.channel.clone(),
            action: self.action.clone(),
            path: self.path.clone(),
            storage: self.storage.clone(),
            allowed: self.allowed,
            bytes: self.bytes,
            share_id: self.share_id,
            detail: self.detail.clone(),
        }
    }
    pub fn json(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap();
        v["time"] = json!(iso(self.ts));
        v
    }
}

/// Unix seconds → `YYYY-MM-DDTHH:MM:SSZ` (UTC).
pub fn iso(ts: i64) -> String {
    let days = ts.div_euclid(86400);
    let secs = ts.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

async fn anchor(db: &SqlitePool) -> sqlx::Result<(i64, String)> {
    let id = crate::settings::get_meta(db, "audit.anchor_id")
        .await?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let h = crate::settings::get_meta(db, "audit.anchor_hash")
        .await?
        .unwrap_or_default();
    Ok((id, h))
}

/// Seals legacy (pre-M3) rows into the chain and returns the chain head (id, hash).
async fn seal_and_head(db: &SqlitePool) -> anyhow::Result<(i64, String)> {
    let mut head = anchor(db).await?;
    let last: Option<(i64, String)> =
        sqlx::query_as("SELECT id, hash FROM audit_log WHERE hash != '' ORDER BY id DESC LIMIT 1")
            .fetch_optional(db)
            .await?;
    if let Some(l) = last {
        head = l;
    }
    let legacy: Vec<AuditRow> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM audit_log WHERE hash = '' AND id > ? ORDER BY id"
    ))
    .bind(head.0)
    .fetch_all(db)
    .await?;
    for r in legacy {
        // ids of legacy rows are already monotonic; the chain covers them as they are.
        let h = chain_hash(&head.1, r.id, &r.event());
        sqlx::query("UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?")
            .bind(&head.1)
            .bind(&h)
            .bind(r.id)
            .execute(db)
            .await?;
        head = (r.id, h);
    }
    Ok(head)
}

#[derive(Debug, Serialize)]
pub struct VerifyReport {
    pub ok: bool,
    pub checked: i64,
    pub anchor_id: i64,
    pub last_id: i64,
    pub first_bad_id: Option<i64>,
    pub reason: Option<String>,
}

/// Walks the whole chain from the retention anchor and recomputes every link.
pub async fn verify(db: &SqlitePool) -> anyhow::Result<VerifyReport> {
    let (aid, ahash) = anchor(db).await?;
    let (mut prev_id, mut prev_hash) = (aid, ahash);
    let mut rep = VerifyReport {
        ok: true,
        checked: 0,
        anchor_id: aid,
        last_id: aid,
        first_bad_id: None,
        reason: None,
    };
    let mut cursor = i64::MIN;
    loop {
        let rows: Vec<AuditRow> = sqlx::query_as(&format!(
            "SELECT {COLS} FROM audit_log WHERE id > ? ORDER BY id LIMIT 5000"
        ))
        .bind(cursor)
        .fetch_all(db)
        .await?;
        if rows.is_empty() {
            break;
        }
        for r in &rows {
            cursor = r.id;
            if r.id <= aid {
                continue; // below the anchor (purge in progress)
            }
            rep.checked += 1;
            rep.last_id = r.id;
            let bad = if r.id != prev_id + 1 {
                Some(format!(
                    "gap: expected id {}, found {} (rows deleted)",
                    prev_id + 1,
                    r.id
                ))
            } else if r.prev_hash != prev_hash {
                Some("prev_hash does not match previous row".to_string())
            } else if chain_hash(&prev_hash, r.id, &r.event()) != r.hash {
                Some("row content does not match its hash (modified)".to_string())
            } else {
                None
            };
            if let Some(why) = bad {
                rep.ok = false;
                rep.first_bad_id = Some(r.id);
                rep.reason = Some(why);
                return Ok(rep);
            }
            prev_id = r.id;
            prev_hash = r.hash.clone();
        }
    }
    Ok(rep)
}

/// Deletes events older than `days` (moving the chain anchor first). Returns rows deleted.
pub async fn purge(db: &SqlitePool, days: i64) -> anyhow::Result<(u64, i64)> {
    if days <= 0 {
        return Ok((0, anchor(db).await?.0));
    }
    let cutoff = now() - days * 86400;
    let last: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, hash FROM audit_log WHERE ts < ? AND hash != '' ORDER BY id DESC LIMIT 1",
    )
    .bind(cutoff)
    .fetch_optional(db)
    .await?;
    let Some((id, hash)) = last else {
        return Ok((0, anchor(db).await?.0));
    };
    crate::settings::set_meta(db, "audit.anchor_hash", &hash).await?;
    crate::settings::set_meta(db, "audit.anchor_id", &id.to_string()).await?;
    let r = sqlx::query("DELETE FROM audit_log WHERE id <= ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok((r.rows_affected(), id))
}

pub async fn retention_days(db: &SqlitePool) -> i64 {
    if let Some(d) = crate::settings::get_meta(db, "setting.audit_retention_days")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
    {
        return d;
    }
    std::env::var("DRIVEHUB_AUDIT_RETENTION_DAYS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------- alerts

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AlertRule {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub actions: String,
    pub threshold: i64,
    pub window_secs: i64,
    pub sink: String,
    pub target: String,
    pub enabled: bool,
    pub created_at: i64,
}

pub struct Alerts {
    rules: RwLock<Vec<AlertRule>>,
    cooldown: Mutex<HashMap<(i64, String), i64>>,
    http: reqwest::Client,
}

fn net_prefix(ip: &str) -> String {
    if ip.contains(':') {
        ip.split(':').take(3).collect::<Vec<_>>().join(":")
    } else if ip.split('.').count() == 4 {
        ip.split('.').take(2).collect::<Vec<_>>().join(".")
    } else {
        ip.to_string()
    }
}

impl Alerts {
    pub async fn reload(&self, db: &SqlitePool) -> sqlx::Result<()> {
        let v: Vec<AlertRule> = sqlx::query_as("SELECT * FROM alert_rules ORDER BY id")
            .fetch_all(db)
            .await?;
        *self.rules.write().unwrap() = v;
        Ok(())
    }

    async fn evaluate(&self, db: &SqlitePool, auth: &Arc<Auth>, id: i64, e: &AuditEvent) {
        let rules: Vec<AlertRule> = self
            .rules
            .read()
            .unwrap()
            .iter()
            .filter(|r| r.enabled)
            .cloned()
            .collect();
        for r in rules {
            let who = if e.user_id.is_some() {
                e.username.clone()
            } else {
                format!("anonymous@{}", e.ip)
            };
            let hit = match r.kind.as_str() {
                "burst" => {
                    let acts: Vec<&str> = r.actions.split(',').map(str::trim).collect();
                    if !e.allowed || !acts.contains(&e.action.as_str()) || r.threshold <= 0 {
                        None
                    } else {
                        let n: i64 = sqlx::query_scalar(
                            "SELECT COUNT(*) FROM audit_log WHERE ts >= ? AND allowed = 1
                             AND instr(',' || ? || ',', ',' || action || ',') > 0
                             AND ((? IS NOT NULL AND user_id = ?) OR (? IS NULL AND user_id IS NULL AND ip = ?))",
                        )
                        .bind(e.ts - r.window_secs)
                        .bind(acts.join(","))
                        .bind(e.user_id)
                        .bind(e.user_id)
                        .bind(e.user_id)
                        .bind(&e.ip)
                        .fetch_one(db)
                        .await
                        .unwrap_or(0);
                        (n >= r.threshold).then(|| {
                            format!(
                                "{who}: {n} × [{}] within {}s (threshold {})",
                                r.actions, r.window_secs, r.threshold
                            )
                        })
                    }
                }
                "new_ip_login" if e.allowed && e.action == "login" && e.user_id.is_some() => {
                    let prior: Vec<String> = sqlx::query_scalar(
                        "SELECT DISTINCT ip FROM audit_log WHERE action = 'login' AND allowed = 1 AND user_id = ? AND id < ?",
                    )
                    .bind(e.user_id)
                    .bind(id)
                    .fetch_all(db)
                    .await
                    .unwrap_or_default();
                    let np = net_prefix(&e.ip);
                    (!prior.is_empty() && !prior.iter().any(|p| net_prefix(p) == np)).then(|| {
                        format!(
                            "{who}: login from new network {} (known: {})",
                            e.ip,
                            prior.join(", ")
                        )
                    })
                }
                _ => None,
            };
            let Some(msg) = hit else { continue };
            {
                let mut cd = self.cooldown.lock().unwrap();
                let k = (r.id, who.clone());
                if r.kind == "burst" {
                    if let Some(t) = cd.get(&k) {
                        if e.ts - t < r.window_secs.max(1) {
                            continue;
                        }
                    }
                }
                cd.insert(k, e.ts);
            }
            self.fire(db, auth, &r, &who, &e.ip, &msg, Some(e)).await;
        }
    }

    /// Records an alert event and delivers it in the background. Returns the alert event id.
    #[allow(clippy::too_many_arguments)]
    pub async fn fire(
        &self,
        db: &SqlitePool,
        auth: &Arc<Auth>,
        r: &AlertRule,
        who: &str,
        ip: &str,
        msg: &str,
        ev: Option<&AuditEvent>,
    ) -> i64 {
        tracing::warn!(rule = %r.name, %who, %msg, "audit alert");
        let id = sqlx::query(
            "INSERT INTO alert_events (ts, rule_id, rule_name, username, ip, message, sink, delivered) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(now())
        .bind(r.id)
        .bind(&r.name)
        .bind(who)
        .bind(ip)
        .bind(msg)
        .bind(&r.sink)
        .bind((r.sink == "log") as i64)
        .execute(db)
        .await
        .map(|x| x.last_insert_rowid())
        .unwrap_or(0);
        if r.sink == "log" {
            return id;
        }
        let payload = json!({"alert": r.name, "kind": r.kind, "rule_id": r.id, "user": who, "ip": ip,
                             "message": msg, "ts": now(), "time": iso(now()), "event": ev});
        let (db, auth, http, r) = (db.clone(), auth.clone(), self.http.clone(), r.clone());
        tokio::spawn(async move {
            let res: anyhow::Result<()> = match r.sink.as_str() {
                "webhook" => http
                    .post(&r.target)
                    .json(&payload)
                    .send()
                    .await
                    .and_then(|x| x.error_for_status())
                    .map(|_| ())
                    .map_err(Into::into),
                "email" => {
                    auth.mailer()
                        .send(Mail {
                            to: r.target.clone(),
                            subject: format!("[DriveHub] alert: {}", r.name),
                            body: format!(
                                "{}\n\n{}",
                                payload["message"].as_str().unwrap_or(""),
                                payload
                            ),
                        })
                        .await
                }
                s => Err(anyhow::anyhow!("unknown sink {s}")),
            };
            let (ok, err) = match res {
                Ok(()) => (1, String::new()),
                Err(e) => (0, e.to_string()),
            };
            let _ = sqlx::query("UPDATE alert_events SET delivered = ?, error = ? WHERE id = ?")
                .bind(ok)
                .bind(err)
                .bind(id)
                .execute(&db)
                .await;
        });
        id
    }
}

// ---------------------------------------------------------------- writer

enum Msg {
    Ev(Box<AuditEvent>),
    Flush(oneshot::Sender<()>),
}

pub struct AuditLog {
    tx: mpsc::UnboundedSender<Msg>,
    pub alerts: Arc<Alerts>,
}

impl AuditLog {
    pub async fn start(db: SqlitePool, auth: Arc<Auth>) -> anyhow::Result<Arc<Self>> {
        let mut head = seal_and_head(&db).await?;
        let alerts = Arc::new(Alerts {
            rules: RwLock::new(vec![]),
            cooldown: Mutex::new(HashMap::new()),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()?,
        });
        alerts.reload(&db).await?;
        let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
        let al = alerts.clone();
        tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                match m {
                    Msg::Flush(done) => {
                        let _ = done.send(());
                    }
                    Msg::Ev(mut e) => {
                        if e.ts == 0 {
                            e.ts = now();
                        }
                        for attempt in 0..2 {
                            let id = head.0 + 1;
                            let h = chain_hash(&head.1, id, &e);
                            let r = sqlx::query(&format!(
                                "INSERT INTO audit_log ({COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                            ))
                            .bind(id)
                            .bind(e.ts)
                            .bind(e.user_id)
                            .bind(&e.username)
                            .bind(&e.ip)
                            .bind(&e.ua)
                            .bind(&e.client)
                            .bind(&e.channel)
                            .bind(&e.action)
                            .bind(&e.path)
                            .bind(&e.storage)
                            .bind(e.allowed)
                            .bind(e.bytes)
                            .bind(e.share_id)
                            .bind(&e.detail)
                            .bind(&head.1)
                            .bind(&h)
                            .execute(&db)
                            .await;
                            match r {
                                Ok(_) => {
                                    head = (id, h);
                                    al.evaluate(&db, &auth, id, &e).await;
                                    break;
                                }
                                Err(err) => {
                                    tracing::error!(error = %err, attempt, "audit insert failed");
                                    if let Ok(hd) = seal_and_head(&db).await {
                                        head = hd;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
        Ok(Arc::new(Self { tx, alerts }))
    }

    pub fn log(&self, e: AuditEvent) {
        if !e.allowed {
            tracing::warn!(user = %e.username, channel = %e.channel, action = %e.action, path = %e.path, detail = %e.detail, "access denied");
        }
        let _ = self.tx.send(Msg::Ev(Box::new(e)));
    }

    /// Waits until every event logged so far is persisted.
    pub async fn flush(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Msg::Flush(tx)).is_ok() {
            let _ = rx.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iso_dates() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(951782400), "2000-02-29T00:00:00Z");
        assert_eq!(iso(1795004130), "2026-11-18T12:15:30Z");
    }
    #[test]
    fn chain_hash_covers_fields() {
        let e = AuditEvent {
            ts: 1,
            action: "a".into(),
            ..Default::default()
        };
        let h = chain_hash("", 1, &e);
        assert_eq!(h.len(), 64);
        assert_ne!(h, chain_hash("x", 1, &e));
        assert_ne!(h, chain_hash("", 2, &e));
        let mut e2 = e.clone();
        e2.bytes = 1;
        assert_ne!(h, chain_hash("", 1, &e2));
    }
}
