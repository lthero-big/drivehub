//! File sharing (DEPTAI-474): short links `/s/<code>` (PIN entered, `?pin=` or `/s/<code>-<pin>`),
//! pickup codes, signed direct links `/d/<token>/<name>` with Range, expiry by days, visit /
//! download limits, preview / download / upload (collect) permissions, PIN brute-force
//! protection (per-IP + per-share limits, captcha after a few failures), owner management
//! and access statistics. Every access is audited on channel `share` with the share id.
#![allow(clippy::type_complexity)]
use crate::audit::AuditEvent;
use crate::auth::{now, random_token, Principal, CH_SHARE};
use crate::error::{ApiError, ApiResult};
use crate::fs_api::{counts_as_download, serve_entry};
use crate::AppState;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use data_encoding::BASE64URL_NOPAD;
use drivehub_core::acl::{CREATE, DOWNLOAD, READ, SHARE, UPLOAD};
use futures::TryStreamExt;
use hmac::{Hmac, Mac};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use utoipa::{IntoParams, ToSchema};

const CODE_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PIN_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
const TOKEN_TTL: i64 = 12 * 3600;

fn rand_str(alpha: &[u8], n: usize) -> String {
    let mut r = rand::thread_rng();
    (0..n)
        .map(|_| alpha[r.gen_range(0..alpha.len())] as char)
        .collect()
}

fn env_usize(k: &str, d: usize) -> usize {
    std::env::var(k)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}

// ---------------------------------------------------------------- brute-force guard

/// PIN / code brute-force protection: after `captcha_after` failures from one IP on one share a
/// captcha is required; `max_ip` failures per IP or `max_share` per share within `window`
/// answer 429.
pub struct ShareGuard {
    fails: Mutex<HashMap<String, Vec<Instant>>>,
    captchas: Mutex<HashMap<String, (String, Instant)>>,
    pub captcha_after: usize,
    pub max_ip: usize,
    pub max_share: usize,
    pub window: Duration,
}

impl ShareGuard {
    pub fn from_env() -> Self {
        Self {
            fails: Mutex::new(HashMap::new()),
            captchas: Mutex::new(HashMap::new()),
            captcha_after: env_usize("DRIVEHUB_SHARE_CAPTCHA_AFTER", 3),
            max_ip: env_usize("DRIVEHUB_SHARE_MAX_FAILS_IP", 10),
            max_share: env_usize("DRIVEHUB_SHARE_MAX_FAILS_SHARE", 50),
            window: Duration::from_secs(env_usize("DRIVEHUB_SHARE_FAIL_WINDOW_SECS", 900) as u64),
        }
    }
    fn count(&self, k: &str) -> usize {
        let mut m = self.fails.lock().unwrap();
        let w = self.window;
        let v = m.entry(k.to_string()).or_default();
        v.retain(|t| t.elapsed() < w);
        v.len()
    }
    pub fn blocked(&self, ip: &str, code: &str) -> bool {
        self.count(&format!("i:{ip}")) >= self.max_ip
            || (!code.is_empty() && self.count(&format!("s:{code}")) >= self.max_share)
    }
    pub fn need_captcha(&self, ip: &str, code: &str) -> bool {
        self.count(&format!("is:{ip}:{code}")) >= self.captcha_after
    }
    pub fn fail(&self, ip: &str, code: &str) {
        let mut m = self.fails.lock().unwrap();
        let mut keys = vec![format!("i:{ip}")];
        if !code.is_empty() {
            keys.push(format!("s:{code}"));
            keys.push(format!("is:{ip}:{code}"));
        }
        for k in keys {
            m.entry(k).or_default().push(Instant::now());
        }
    }
    pub fn success(&self, ip: &str, code: &str) {
        self.fails
            .lock()
            .unwrap()
            .remove(&format!("is:{ip}:{code}"));
    }
    /// New arithmetic captcha → (id, question).
    pub fn new_captcha(&self) -> (String, String) {
        let mut r = rand::thread_rng();
        let (a, b) = (r.gen_range(2..20), r.gen_range(1..10));
        let id = random_token(12);
        let mut m = self.captchas.lock().unwrap();
        m.retain(|_, (_, t)| t.elapsed() < Duration::from_secs(300));
        m.insert(id.clone(), ((a + b).to_string(), Instant::now()));
        (id, format!("{a} + {b} = ?"))
    }
    /// One-shot check (the captcha is consumed).
    pub fn check_captcha(&self, id: Option<&str>, answer: Option<&str>) -> bool {
        let (Some(id), Some(ans)) = (id, answer) else {
            return false;
        };
        match self.captchas.lock().unwrap().remove(id) {
            Some((want, t)) => t.elapsed() < Duration::from_secs(300) && want == ans.trim(),
            None => false,
        }
    }
    /// Test hook: the expected answer of a captcha.
    #[doc(hidden)]
    pub fn peek_captcha(&self, id: &str) -> Option<String> {
        self.captchas
            .lock()
            .unwrap()
            .get(id)
            .map(|(a, _)| a.clone())
    }
}

fn captcha_svg(q: &str) -> String {
    let mut r = rand::thread_rng();
    let mut lines = String::new();
    for _ in 0..6 {
        lines.push_str(&format!(
            "<line x1='{}' y1='{}' x2='{}' y2='{}' stroke='#{:06x}' stroke-width='1'/>",
            r.gen_range(0..160),
            r.gen_range(0..50),
            r.gen_range(0..160),
            r.gen_range(0..50),
            r.gen_range(0x404040..0xa0a0a0)
        ));
    }
    let mut text = String::new();
    for (i, c) in q.chars().enumerate() {
        text.push_str(&format!(
            "<text x='{}' y='{}' font-size='22' font-family='monospace' transform='rotate({} {} 30)' fill='#333'>{}</text>",
            10 + i * 14,
            30 + r.gen_range(0..8),
            r.gen_range(-15..15),
            10 + i * 14,
            c
        ));
    }
    format!("<svg xmlns='http://www.w3.org/2000/svg' width='160' height='50' viewBox='0 0 160 50'><rect width='160' height='50' fill='#f4f4f4'/>{lines}{text}</svg>")
}

// ---------------------------------------------------------------- model

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Share {
    pub id: i64,
    pub code: String,
    pub owner_id: Option<i64>,
    pub owner_name: String,
    pub name: String,
    pub items: String,
    pub perm: String,
    pub pin: Option<String>,
    pub require_login: bool,
    pub expires_at: Option<i64>,
    pub max_visits: Option<i64>,
    pub max_downloads: Option<i64>,
    pub visits: i64,
    pub downloads: i64,
    pub uploads: i64,
    pub bytes: i64,
    pub revoked: bool,
    pub created_at: i64,
    pub last_access: Option<i64>,
    pub kind: String,
    pub allow_download: bool,
    pub max_uploads: Option<i64>,
    pub max_bytes: Option<i64>,
    pub up_bytes: i64,
}

fn perm_level(p: &str) -> u8 {
    match p {
        "preview" => 1,
        "download" => 2,
        "upload" => 3,
        _ => 0,
    }
}

fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

impl Share {
    pub fn items(&self) -> Vec<String> {
        serde_json::from_str(&self.items).unwrap_or_default()
    }
    pub fn status(&self) -> &'static str {
        let t = now();
        if self.revoked {
            "revoked"
        } else if self.expires_at.is_some_and(|e| e <= t) {
            "expired"
        } else if self.max_downloads.is_some_and(|m| self.downloads >= m)
            || self.max_visits.is_some_and(|m| self.visits >= m)
        {
            "exhausted"
        } else {
            "active"
        }
    }
    /// Usable by visitors who already opened it (visit limit does not apply here).
    fn check_use(&self) -> ApiResult<()> {
        let t = now();
        let why = if self.revoked {
            Some("share revoked")
        } else if self.expires_at.is_some_and(|e| e <= t) {
            Some("share expired")
        } else if self.max_downloads.is_some_and(|m| self.downloads >= m) {
            Some("share download limit reached")
        } else {
            None
        };
        match why {
            Some(w) => Err(ApiError(StatusCode::GONE, w.into())),
            None => Ok(()),
        }
    }
    fn check_open(&self) -> ApiResult<()> {
        self.check_use()?;
        if self.max_visits.is_some_and(|m| self.visits >= m) {
            return Err(ApiError(
                StatusCode::GONE,
                "share visit limit reached".into(),
            ));
        }
        Ok(())
    }
    /// Share-relative path → real path (None = share root).
    fn resolve(&self, rel: &str) -> ApiResult<Option<String>> {
        let n = drivehub_storage::norm(rel)?;
        if n.is_empty() {
            return Ok(None);
        }
        let (first, rest) = n.split_once('/').unwrap_or((&n, ""));
        let items = self.items();
        let item = items
            .iter()
            .find(|i| basename(i) == first)
            .ok_or_else(|| ApiError::not_found("not in this share"))?;
        Ok(Some(if rest.is_empty() {
            item.clone()
        } else {
            format!("{item}/{rest}")
        }))
    }
}

pub async fn load_by_code(st: &AppState, code: &str) -> ApiResult<Option<Share>> {
    Ok(sqlx::query_as("SELECT * FROM shares WHERE code = ?")
        .bind(code)
        .fetch_optional(&st.db)
        .await?)
}

async fn load_by_id(st: &AppState, id: i64) -> ApiResult<Share> {
    sqlx::query_as("SELECT * FROM shares WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such share"))
}

// ---------------------------------------------------------------- tokens

type HmacSha256 = Hmac<Sha256>;

fn sign(st: &AppState, payload: &str) -> String {
    let mut m = HmacSha256::new_from_slice(&st.auth.jwt_secret).unwrap();
    m.update(b"drivehub-share\0");
    m.update(payload.as_bytes());
    BASE64URL_NOPAD.encode(&m.finalize().into_bytes()[..18])
}

fn make_token(st: &AppState, v: &Value) -> String {
    let p = BASE64URL_NOPAD.encode(v.to_string().as_bytes());
    let s = sign(st, &p);
    format!("{p}.{s}")
}

fn read_token(st: &AppState, tok: &str) -> Option<Value> {
    let (p, s) = tok.split_once('.')?;
    let want = sign(st, p);
    if !crate::auth::ct_eq(want.as_bytes(), s.as_bytes()) {
        return None;
    }
    let v: Value = serde_json::from_slice(&BASE64URL_NOPAD.decode(p.as_bytes()).ok()?).ok()?;
    (v["e"].as_i64()? > now()).then_some(v)
}

/// Visitor token issued after a successful open (PIN ok, visit counted).
fn visitor_token(st: &AppState, s: &Share) -> String {
    make_token(st, &json!({"k": "v", "s": s.id, "e": now() + TOKEN_TTL}))
}

/// Signed direct link path `/d/<token>/<name>`.
pub fn direct_path(st: &AppState, s: &Share, rel: &str) -> String {
    let exp = s.expires_at.unwrap_or(i64::MAX).min(now() + 7 * 86400);
    let tok = make_token(st, &json!({"k": "d", "s": s.id, "p": rel, "e": exp}));
    format!("/d/{tok}/{}", crate::fs_api::pct(basename(rel)))
}

fn base_url(st: &AppState) -> String {
    st.auth.public_url.clone().unwrap_or_default()
}

pub fn share_json(st: &AppState, s: &Share) -> Value {
    let base = base_url(st);
    let items = s.items();
    let url = format!("{base}/s/{}", s.code);
    let pickup = match &s.pin {
        Some(p) => format!("{}-{p}", s.code),
        None => s.code.clone(),
    };
    let direct = (items.len() == 1 && perm_level(&s.perm) >= 2 && s.status() == "active")
        .then(|| format!("{base}{}", direct_path(st, s, basename(&items[0]))));
    json!({
        "id": s.id, "code": s.code, "name": s.name, "owner_id": s.owner_id, "owner": s.owner_name,
        "items": items.iter().map(|i| format!("/{i}")).collect::<Vec<_>>(),
        "perm": s.perm, "pin": s.pin, "has_pin": s.pin.is_some(), "require_login": s.require_login,
        "expires_at": s.expires_at, "max_visits": s.max_visits, "max_downloads": s.max_downloads,
        "visits": s.visits, "downloads": s.downloads, "uploads": s.uploads, "bytes": s.bytes,
        "revoked": s.revoked, "status": s.status(), "created_at": s.created_at, "last_access": s.last_access,
        "url": url,
        "url_with_pin": s.pin.as_ref().map(|p| format!("{url}-{p}")),
        "pickup_code": pickup,
        "direct_url": direct,
        "kind": s.kind, "allow_upload": s.perm == "upload", "allow_download": s.allow_download,
        "max_uploads": s.max_uploads, "max_bytes": s.max_bytes, "up_bytes": s.up_bytes,
        "room_url": (s.kind == "room").then(|| format!("{base}/r/{}", s.code)),
    })
}

// ---------------------------------------------------------------- owner API

#[derive(Debug, Deserialize, ToSchema)]
pub struct NewShare {
    /// Virtual paths (files and/or folders) as seen by the caller.
    pub paths: Vec<String>,
    pub name: Option<String>,
    /// preview | download (default) | upload (collect files into the single shared folder)
    pub perm: Option<String>,
    /// Valid for N days (default: forever).
    pub days: Option<i64>,
    /// Alternative to `days` (seconds).
    pub expires_in_secs: Option<i64>,
    pub max_visits: Option<i64>,
    pub max_downloads: Option<i64>,
    /// Fixed PIN (3–16 letters/digits).
    pub pin: Option<String>,
    /// Generate a random 4-character PIN.
    #[serde(default)]
    pub random_pin: bool,
    #[serde(default)]
    pub require_login: bool,
    /// Drop room (快传房间): `paths` = [parent folder]; a fresh folder
    /// `<parent>/.droprooms/<rand>` is created and shared as a whole.
    #[serde(default)]
    pub room: bool,
    /// Room: visitors may upload (default true).
    pub allow_upload: Option<bool>,
    /// Room / share: visitors may download (default true).
    pub allow_download: Option<bool>,
    /// Room: max number of uploaded files.
    pub max_uploads: Option<i64>,
    /// Room: max total uploaded bytes.
    pub max_bytes: Option<i64>,
}

fn check_pin(pin: &str) -> ApiResult<()> {
    if !(3..=16).contains(&pin.len()) || !pin.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ApiError::bad("pin must be 3-16 letters/digits"));
    }
    Ok(())
}

fn check_perm(p: &str) -> ApiResult<()> {
    if perm_level(p) == 0 {
        return Err(ApiError::bad("perm must be preview | download | upload"));
    }
    Ok(())
}

/// Creates a share (needs `share` + `read` on every item; `download` / `upload` for those modes).
#[utoipa::path(operation_id = "share_create", post, path = "/api/shares", request_body = NewShare, responses((status = 200, description = "share")))]
pub async fn create(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<NewShare>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?.clone();
    sweep_rooms(&st).await;
    let mut b = b;
    if b.room {
        let parent = b.paths.first().cloned().unwrap_or_else(|| "/".into());
        let up = b.allow_upload.unwrap_or(true);
        let preal = p.map_in(&parent)?;
        st.authorize(&p, &preal, SHARE | READ | UPLOAD | CREATE, CH_SHARE, "room_create")?;
        let base_real = format!("{}/.droprooms", preal.trim_end_matches('/'));
        let (mount, base) = st.vfs.resolve_in(&base_real, true)?;
        if mount.driver.stat(&base).await.is_err() {
            mount.driver.mkdir(&base).await?;
        }
        let folder = rand_str(CODE_ALPHABET, 10);
        mount.driver.mkdir(&format!("{base}/{folder}")).await?;
        st.vfs.invalidate(&mount.cfg.name);
        let vp = format!("{}/.droprooms/{folder}", parent.trim_end_matches('/'));
        b.paths = vec![vp];
        b.perm = Some(if up { "upload" } else { "download" }.into());
        if b.name.as_deref().is_none_or(|n| n.trim().is_empty()) {
            b.name = Some(format!("快传房间 {folder}"));
        }
    }
    let perm = b.perm.clone().unwrap_or_else(|| "download".into());
    check_perm(&perm)?;
    if b.paths.is_empty() {
        return Err(ApiError::bad("paths required"));
    }
    let mut need = SHARE | READ;
    if perm_level(&perm) >= 2 {
        need |= DOWNLOAD;
    }
    let mut items: Vec<String> = vec![];
    for up in &b.paths {
        let real = p.map_in(up)?;
        st.authorize(&p, &real, need, CH_SHARE, "share_create")?;
        let (mount, rel) = st.vfs.resolve_in(&real, false)?;
        let e = mount.driver.stat(&rel).await?;
        if perm == "upload" {
            if !e.is_dir || b.paths.len() != 1 {
                return Err(ApiError::bad("upload shares need exactly one folder"));
            }
            st.authorize(&p, &real, UPLOAD, CH_SHARE, "share_create")?;
        }
        if items.iter().any(|i| basename(i) == basename(&real)) {
            return Err(ApiError::bad(format!(
                "duplicate item name: {}",
                basename(&real)
            )));
        }
        items.push(real);
    }
    let pin = match (&b.pin, b.random_pin) {
        (Some(x), _) if !x.is_empty() => {
            check_pin(x)?;
            Some(x.clone())
        }
        (_, true) => Some(rand_str(PIN_ALPHABET, 4)),
        _ => None,
    };
    let expires = match (b.expires_in_secs, b.days) {
        (Some(s), _) => Some(now() + s),
        (None, Some(d)) if d > 0 => Some(now() + d * 86400),
        _ => None,
    };
    let name = b
        .name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            let first = basename(&items[0]).to_string();
            if items.len() > 1 {
                format!("{first} 等 {} 项", items.len())
            } else {
                first
            }
        });
    let mut id = 0;
    for _ in 0..5 {
        let code = rand_str(CODE_ALPHABET, 8);
        let r = sqlx::query(
            "INSERT INTO shares (code, owner_id, owner_name, name, items, perm, pin, require_login, expires_at, max_visits, max_downloads, created_at, kind, allow_download, max_uploads, max_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&code)
        .bind(u.id)
        .bind(&u.username)
        .bind(&name)
        .bind(serde_json::to_string(&items).unwrap())
        .bind(&perm)
        .bind(&pin)
        .bind(b.require_login)
        .bind(expires)
        .bind(b.max_visits.filter(|v| *v > 0))
        .bind(b.max_downloads.filter(|v| *v > 0))
        .bind(now())
        .bind(if b.room { "room" } else { "share" })
        .bind(b.allow_download.unwrap_or(true))
        .bind(b.max_uploads.filter(|v| *v > 0))
        .bind(b.max_bytes.filter(|v| *v > 0))
        .execute(&st.db)
        .await;
        if let Ok(r) = r {
            id = r.last_insert_rowid();
            break;
        }
    }
    if id == 0 {
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not allocate share code".into(),
        ));
    }
    let s = load_by_id(&st, id).await?;
    st.audit_ev(
        AuditEvent::new(
            &p,
            CH_SHARE,
            "share_create",
            &items[0],
            true,
            &format!(
                "items={} perm={perm} pin={} days={:?} max_visits={:?} max_downloads={:?}",
                items.len(),
                pin.is_some(),
                b.days,
                b.max_visits,
                b.max_downloads
            ),
        )
        .share(id),
    );
    Ok(Json(share_json(&st, &s)))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ListSharesQuery {
    /// Admin: all users' shares.
    pub all: Option<bool>,
}

/// My shares (admin: `?all=true` for everyone's).
#[utoipa::path(operation_id = "share_list", get, path = "/api/shares", params(ListSharesQuery), responses((status = 200, description = "shares")))]
pub async fn list(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<ListSharesQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    let u = p.require_user()?;
    let all = q.all.unwrap_or(false) && p.is_admin();
    let rows: Vec<Share> =
        sqlx::query_as("SELECT * FROM shares WHERE (? = 1 OR owner_id = ?) ORDER BY id DESC")
            .bind(all as i64)
            .bind(u.id)
            .fetch_all(&st.db)
            .await?;
    Ok(Json(rows.iter().map(|s| share_json(&st, s)).collect()))
}

async fn owned(st: &AppState, p: &Principal, id: i64) -> ApiResult<Share> {
    let u = p.require_user()?;
    let s = load_by_id(st, id).await?;
    if s.owner_id != Some(u.id) && !p.is_admin() {
        return Err(ApiError::not_found("no such share"));
    }
    Ok(s)
}

/// One share with access statistics (recent audit events for it).
#[utoipa::path(operation_id = "share_get_one", get, path = "/api/shares/{id}", params(("id" = i64, Path)), responses((status = 200, description = "share + stats")))]
pub async fn get_one(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let s = owned(&st, &p, id).await?;
    st.audit_log.flush().await;
    let rows: Vec<crate::audit::AuditRow> = sqlx::query_as(&format!(
        "SELECT {} FROM audit_log WHERE share_id = ? ORDER BY id DESC LIMIT 100",
        crate::audit::COLS
    ))
    .bind(id)
    .fetch_all(&st.db)
    .await?;
    let by_action: Vec<(String, i64)> = sqlx::query_as(
        "SELECT action, COUNT(*) FROM audit_log WHERE share_id = ? GROUP BY action ORDER BY 2 DESC",
    )
    .bind(id)
    .fetch_all(&st.db)
    .await?;
    let ips: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT ip) FROM audit_log WHERE share_id = ? AND action IN ('share_visit','share_claim')",
    )
    .bind(id)
    .fetch_one(&st.db)
    .await?;
    let mut v = share_json(&st, &s);
    v["stats"] = json!({
        "by_action": by_action.into_iter().map(|(a, n)| json!({"action": a, "count": n})).collect::<Vec<_>>(),
        "unique_ips": ips,
        "recent": rows.iter().map(|r| r.json()).collect::<Vec<_>>(),
    });
    Ok(Json(v))
}

/// Changes limits: any of `days`, `expires_in_secs`, `expires_at` (null = never), `max_visits`,
/// `max_downloads` (null = unlimited), `pin` (null = remove), `random_pin`, `perm`,
/// `require_login`, `name`, `revoked`, `reset_counters`.
#[utoipa::path(operation_id = "share_patch", patch, path = "/api/shares/{id}", params(("id" = i64, Path)), request_body = Value, responses((status = 200, description = "share")))]
pub async fn patch(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
    Json(b): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut s = owned(&st, &p, id).await?;
    let o = b
        .as_object()
        .ok_or_else(|| ApiError::bad("object expected"))?;
    let opt_i = |k: &str| -> ApiResult<Option<i64>> {
        match o.get(k) {
            Some(Value::Null) => Ok(None),
            Some(v) => v
                .as_i64()
                .map(Some)
                .ok_or_else(|| ApiError::bad(format!("{k}: integer expected"))),
            None => Ok(None),
        }
    };
    if o.contains_key("expires_at") {
        s.expires_at = opt_i("expires_at")?;
    }
    if let Some(d) = opt_i("days")? {
        s.expires_at = (d > 0).then(|| now() + d * 86400);
    }
    if let Some(x) = opt_i("expires_in_secs")? {
        s.expires_at = Some(now() + x);
    }
    if o.contains_key("max_visits") {
        s.max_visits = opt_i("max_visits")?.filter(|v| *v > 0);
    }
    if o.contains_key("max_downloads") {
        s.max_downloads = opt_i("max_downloads")?.filter(|v| *v > 0);
    }
    if let Some(v) = o.get("pin") {
        s.pin = match v {
            Value::Null => None,
            Value::String(x) if x.is_empty() => None,
            Value::String(x) => {
                check_pin(x)?;
                Some(x.clone())
            }
            _ => return Err(ApiError::bad("pin: string expected")),
        };
    }
    if o.get("random_pin").and_then(Value::as_bool) == Some(true) {
        s.pin = Some(rand_str(PIN_ALPHABET, 4));
    }
    if let Some(v) = o.get("perm").and_then(Value::as_str) {
        check_perm(v)?;
        s.perm = v.to_string();
    }
    if let Some(v) = o.get("require_login").and_then(Value::as_bool) {
        s.require_login = v;
    }
    if let Some(v) = o.get("revoked").and_then(Value::as_bool) {
        s.revoked = v;
    }
    if let Some(v) = o
        .get("name")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
    {
        s.name = v.trim().to_string();
    }
    if o.get("reset_counters").and_then(Value::as_bool) == Some(true) {
        s.visits = 0;
        s.downloads = 0;
    }
    // drop room settings (DEPTAI-464r)
    if let Some(v) = o.get("allow_download").and_then(Value::as_bool) {
        s.allow_download = v;
    }
    if s.kind == "room" {
        if let Some(v) = o.get("allow_upload").and_then(Value::as_bool) {
            s.perm = if v { "upload" } else { "download" }.into();
        }
        if o.contains_key("max_uploads") {
            s.max_uploads = opt_i("max_uploads")?.filter(|v| *v > 0);
        }
        if o.contains_key("max_bytes") {
            s.max_bytes = opt_i("max_bytes")?.filter(|v| *v > 0);
        }
    }
    sqlx::query("UPDATE shares SET name=?, perm=?, pin=?, require_login=?, expires_at=?, max_visits=?, max_downloads=?, visits=?, downloads=?, revoked=?, allow_download=?, max_uploads=?, max_bytes=? WHERE id=?")
        .bind(&s.name).bind(&s.perm).bind(&s.pin).bind(s.require_login).bind(s.expires_at)
        .bind(s.max_visits).bind(s.max_downloads).bind(s.visits).bind(s.downloads).bind(s.revoked)
        .bind(s.allow_download).bind(s.max_uploads).bind(s.max_bytes).bind(id)
        .execute(&st.db).await?;
    let keys: Vec<&str> = o
        .keys()
        .map(String::as_str)
        .filter(|k| *k != "pin")
        .collect();
    st.audit_ev(
        AuditEvent::new(
            &p,
            CH_SHARE,
            "share_update",
            &s.items().first().cloned().unwrap_or_default(),
            true,
            &format!("fields={}", keys.join(",")),
        )
        .share(id),
    );
    Ok(Json(share_json(&st, &load_by_id(&st, id).await?)))
}

/// Revokes a share immediately (links, tokens and direct links stop working).
#[utoipa::path(operation_id = "share_revoke", post, path = "/api/shares/{id}/revoke", params(("id" = i64, Path)), responses((status = 200, description = "share")))]
pub async fn revoke(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let s = owned(&st, &p, id).await?;
    sqlx::query("UPDATE shares SET revoked = 1 WHERE id = ?")
        .bind(id)
        .execute(&st.db)
        .await?;
    st.audit_ev(
        AuditEvent::new(
            &p,
            CH_SHARE,
            "share_revoke",
            &s.items().first().cloned().unwrap_or_default(),
            true,
            "",
        )
        .share(id),
    );
    Ok(Json(share_json(&st, &load_by_id(&st, id).await?)))
}

/// Deletes a share record.
#[utoipa::path(operation_id = "share_delete", delete, path = "/api/shares/{id}", params(("id" = i64, Path)), responses((status = 200, description = "deleted")))]
pub async fn delete(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let s = owned(&st, &p, id).await?;
    sqlx::query("DELETE FROM shares WHERE id = ?")
        .bind(id)
        .execute(&st.db)
        .await?;
    if s.kind == "room" {
        remove_room_folder(&st, &s).await;
    }
    st.audit_ev(
        AuditEvent::new(
            &p,
            CH_SHARE,
            "share_delete",
            &s.items().first().cloned().unwrap_or_default(),
            true,
            &s.code,
        )
        .share(id),
    );
    Ok(Json(json!({"ok": true})))
}

// ---------------------------------------------------------------- visitor API

#[derive(Debug, Deserialize, IntoParams, Default)]
pub struct OpenQuery {
    pub pin: Option<String>,
    pub captcha_id: Option<String>,
    pub captcha: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ClaimBody {
    /// Pickup code: `<code>`, `<code>-<pin>` or `<code> <pin>`; a full share URL also works.
    pub code: String,
    pub pin: Option<String>,
    pub captcha_id: Option<String>,
    pub captcha: Option<String>,
}

fn deny(code: StatusCode, v: Value) -> Response {
    (code, Json(v)).into_response()
}

/// Splits `abc123-pin` / `abc123 pin` / `.../s/abc123-pin` into (code, pin).
pub fn split_code(raw: &str) -> (String, Option<String>) {
    let raw = raw.trim();
    let raw = raw.rsplit("/s/").next().unwrap_or(raw);
    let raw = raw
        .split(['?', '#'])
        .next()
        .unwrap_or(raw)
        .trim_matches('/');
    let (c, pin) = match raw.split_once(['-', ' ']) {
        Some((c, p)) => (c, Some(p.trim().to_string()).filter(|p| !p.is_empty())),
        None => (raw, None),
    };
    (c.to_string(), pin)
}

async fn item_json(st: &AppState, s: &Share, real: &str) -> Value {
    let name = basename(real).to_string();
    let e = match st.vfs.resolve_in(real, false) {
        Ok((m, rel)) => m.driver.stat(&rel).await.ok(),
        Err(_) => None,
    };
    let _ = s;
    match e {
        Some(e) => {
            json!({"name": name, "path": format!("/{name}"), "is_dir": e.is_dir, "size": e.size, "modified_unix": e.modified_unix})
        }
        None => json!({"name": name, "path": format!("/{name}"), "missing": true}),
    }
}

/// Shared open logic for `/api/s/{code}`, `/s/{code}` and the pickup-code claim.
pub async fn open_share(
    st: &AppState,
    p: &Principal,
    raw: &str,
    q: OpenQuery,
    action: &str,
) -> Response {
    let (code, link_pin) = split_code(raw);
    let pin = q.pin.clone().filter(|x| !x.is_empty()).or(link_pin);
    let ip = p.ip.clone();
    if st.share_guard.blocked(&ip, &code) {
        st.audit(
            p,
            CH_SHARE,
            action,
            "",
            false,
            &format!("rate limited code={code}"),
        );
        return deny(
            StatusCode::TOO_MANY_REQUESTS,
            json!({"error": "too many attempts, try again later"}),
        );
    }
    let s = match load_by_code(st, &code).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            st.share_guard.fail(&ip, "");
            st.audit(
                p,
                CH_SHARE,
                action,
                "",
                false,
                &format!("unknown code={code}"),
            );
            return deny(StatusCode::NOT_FOUND, json!({"error": "share not found"}));
        }
        Err(e) => return e.into_response(),
    };
    let first = s.items().first().cloned().unwrap_or_default();
    let ev = |allowed: bool, d: &str| {
        AuditEvent::new(p, CH_SHARE, action, &first, allowed, d).share(s.id)
    };
    if let Err(e) = s.check_open() {
        st.audit_ev(ev(false, &e.1));
        return deny(e.0, json!({"error": e.1, "status": s.status()}));
    }
    if s.require_login && p.user.is_none() {
        return deny(
            StatusCode::UNAUTHORIZED,
            json!({"error": "login required", "need_login": true, "name": s.name}),
        );
    }
    if let Some(want) = &s.pin {
        let Some(given) = pin else {
            return deny(
                StatusCode::UNAUTHORIZED,
                json!({"error": "pin required", "need_pin": true,
                "need_captcha": st.share_guard.need_captcha(&ip, &code), "name": s.name, "owner": s.owner_name}),
            );
        };
        if st.share_guard.need_captcha(&ip, &code)
            && !st
                .share_guard
                .check_captcha(q.captcha_id.as_deref(), q.captcha.as_deref())
        {
            st.audit_ev(ev(false, "captcha required/invalid"));
            return deny(
                StatusCode::UNAUTHORIZED,
                json!({"error": "captcha required", "need_pin": true, "need_captcha": true}),
            );
        }
        if !crate::auth::ct_eq(
            want.to_lowercase().as_bytes(),
            given.to_lowercase().as_bytes(),
        ) {
            st.share_guard.fail(&ip, &code);
            st.audit_ev(
                AuditEvent::new(p, CH_SHARE, "share_pin_fail", &first, false, "wrong pin")
                    .share(s.id),
            );
            return deny(
                StatusCode::UNAUTHORIZED,
                json!({"error": "wrong pin", "need_pin": true,
                "need_captcha": st.share_guard.need_captcha(&ip, &code)}),
            );
        }
        st.share_guard.success(&ip, &code);
    }
    let r = sqlx::query("UPDATE shares SET visits = visits + 1, last_access = ? WHERE id = ? AND (max_visits IS NULL OR visits < max_visits)")
        .bind(now())
        .bind(s.id)
        .execute(&st.db)
        .await;
    match r {
        Ok(r) if r.rows_affected() == 1 => {}
        Ok(_) => {
            st.audit_ev(ev(false, "visit limit reached"));
            return deny(
                StatusCode::GONE,
                json!({"error": "share visit limit reached", "status": "exhausted"}),
            );
        }
        Err(e) => return ApiError::from(e).into_response(),
    }
    st.audit_ev(ev(true, ""));
    let mut items = vec![];
    for i in s.items() {
        items.push(item_json(st, &s, &i).await);
    }
    let token = visitor_token(st, &s);
    let s = load_by_id(st, s.id).await.unwrap_or(s);
    Json(json!({
        "id": s.id, "code": s.code, "name": s.name, "owner": s.owner_name, "perm": s.perm,
        "expires_at": s.expires_at, "require_login": s.require_login,
        "visits_left": s.max_visits.map(|m| (m - s.visits).max(0)),
        "downloads_left": s.max_downloads.map(|m| (m - s.downloads).max(0)),
        "items": items, "token": token,
        "kind": s.kind, "allow_download": s.allow_download, "allow_upload": s.perm == "upload",
        "uploads_left": s.max_uploads.map(|m| (m - s.uploads).max(0)),
        "bytes_left": s.max_bytes.map(|m| (m - s.up_bytes).max(0)),
    }))
    .into_response()
}

/// Opens a share (`code` may carry the PIN: `abc-1234`). Counts one visit and returns a
/// visitor token for list / download / upload. 401 `{need_pin|need_captcha|need_login}`,
/// 410 expired / revoked / limit reached, 429 rate limited.
#[utoipa::path(operation_id = "share_open", get, path = "/api/s/{code}", params(("code" = String, Path), OpenQuery), responses((status = 200, description = "share contents + token")))]
pub async fn open(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(code): Path<String>,
    Query(q): Query<OpenQuery>,
) -> Response {
    open_share(&st, &p, &code, q, "share_visit").await
}

/// Pickup-code claim from the home page (anonymous ok).
#[utoipa::path(operation_id = "share_claim", post, path = "/api/s/claim", request_body = ClaimBody, responses((status = 200, description = "share contents + token")))]
pub async fn claim(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<ClaimBody>,
) -> Response {
    let q = OpenQuery {
        pin: b.pin,
        captcha_id: b.captcha_id,
        captcha: b.captcha,
    };
    open_share(&st, &p, &b.code, q, "share_claim").await
}

/// Short link `/s/<code>[-<pin>][?pin=]`: browsers (Accept: text/html) get the web app, other
/// clients get the same JSON as `/api/s/{code}`.
pub async fn short_link(
    st: AppState,
    p: Principal,
    headers: HeaderMap,
    code: String,
    q: OpenQuery,
    index: Option<std::path::PathBuf>,
) -> Response {
    let html = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("text/html"));
    if html {
        if let Some(idx) = index {
            if let Ok(b) = tokio::fs::read(&idx).await {
                return (
                    [
                        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                        (header::CACHE_CONTROL, "no-cache"),
                    ],
                    b,
                )
                    .into_response();
            }
        }
    }
    open_share(&st, &p, &code, q, "share_visit").await
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Captcha {
    pub id: String,
    /// SVG image of the question
    pub svg: String,
}

/// New captcha for PIN entry (required after a few wrong PINs).
#[utoipa::path(operation_id = "share_captcha", get, path = "/api/s/captcha", responses((status = 200, body = Captcha)))]
pub async fn captcha(State(st): State<AppState>) -> Json<Captcha> {
    let (id, q) = st.share_guard.new_captcha();
    Json(Captcha {
        id,
        svg: captcha_svg(&q),
    })
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct VisitQuery {
    /// Share-relative path, e.g. `/folder/sub/file.txt` ("/" = share root)
    pub path: Option<String>,
    /// Visitor token from `/api/s/{code}`
    pub t: Option<String>,
    /// In-browser preview (inline, not counted as a download)
    pub inline: Option<bool>,
}

async fn visitor(st: &AppState, p: &Principal, code: &str, t: Option<&str>) -> ApiResult<Share> {
    let (code, _) = split_code(code);
    let s = load_by_code(st, &code)
        .await?
        .ok_or_else(|| ApiError::not_found("share not found"))?;
    if s.kind == "room" && s.expires_at.is_some_and(|e| e <= now()) {
        sweep_rooms(st).await;
    }
    s.check_use()?;
    let ok = t
        .and_then(|t| read_token(st, t))
        .is_some_and(|v| v["k"] == "v" && v["s"].as_i64() == Some(s.id));
    if !ok {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "open the share first (token missing or expired)".into(),
        ));
    }
    if s.require_login && p.user.is_none() {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "login required".into()));
    }
    Ok(s)
}

/// Lists a folder inside a share.
#[utoipa::path(operation_id = "share_visit_list", get, path = "/api/s/{code}/list", params(("code" = String, Path), VisitQuery), responses((status = 200, description = "entries")))]
pub async fn visit_list(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(code): Path<String>,
    Query(q): Query<VisitQuery>,
) -> ApiResult<Json<Value>> {
    let s = visitor(&st, &p, &code, q.t.as_deref()).await?;
    let rel = drivehub_storage::norm(q.path.as_deref().unwrap_or("/"))?;
    let items: Vec<Value> = match s.resolve(&rel)? {
        None => {
            let mut v = vec![];
            for i in s.items() {
                v.push(item_json(&st, &s, &i).await);
            }
            v
        }
        Some(real) => {
            let (mount, mrel) = st.vfs.resolve_in(&real, false)?;
            let entries = st.vfs.list(&mount, &mrel, false).await?;
            st.audit_ev(AuditEvent::new(&p, CH_SHARE, "share_list", &real, true, "").share(s.id));
            entries
                .iter()
                .map(|e| json!({"name": e.name, "path": format!("/{rel}/{}", e.name), "is_dir": e.is_dir, "size": e.size, "modified_unix": e.modified_unix}))
                .collect()
        }
    };
    Ok(Json(
        json!({"path": format!("/{rel}"), "perm": s.perm, "items": items}),
    ))
}

async fn count_download(st: &AppState, s: &Share, bytes: i64) -> ApiResult<()> {
    let r = sqlx::query("UPDATE shares SET downloads = downloads + 1, bytes = bytes + ?, last_access = ? WHERE id = ? AND (max_downloads IS NULL OR downloads < max_downloads)")
        .bind(bytes)
        .bind(now())
        .bind(s.id)
        .execute(&st.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError(
            StatusCode::GONE,
            "share download limit reached".into(),
        ));
    }
    Ok(())
}

async fn serve_shared(
    st: &AppState,
    p: &Principal,
    s: &Share,
    real: &str,
    headers: &HeaderMap,
    inline: bool,
    action: &str,
) -> ApiResult<Response> {
    let (mount, rel) = st.vfs.resolve_in(real, false)?;
    let e = mount.driver.stat(&rel).await?;
    if e.is_dir {
        return Err(ApiError::bad("is a directory"));
    }
    let counted = counts_as_download(headers);
    if !inline && counted {
        count_download(st, s, e.size as i64).await?;
    }
    let r = serve_entry(&mount, &rel, &e, headers, !inline).await?;
    if counted {
        st.audit_ev(
            AuditEvent::new(
                p,
                CH_SHARE,
                if inline { "share_preview" } else { action },
                real,
                true,
                "",
            )
            .bytes(e.size as i64)
            .share(s.id),
        );
    }
    Ok(r)
}

/// Downloads (or with `inline=true` previews) a file of a share. Supports Range; only the
/// first request of a ranged transfer counts toward `max_downloads`.
#[utoipa::path(operation_id = "share_visit_download", get, path = "/api/s/{code}/download", params(("code" = String, Path), VisitQuery), responses((status = 200, description = "file"), (status = 206, description = "partial")))]
pub async fn visit_download(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(code): Path<String>,
    headers: HeaderMap,
    Query(q): Query<VisitQuery>,
) -> ApiResult<Response> {
    let s = visitor(&st, &p, &code, q.t.as_deref()).await?;
    let inline = q.inline.unwrap_or(false);
    if !s.allow_download {
        return Err(ApiError::forbidden("downloads are disabled for this room"));
    }
    if !inline && perm_level(&s.perm) < 2 {
        st.audit_ev(
            AuditEvent::new(
                &p,
                CH_SHARE,
                "share_download",
                "",
                false,
                "preview-only share",
            )
            .share(s.id),
        );
        return Err(ApiError::forbidden("this share is preview only"));
    }
    let real = s
        .resolve(q.path.as_deref().unwrap_or(""))?
        .ok_or_else(|| ApiError::bad("path required"))?;
    serve_shared(&st, &p, &s, &real, &headers, inline, "share_download").await
}

/// Signed direct link for one file of a share: `{"url": "/d/<token>/<name>"}`.
#[utoipa::path(operation_id = "share_visit_direct", get, path = "/api/s/{code}/direct", params(("code" = String, Path), VisitQuery), responses((status = 200, description = "url")))]
pub async fn visit_direct(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(code): Path<String>,
    Query(q): Query<VisitQuery>,
) -> ApiResult<Json<Value>> {
    let s = visitor(&st, &p, &code, q.t.as_deref()).await?;
    if perm_level(&s.perm) < 2 || !s.allow_download {
        return Err(ApiError::forbidden("this share is preview only"));
    }
    let rel = drivehub_storage::norm(q.path.as_deref().unwrap_or(""))?;
    let real = s
        .resolve(&rel)?
        .ok_or_else(|| ApiError::bad("path required"))?;
    let (mount, mrel) = st.vfs.resolve_in(&real, false)?;
    if mount.driver.stat(&mrel).await?.is_dir {
        return Err(ApiError::bad("is a directory"));
    }
    let path = direct_path(&st, &s, &rel);
    Ok(Json(
        json!({"url": format!("{}{path}", base_url(&st)), "path": path}),
    ))
}

/// Uploads a file into an upload (collect) share. Never overwrites.
#[utoipa::path(operation_id = "share_visit_upload", put, path = "/api/s/{code}/upload", params(("code" = String, Path), VisitQuery), request_body(content = Vec<u8>, content_type = "application/octet-stream"), responses((status = 200, description = "uploaded")))]
pub async fn visit_upload(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(code): Path<String>,
    Query(q): Query<VisitQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<Value>> {
    let s = visitor(&st, &p, &code, q.t.as_deref()).await?;
    if s.perm != "upload" {
        st.audit_ev(
            AuditEvent::new(
                &p,
                CH_SHARE,
                "share_upload",
                "",
                false,
                "not an upload share",
            )
            .share(s.id),
        );
        return Err(ApiError::forbidden("this share does not accept uploads"));
    }
    let mut rel = drivehub_storage::norm(q.path.as_deref().unwrap_or(""))?;
    let items = s.items();
    // "file.txt" at the share root goes into the (single) shared folder
    if !rel.contains('/') {
        rel = format!("{}/{rel}", basename(&items[0]));
    }
    let real = s
        .resolve(&rel)?
        .ok_or_else(|| ApiError::bad("path required"))?;
    let (mount, mrel) = st.vfs.resolve_in(&real, true)?;
    if mount.driver.stat(&mrel).await.is_ok() {
        return Err(ApiError(StatusCode::CONFLICT, "file exists".into()));
    }
    let declared: Option<i64> = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    check_room_caps(&s, declared.unwrap_or(0))?;
    let stream = body.into_data_stream().map_err(std::io::Error::other);
    let n = mount
        .driver
        .write_stream(&mrel, Box::pin(stream), &|_| {})
        .await?;
    // Atomically reserve the slot; roll the file back when a cap was exceeded meanwhile.
    let ok = sqlx::query(
        "UPDATE shares SET up_bytes = up_bytes + ?1 WHERE id = ?2 \
         AND (max_uploads IS NULL OR uploads < max_uploads) \
         AND (max_bytes IS NULL OR up_bytes + ?1 <= max_bytes)",
    )
    .bind(n as i64)
    .bind(s.id)
    .execute(&st.db)
    .await?
    .rows_affected()
        == 1;
    if !ok {
        let _ = mount.driver.delete(&mrel).await;
        st.vfs.invalidate(&mount.cfg.name);
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "room upload limit reached".into()));
    }
    st.vfs.invalidate(&mount.cfg.name);
    if let Ok(e) = mount.driver.stat(&mrel).await {
        st.index_upsert(&mount.cfg.name, &e).await;
    }
    let _ = sqlx::query(
        "UPDATE shares SET uploads = uploads + 1, bytes = bytes + ?, last_access = ? WHERE id = ?",
    )
    .bind(n as i64)
    .bind(now())
    .bind(s.id)
    .execute(&st.db)
    .await;
    st.audit_ev(
        AuditEvent::new(&p, CH_SHARE, "share_upload", &real, true, "")
            .bytes(n as i64)
            .share(s.id),
    );
    Ok(Json(
        json!({"ok": true, "path": format!("/{rel}"), "size": n}),
    ))
}

/// Direct link `/d/<token>/<name>`: HMAC-signed (anti-hotlinking: token bound to share, path
/// and expiry), Range supported, counts toward `max_downloads`.
pub async fn direct(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((tok, name)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let Some(v) = read_token(&st, &tok).filter(|v| v["k"] == "d") else {
        st.audit(
            &p,
            CH_SHARE,
            "share_direct",
            "",
            false,
            "bad or expired signature",
        );
        return Err(ApiError::forbidden("invalid or expired link"));
    };
    let s = load_by_id(&st, v["s"].as_i64().unwrap_or(0)).await?;
    if let Err(e) = s.check_use() {
        st.audit_ev(AuditEvent::new(&p, CH_SHARE, "share_direct", "", false, &e.1).share(s.id));
        return Err(e);
    }
    if perm_level(&s.perm) < 2 {
        return Err(ApiError::forbidden("this share is preview only"));
    }
    let rel = v["p"].as_str().unwrap_or("").to_string();
    if basename(&rel) != name {
        return Err(ApiError::forbidden("invalid link"));
    }
    let real = s.resolve(&rel)?.ok_or_else(|| ApiError::bad("bad link"))?;
    serve_shared(&st, &p, &s, &real, &headers, false, "share_direct").await
}

// ---------------------------------------------------------------- drop rooms (DEPTAI-464r)

/// Rejects an upload of `add` bytes that would exceed the room's file-count / size caps.
pub fn check_room_caps(s: &Share, add: i64) -> ApiResult<()> {
    if s.max_uploads.is_some_and(|m| s.uploads >= m) {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "room file limit reached".into()));
    }
    if s.max_bytes.is_some_and(|m| s.up_bytes + add > m) {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "room size limit reached".into()));
    }
    Ok(())
}

async fn remove_room_folder(st: &AppState, s: &Share) {
    for real in s.items() {
        if !real.contains("/.droprooms/") && !real.starts_with(".droprooms/") {
            continue; // safety: only ever delete dedicated room folders
        }
        if let Ok((mount, rel)) = st.vfs.resolve_in(&real, true) {
            let _ = mount.driver.delete(&rel).await;
            st.vfs.invalidate(&mount.cfg.name);
        }
    }
}

/// Deletes expired drop rooms (row + backing folder). Returns the number removed.
pub async fn sweep_rooms(st: &AppState) -> usize {
    let rows: Vec<Share> = sqlx::query_as(
        "SELECT * FROM shares WHERE kind = 'room' AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .bind(now())
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    for s in &rows {
        remove_room_folder(st, s).await;
        let _ = sqlx::query("DELETE FROM shares WHERE id = ?").bind(s.id).execute(&st.db).await;
        tracing::info!(code = %s.code, "expired drop room removed");
    }
    rows.len()
}
