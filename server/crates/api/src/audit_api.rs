//! Audit admin API (DEPTAI-475): multi-filter query / timeline, CSV + JSON export, hash-chain
//! verification, retention policy + purge, alert rules / events, dashboard.
#![allow(clippy::type_complexity)]
use crate::audit::{self, AlertRule, AuditRow, COLS};
use crate::auth::{now, Principal, CH_ADMIN};
use crate::error::{ApiError, ApiResult};
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{QueryBuilder, Sqlite};
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Deserialize, IntoParams, Default)]
pub struct AuditFilter {
    pub limit: Option<i64>,
    /// only denied events
    pub denied: Option<bool>,
    /// only allowed (true) / denied (false) events
    pub allowed: Option<bool>,
    /// api | webdav | auth | share | admin
    pub channel: Option<String>,
    /// web | android | webdav | api
    pub client: Option<String>,
    /// exact action, or comma list
    pub action: Option<String>,
    /// username (exact)
    pub user: Option<String>,
    pub user_id: Option<i64>,
    /// path prefix, e.g. `/local/team`
    pub path: Option<String>,
    pub storage: Option<String>,
    pub ip: Option<String>,
    pub share_id: Option<i64>,
    /// unix seconds (inclusive)
    pub from: Option<i64>,
    /// unix seconds (exclusive)
    pub to: Option<i64>,
    /// free text in path / detail / username / ua
    pub q: Option<String>,
    /// pagination: events with id < before_id
    pub before_id: Option<i64>,
    /// asc | desc (default desc)
    pub order: Option<String>,
    /// export only: csv (default) | json
    pub format: Option<String>,
}

fn build<'a>(f: &'a AuditFilter, max: i64) -> QueryBuilder<'a, Sqlite> {
    let mut b: QueryBuilder<Sqlite> =
        QueryBuilder::new(format!("SELECT {COLS} FROM audit_log WHERE 1=1"));
    if f.denied == Some(true) {
        b.push(" AND allowed = 0");
    }
    if let Some(a) = f.allowed {
        b.push(" AND allowed = ").push_bind(a as i64);
    }
    for (col, v) in [
        ("channel", &f.channel),
        ("client", &f.client),
        ("username", &f.user),
        ("storage", &f.storage),
        ("ip", &f.ip),
    ] {
        if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
            b.push(format!(" AND {col} = ")).push_bind(v.clone());
        }
    }
    if let Some(a) = f.action.as_ref().filter(|v| !v.is_empty()) {
        b.push(" AND instr(',' || ")
            .push_bind(a.replace(' ', ""))
            .push(" || ',', ',' || action || ',') > 0");
    }
    if let Some(u) = f.user_id {
        b.push(" AND user_id = ").push_bind(u);
    }
    if let Some(s) = f.share_id {
        b.push(" AND share_id = ").push_bind(s);
    }
    if let Some(p) = f.path.as_ref().filter(|v| !v.is_empty()) {
        let p = format!("/{}", p.trim_matches('/'));
        b.push(" AND (path = ")
            .push_bind(p.clone())
            .push(" OR substr(path, 1, ")
            .push_bind(p.len() as i64 + 1)
            .push(") = ")
            .push_bind(format!("{}/", p.trim_end_matches('/')))
            .push(")");
    }
    if let Some(t) = f.from {
        b.push(" AND ts >= ").push_bind(t);
    }
    if let Some(t) = f.to {
        b.push(" AND ts < ").push_bind(t);
    }
    if let Some(q) = f.q.as_ref().filter(|v| !v.is_empty()) {
        let like = format!("%{q}%");
        b.push(" AND (path LIKE ")
            .push_bind(like.clone())
            .push(" OR detail LIKE ")
            .push_bind(like.clone())
            .push(" OR username LIKE ")
            .push_bind(like.clone())
            .push(" OR ua LIKE ")
            .push_bind(like)
            .push(")");
    }
    if let Some(id) = f.before_id {
        b.push(" AND id < ").push_bind(id);
    }
    let asc = f.order.as_deref() == Some("asc");
    b.push(if asc {
        " ORDER BY id ASC"
    } else {
        " ORDER BY id DESC"
    });
    b.push(" LIMIT ")
        .push_bind(f.limit.unwrap_or(100).clamp(1, max));
    b
}

pub async fn query(st: &AppState, f: &AuditFilter, max: i64) -> ApiResult<Vec<AuditRow>> {
    st.audit_log.flush().await;
    Ok(build(f, max).build_query_as().fetch_all(&st.db).await?)
}

/// Audit log with filters (time range, user, action, channel, client, path prefix, ip,
/// share, result, text), newest first (admin).
#[utoipa::path(operation_id = "audit_list", get, path = "/api/admin/audit", params(AuditFilter), responses((status = 200, description = "events")))]
pub async fn list(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(f): Query<AuditFilter>,
) -> ApiResult<Json<Vec<Value>>> {
    p.require_admin()?;
    Ok(Json(
        query(&st, &f, 1000)
            .await?
            .iter()
            .map(AuditRow::json)
            .collect(),
    ))
}

fn csv_cell(s: &str) -> String {
    let s = if s.starts_with(['=', '+', '-', '@']) {
        format!("'{s}") // spreadsheet formula injection
    } else {
        s.to_string()
    };
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

/// Exports filtered events (up to 100 000, oldest first) as CSV or JSON (admin).
#[utoipa::path(operation_id = "audit_export", get, path = "/api/admin/audit/export", params(AuditFilter), responses((status = 200, description = "file")))]
pub async fn export(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(mut f): Query<AuditFilter>,
) -> ApiResult<Response> {
    p.require_admin()?;
    f.limit = Some(f.limit.unwrap_or(100_000));
    f.order = Some(f.order.clone().unwrap_or_else(|| "asc".into()));
    let q = AuditFilter {
        format: f.format.clone(),
        ..Default::default()
    };
    let rows = query(&st, &f, 100_000).await?;
    st.audit(
        &p,
        CH_ADMIN,
        "audit_export",
        "",
        true,
        &format!("rows={}", rows.len()),
    );
    let stamp = audit::iso(now()).replace([':', '-'], "");
    if q.format.as_deref() == Some("json") {
        let body = serde_json::to_vec_pretty(&rows.iter().map(AuditRow::json).collect::<Vec<_>>())
            .unwrap();
        return Ok((
            [
                (header::CONTENT_TYPE, "application/json".to_string()),
                (
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"audit-{stamp}.json\""),
                ),
            ],
            body,
        )
            .into_response());
    }
    let mut out = String::from("\u{feff}id,time,ts,user_id,username,ip,client,channel,action,path,storage,result,bytes,share_id,detail,ua,hash\n");
    for r in &rows {
        let cells = [
            r.id.to_string(),
            audit::iso(r.ts),
            r.ts.to_string(),
            r.user_id.map(|v| v.to_string()).unwrap_or_default(),
            r.username.clone(),
            r.ip.clone(),
            r.client.clone(),
            r.channel.clone(),
            r.action.clone(),
            r.path.clone(),
            r.storage.clone(),
            if r.allowed { "ok" } else { "denied" }.into(),
            r.bytes.to_string(),
            r.share_id.map(|v| v.to_string()).unwrap_or_default(),
            r.detail.clone(),
            r.ua.clone(),
            r.hash.clone(),
        ];
        out.push_str(
            &cells
                .iter()
                .map(|c| csv_cell(c))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push('\n');
    }
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"audit-{stamp}.csv\""),
            ),
        ],
        out,
    )
        .into_response())
}

/// Recomputes the hash chain: `{ok, checked, first_bad_id, reason}` (admin).
#[utoipa::path(operation_id = "audit_verify", get, path = "/api/admin/audit/verify", responses((status = 200, description = "report")))]
pub async fn verify(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    st.audit_log.flush().await;
    let r = audit::verify(&st.db).await?;
    if !r.ok {
        tracing::error!(?r, "audit chain verification FAILED");
    }
    Ok(Json(serde_json::to_value(r).unwrap()))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PolicyBody {
    /// Keep events this many days (0 = forever).
    pub retention_days: i64,
}

/// Retention policy (admin).
#[utoipa::path(operation_id = "audit_get_policy", get, path = "/api/admin/audit/policy", responses((status = 200, description = "policy")))]
pub async fn get_policy(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let anchor: Option<String> = crate::settings::get_meta(&st.db, "audit.anchor_id").await?;
    Ok(Json(
        json!({"retention_days": audit::retention_days(&st.db).await, "anchor_id": anchor.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0)}),
    ))
}

/// Sets the retention policy (admin).
#[utoipa::path(operation_id = "audit_put_policy", put, path = "/api/admin/audit/policy", request_body = PolicyBody, responses((status = 200, description = "policy")))]
pub async fn put_policy(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<PolicyBody>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    if b.retention_days < 0 {
        return Err(ApiError::bad("retention_days must be >= 0"));
    }
    crate::settings::set_meta(
        &st.db,
        "setting.audit_retention_days",
        &b.retention_days.to_string(),
    )
    .await?;
    st.audit(
        &p,
        CH_ADMIN,
        "audit_policy",
        "",
        true,
        &format!("retention_days={}", b.retention_days),
    );
    get_policy(State(st), Extension(p)).await
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct PurgeQuery {
    /// Override the policy (days).
    pub days: Option<i64>,
}

/// Applies retention now: deletes old events and moves the chain anchor (admin).
#[utoipa::path(operation_id = "audit_purge", post, path = "/api/admin/audit/purge", params(PurgeQuery), responses((status = 200, description = "result")))]
pub async fn purge(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<PurgeQuery>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    st.audit_log.flush().await;
    let days = match q.days {
        Some(d) => d,
        None => audit::retention_days(&st.db).await,
    };
    let (n, anchor) = audit::purge(&st.db, days).await?;
    st.audit(
        &p,
        CH_ADMIN,
        "audit_purge",
        "",
        true,
        &format!("days={days} deleted={n} anchor={anchor}"),
    );
    Ok(Json(
        json!({"deleted": n, "anchor_id": anchor, "days": days}),
    ))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct DashQuery {
    /// default 7
    pub days: Option<i64>,
}

/// Dashboard: traffic per day, hot files, share ranking, anomalies (admin).
#[utoipa::path(operation_id = "audit_dashboard", get, path = "/api/admin/audit/dashboard", params(DashQuery), responses((status = 200, description = "dashboard")))]
pub async fn dashboard(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<DashQuery>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    st.audit_log.flush().await;
    let days = q.days.unwrap_or(7).clamp(1, 366);
    let since = now() - days * 86400;
    let traffic: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT date(ts, 'unixepoch') d,
                SUM(CASE WHEN action IN ('download','share_download','share_direct','preview','share_preview') THEN bytes ELSE 0 END),
                SUM(CASE WHEN action IN ('upload','share_upload') THEN bytes ELSE 0 END),
                COUNT(*)
         FROM audit_log WHERE ts >= ? GROUP BY d ORDER BY d",
    )
    .bind(since)
    .fetch_all(&st.db)
    .await?;
    let hot: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT path, COUNT(*), SUM(bytes) FROM audit_log WHERE ts >= ? AND allowed = 1
         AND action IN ('download','share_download','share_direct','preview','share_preview')
         GROUP BY path ORDER BY 2 DESC LIMIT 10",
    )
    .bind(since)
    .fetch_all(&st.db)
    .await?;
    let shares: Vec<(i64, String, String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT id, code, name, owner_name, visits, downloads, bytes FROM shares ORDER BY visits + downloads DESC, id DESC LIMIT 10",
    )
    .fetch_all(&st.db)
    .await?;
    let (denied, failed_logins, events): (i64, i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(allowed = 0), 0), COALESCE(SUM(allowed = 0 AND action IN ('login','basic_login')), 0), COUNT(*) FROM audit_log WHERE ts >= ?",
    )
    .bind(since)
    .fetch_one(&st.db)
    .await?;
    let alerts: Vec<(i64, i64, String, String, String, String)> = sqlx::query_as(
        "SELECT id, ts, rule_name, username, ip, message FROM alert_events ORDER BY id DESC LIMIT 20",
    )
    .fetch_all(&st.db)
    .await?;
    let recent_denied: Vec<AuditRow> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM audit_log WHERE allowed = 0 AND ts >= ? ORDER BY id DESC LIMIT 20"
    ))
    .bind(since)
    .fetch_all(&st.db)
    .await?;
    let active_users: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT user_id) FROM audit_log WHERE ts >= ? AND user_id IS NOT NULL",
    )
    .bind(since)
    .fetch_one(&st.db)
    .await?;
    Ok(Json(json!({
        "days": days,
        "totals": {"events": events, "denied": denied, "failed_logins": failed_logins, "active_users": active_users,
                   "download_bytes": traffic.iter().map(|t| t.1).sum::<i64>(), "upload_bytes": traffic.iter().map(|t| t.2).sum::<i64>()},
        "traffic": traffic.iter().map(|(d, dl, ul, n)| json!({"day": d, "download_bytes": dl, "upload_bytes": ul, "events": n})).collect::<Vec<_>>(),
        "hot_files": hot.iter().map(|(p, n, b)| json!({"path": p, "count": n, "bytes": b})).collect::<Vec<_>>(),
        "top_shares": shares.iter().map(|(id, c, n, o, v, d, b)| json!({"id": id, "code": c, "name": n, "owner": o, "visits": v, "downloads": d, "bytes": b})).collect::<Vec<_>>(),
        "alerts": alerts.iter().map(|(id, ts, r, u, ip, m)| json!({"id": id, "ts": ts, "time": audit::iso(*ts), "rule": r, "user": u, "ip": ip, "message": m})).collect::<Vec<_>>(),
        "recent_denied": recent_denied.iter().map(AuditRow::json).collect::<Vec<_>>(),
    })))
}

// ---------------------------------------------------------------- alert rules

#[derive(Debug, Deserialize, ToSchema)]
pub struct AlertBody {
    pub name: String,
    /// burst | new_ip_login
    pub kind: String,
    /// burst: comma list of actions, e.g. "download,share_download" or "delete"
    #[serde(default)]
    pub actions: String,
    #[serde(default)]
    pub threshold: i64,
    pub window_secs: Option<i64>,
    /// log | webhook | email
    pub sink: Option<String>,
    /// webhook URL or e-mail address
    #[serde(default)]
    pub target: String,
    pub enabled: Option<bool>,
}

fn validate(b: &AlertBody) -> ApiResult<()> {
    if !["burst", "new_ip_login"].contains(&b.kind.as_str()) {
        return Err(ApiError::bad("kind must be burst | new_ip_login"));
    }
    if b.kind == "burst" && (b.threshold <= 0 || b.actions.trim().is_empty()) {
        return Err(ApiError::bad("burst needs actions and threshold > 0"));
    }
    let sink = b.sink.as_deref().unwrap_or("log");
    match sink {
        "log" => {}
        "webhook" if b.target.starts_with("http://") || b.target.starts_with("https://") => {}
        "email" if b.target.contains('@') => {}
        _ => {
            return Err(ApiError::bad(
                "sink must be log | webhook (http(s) URL) | email (address)",
            ))
        }
    }
    Ok(())
}

/// Alert rules (admin).
#[utoipa::path(operation_id = "list_alerts", get, path = "/api/admin/alerts", responses((status = 200, description = "rules")))]
pub async fn list_alerts(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<AlertRule>>> {
    p.require_admin()?;
    Ok(Json(
        sqlx::query_as("SELECT * FROM alert_rules ORDER BY id")
            .fetch_all(&st.db)
            .await?,
    ))
}

/// Adds an alert rule (admin).
#[utoipa::path(operation_id = "add_alert", post, path = "/api/admin/alerts", request_body = AlertBody, responses((status = 200, description = "rule")))]
pub async fn add_alert(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<AlertBody>,
) -> ApiResult<Json<AlertRule>> {
    p.require_admin()?;
    validate(&b)?;
    let r = sqlx::query("INSERT INTO alert_rules (name, kind, actions, threshold, window_secs, sink, target, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(b.name.trim())
        .bind(&b.kind)
        .bind(b.actions.replace(' ', ""))
        .bind(b.threshold)
        .bind(b.window_secs.unwrap_or(60).max(1))
        .bind(b.sink.as_deref().unwrap_or("log"))
        .bind(&b.target)
        .bind(b.enabled.unwrap_or(true))
        .bind(now())
        .execute(&st.db)
        .await?;
    st.audit_log.alerts.reload(&st.db).await?;
    st.audit(&p, CH_ADMIN, "alert_rule_create", "", true, &b.name);
    let id = r.last_insert_rowid();
    Ok(Json(
        sqlx::query_as("SELECT * FROM alert_rules WHERE id = ?")
            .bind(id)
            .fetch_one(&st.db)
            .await?,
    ))
}

/// Replaces an alert rule (admin).
#[utoipa::path(operation_id = "put_alert", put, path = "/api/admin/alerts/{id}", params(("id" = i64, Path)), request_body = AlertBody, responses((status = 200, description = "rule")))]
pub async fn put_alert(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
    Json(b): Json<AlertBody>,
) -> ApiResult<Json<AlertRule>> {
    p.require_admin()?;
    validate(&b)?;
    sqlx::query("UPDATE alert_rules SET name=?, kind=?, actions=?, threshold=?, window_secs=?, sink=?, target=?, enabled=? WHERE id=?")
        .bind(b.name.trim())
        .bind(&b.kind)
        .bind(b.actions.replace(' ', ""))
        .bind(b.threshold)
        .bind(b.window_secs.unwrap_or(60).max(1))
        .bind(b.sink.as_deref().unwrap_or("log"))
        .bind(&b.target)
        .bind(b.enabled.unwrap_or(true))
        .bind(id)
        .execute(&st.db)
        .await?;
    st.audit_log.alerts.reload(&st.db).await?;
    st.audit(&p, CH_ADMIN, "alert_rule_update", "", true, &b.name);
    sqlx::query_as("SELECT * FROM alert_rules WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such rule"))
}

/// Deletes an alert rule (admin).
#[utoipa::path(operation_id = "delete_alert", delete, path = "/api/admin/alerts/{id}", params(("id" = i64, Path)), responses((status = 200, description = "deleted")))]
pub async fn delete_alert(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    sqlx::query("DELETE FROM alert_rules WHERE id = ?")
        .bind(id)
        .execute(&st.db)
        .await?;
    st.audit_log.alerts.reload(&st.db).await?;
    st.audit(
        &p,
        CH_ADMIN,
        "alert_rule_delete",
        "",
        true,
        &format!("id={id}"),
    );
    Ok(Json(json!({"ok": true})))
}

/// Sends a test alert through the rule's sink (admin).
#[utoipa::path(operation_id = "test_alert", post, path = "/api/admin/alerts/{id}/test", params(("id" = i64, Path)), responses((status = 200, description = "alert event id")))]
pub async fn test_alert(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let r: AlertRule = sqlx::query_as("SELECT * FROM alert_rules WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such rule"))?;
    let ev = st
        .audit_log
        .alerts
        .fire(&st.db, &st.auth, &r, &p.name(), &p.ip, "test alert", None)
        .await;
    Ok(Json(json!({"event_id": ev})))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct AlertEventsQuery {
    pub limit: Option<i64>,
    pub rule_id: Option<i64>,
}

/// Fired alerts, newest first (admin).
#[utoipa::path(operation_id = "alert_events", get, path = "/api/admin/alerts/events", params(AlertEventsQuery), responses((status = 200, description = "events")))]
pub async fn alert_events(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<AlertEventsQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    p.require_admin()?;
    st.audit_log.flush().await;
    let rows: Vec<(i64, i64, i64, String, String, String, String, String, bool, String)> = sqlx::query_as(
        "SELECT id, ts, rule_id, rule_name, username, ip, message, sink, delivered, error FROM alert_events
         WHERE (? IS NULL OR rule_id = ?) ORDER BY id DESC LIMIT ?",
    )
    .bind(q.rule_id)
    .bind(q.rule_id)
    .bind(q.limit.unwrap_or(100).clamp(1, 1000))
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, ts, rid, rn, u, ip, m, s, d, e)| json!({"id": id, "ts": ts, "time": audit::iso(ts), "rule_id": rid, "rule": rn, "user": u, "ip": ip, "message": m, "sink": s, "delivered": d, "error": e}))
            .collect(),
    ))
}
