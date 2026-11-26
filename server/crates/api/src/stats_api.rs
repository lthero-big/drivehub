//! Access statistics (DEPTAI-485 r4 #3): one aggregated, filterable view over every share
//! visit / download / upload and (admin) every file download / preview, built on audit_log.
#![allow(clippy::type_complexity)]
use crate::auth::Principal;
use crate::error::ApiResult;
use crate::{geoip, AppState};
use axum::{
    extract::{Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{QueryBuilder, Sqlite};
use std::collections::HashMap;
use utoipa::IntoParams;

/// Share-visitor actions.
pub const SHARE_ACTIONS: &[&str] = &[
    "share_visit",
    "share_claim",
    "share_list",
    "share_preview",
    "share_download",
    "share_direct",
    "share_upload",
    "share_pin_fail",
];
/// Direct file access actions (Web API / WebDAV).
pub const FILE_ACTIONS: &[&str] = &["download", "preview"];
const VISIT: &[&str] = &["share_visit", "share_claim"];
const DOWNLOAD: &[&str] = &["share_download", "share_direct", "download"];
const UPLOAD: &[&str] = &["share_upload"];
const PREVIEW: &[&str] = &["share_preview", "preview"];

#[derive(Debug, Deserialize, IntoParams, Default)]
pub struct StatsQuery {
    /// shares (default) | files | all — `files` / `all` are admin-only (others get `shares`)
    pub scope: Option<String>,
    pub share_id: Option<i64>,
    /// path prefix, e.g. `/local/docs` (or an exact file)
    pub path: Option<String>,
    /// visit | download | upload | preview | denied, or exact action names (comma list)
    pub kind: Option<String>,
    pub ip: Option<String>,
    /// unix seconds, inclusive
    pub from: Option<i64>,
    /// unix seconds, exclusive
    pub to: Option<i64>,
    /// free text in path / username / ua
    pub q: Option<String>,
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    /// Admin: include every user's shares (default true for admin).
    pub all: Option<bool>,
    /// Visitor region filter (r6 #4): ISO country code ("CN", "US"…) or "LAN" for private networks
    pub country: Option<String>,
    /// Visitor province / state within `country`, e.g. "广东省"
    pub region: Option<String>,
    /// `/api/stats/ips` ordering: count (default) | last | bytes
    pub sort: Option<String>,
    /// Resolved IP allow-list for the region filter (internal).
    #[serde(skip)]
    #[param(ignore)]
    pub ip_in: Option<Vec<String>>,
}

fn in_list(b: &mut QueryBuilder<Sqlite>, col: &str, vals: &[&str]) {
    b.push(format!(" AND {col} IN ("));
    let mut s = b.separated(", ");
    for v in vals {
        s.push_bind(v.to_string());
    }
    b.push(")");
}

fn push_where(b: &mut QueryBuilder<Sqlite>, f: &StatsQuery, scope: &str, owner: Option<i64>) {
    b.push(" FROM audit_log WHERE 1=1");
    match scope {
        "files" => in_list(b, "action", FILE_ACTIONS),
        "all" => {
            let all: Vec<&str> = SHARE_ACTIONS.iter().chain(FILE_ACTIONS).copied().collect();
            in_list(b, "action", &all);
        }
        _ => {
            in_list(b, "action", SHARE_ACTIONS);
            b.push(" AND share_id IS NOT NULL");
        }
    }
    if let Some(o) = owner {
        b.push(" AND share_id IN (SELECT id FROM shares WHERE owner_id = ")
            .push_bind(o)
            .push(")");
    }
    if let Some(s) = f.share_id {
        b.push(" AND share_id = ").push_bind(s);
    }
    if let Some(ip) = f.ip.as_ref().filter(|v| !v.trim().is_empty()) {
        b.push(" AND ip = ").push_bind(ip.trim().to_string());
    }
    if let Some(ips) = &f.ip_in {
        if ips.is_empty() {
            b.push(" AND 0");
        } else {
            b.push(" AND ip IN (");
            let mut s = b.separated(", ");
            for ip in ips {
                s.push_bind(ip.clone());
            }
            b.push(")");
        }
    }
    if let Some(p) = f.path.as_ref().filter(|v| !v.trim_matches('/').is_empty()) {
        let p = format!("/{}", p.trim().trim_matches('/'));
        b.push(" AND (path = ")
            .push_bind(p.clone())
            .push(" OR substr(path, 1, ")
            .push_bind(p.chars().count() as i64 + 1)
            .push(") = ")
            .push_bind(format!("{p}/"))
            .push(")");
    }
    if let Some(k) = f.kind.as_ref().filter(|v| !v.is_empty()) {
        let mut acts: Vec<&str> = vec![];
        let mut denied = false;
        for part in k.split(',').map(str::trim) {
            match part {
                "visit" => acts.extend(VISIT),
                "download" => acts.extend(DOWNLOAD),
                "upload" => acts.extend(UPLOAD),
                "preview" => acts.extend(PREVIEW),
                "denied" => denied = true,
                "" => {}
                other => {
                    if let Some(a) = SHARE_ACTIONS
                        .iter()
                        .chain(FILE_ACTIONS)
                        .find(|a| **a == other)
                    {
                        acts.push(a)
                    }
                }
            }
        }
        if !acts.is_empty() {
            in_list(b, "action", &acts);
        }
        if denied {
            b.push(" AND allowed = 0");
        }
    }
    if let Some(t) = f.from {
        b.push(" AND ts >= ").push_bind(t);
    }
    if let Some(t) = f.to {
        b.push(" AND ts < ").push_bind(t);
    }
    if let Some(q) = f.q.as_ref().filter(|v| !v.trim().is_empty()) {
        let like = format!("%{}%", q.trim());
        b.push(" AND (path LIKE ")
            .push_bind(like.clone())
            .push(" OR username LIKE ")
            .push_bind(like.clone())
            .push(" OR ua LIKE ")
            .push_bind(like)
            .push(")");
    }
}

fn count_of(by: &[(String, i64)], set: &[&str]) -> i64 {
    by.iter()
        .filter(|(a, _)| set.contains(&a.as_str()))
        .map(|(_, n)| n)
        .sum()
}

/// Aggregated access statistics over shares (and, for admins, direct file access):
/// totals, per-action / per-day breakdown, top shares / files / IPs and a paged event list.
#[utoipa::path(operation_id = "access_stats", get, path = "/api/stats/access", params(StatsQuery), responses((status = 200, description = "summary + rows")))]
pub async fn access(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(mut f): Query<StatsQuery>,
) -> ApiResult<Json<Value>> {
    let (scope, owner) = prelude(&st, &p, &mut f).await?;
    let per = f.per_page.unwrap_or(50).clamp(1, 500);
    let page = f.page.unwrap_or(1).max(1);

    let q = |sel: &str, tail: &str| {
        let mut b: QueryBuilder<Sqlite> = QueryBuilder::new(sel);
        push_where(&mut b, &f, scope, owner);
        b.push(tail);
        b
    };
    let total: i64 = q("SELECT COUNT(*)", "")
        .build_query_scalar()
        .fetch_one(&st.db)
        .await?;
    let by_action: Vec<(String, i64)> = q(
        "SELECT action, COUNT(*)",
        " GROUP BY action ORDER BY 2 DESC",
    )
    .build_query_as()
    .fetch_all(&st.db)
    .await?;
    let bytes: i64 = q("SELECT COALESCE(SUM(bytes), 0)", "")
        .build_query_scalar()
        .fetch_one(&st.db)
        .await?;
    let unique_ips: i64 = q("SELECT COUNT(DISTINCT ip)", "")
        .build_query_scalar()
        .fetch_one(&st.db)
        .await?;
    let by_day: Vec<(String, i64)> = q(
        "SELECT strftime('%Y-%m-%d', ts, 'unixepoch'), COUNT(*)",
        " GROUP BY 1 ORDER BY 1 DESC LIMIT 60",
    )
    .build_query_as()
    .fetch_all(&st.db)
    .await?;
    let top_shares: Vec<(i64, i64)> = q(
        "SELECT share_id, COUNT(*)",
        " AND share_id IS NOT NULL GROUP BY share_id ORDER BY 2 DESC LIMIT 10",
    )
    .build_query_as()
    .fetch_all(&st.db)
    .await?;
    let top_paths: Vec<(String, i64)> = q(
        "SELECT path, COUNT(*)",
        " AND path != '' GROUP BY path ORDER BY 2 DESC LIMIT 10",
    )
    .build_query_as()
    .fetch_all(&st.db)
    .await?;
    let per_ip: Vec<(String, i64)> = q("SELECT ip, COUNT(*)", " GROUP BY ip ORDER BY 2 DESC")
        .build_query_as()
        .fetch_all(&st.db)
        .await?;
    let top_ips: Vec<&(String, i64)> = per_ip.iter().take(10).collect();
    let geo = geo_summary(&per_ip);
    let rows: Vec<crate::audit::AuditRow> = q(&format!("SELECT {}", crate::audit::COLS), "")
        .push(" ORDER BY id DESC LIMIT ")
        .push_bind(per)
        .push(" OFFSET ")
        .push_bind((page - 1) * per)
        .build_query_as()
        .fetch_all(&st.db)
        .await?;
    // share names for display
    let mut ids: Vec<i64> = rows.iter().filter_map(|r| r.share_id).collect();
    ids.extend(top_shares.iter().map(|x| x.0));
    ids.sort();
    ids.dedup();
    let mut names: HashMap<i64, String> = HashMap::new();
    for id in ids {
        if let Some(n) = sqlx::query_scalar::<_, String>("SELECT name FROM shares WHERE id = ?")
            .bind(id)
            .fetch_optional(&st.db)
            .await?
        {
            names.insert(id, n);
        }
    }
    let name_of = |id: Option<i64>| id.and_then(|i| names.get(&i).cloned());
    Ok(Json(json!({
        "scope": scope,
        "total": total,
        "page": page,
        "per_page": per,
        "summary": {
            "events": total,
            "visits": count_of(&by_action, VISIT),
            "downloads": count_of(&by_action, DOWNLOAD),
            "uploads": count_of(&by_action, UPLOAD),
            "previews": count_of(&by_action, PREVIEW),
            "bytes": bytes,
            "unique_ips": unique_ips,
            "by_action": by_action.iter().map(|(a, n)| json!({"action": a, "count": n})).collect::<Vec<_>>(),
            "by_day": by_day.iter().rev().map(|(d, n)| json!({"day": d, "count": n})).collect::<Vec<_>>(),
            "top_shares": top_shares.iter().map(|(i, n)| json!({"share_id": i, "name": name_of(Some(*i)), "count": n})).collect::<Vec<_>>(),
            "top_paths": top_paths.iter().map(|(p, n)| json!({"path": p, "count": n})).collect::<Vec<_>>(),
            "top_ips": top_ips.iter().map(|(p, n)| json!({"ip": p, "count": n, "geo": geoip::lookup(p)})).collect::<Vec<_>>(),
            "geo": geo,
        },
        "rows": rows.iter().map(|r| { let mut v = r.json(); v["share_name"] = json!(name_of(r.share_id)); v["geo"] = json!(geoip::lookup(&r.ip).label); if let Some(o) = v.as_object_mut() { o.remove("prev_hash"); o.remove("hash"); } v }).collect::<Vec<_>>(),
    })))
}

/// Scope / ownership resolution shared by every stats endpoint; also resolves the region filter
/// (`country` / `region`) into an IP allow-list, since regions are not stored in the log.
async fn prelude(
    st: &AppState,
    p: &Principal,
    f: &mut StatsQuery,
) -> ApiResult<(&'static str, Option<i64>)> {
    let u = p.require_user()?;
    let admin = st.has_cap(p, drivehub_core::acl::ADMIN_AUDIT);
    let manage = admin || st.has_cap(p, drivehub_core::acl::SHARE_MANAGE);
    let scope = match f.scope.as_deref() {
        Some("files") if admin => "files",
        Some("all") if admin => "all",
        _ => "shares",
    };
    // admins see everyone's shares unless all=false; users only their own
    let owner = if manage && f.all.unwrap_or(true) {
        None
    } else {
        Some(u.id)
    };
    st.audit_log.flush().await;
    let country = f.country.clone().filter(|c| !c.trim().is_empty());
    let region = f.region.clone().filter(|c| !c.trim().is_empty());
    if country.is_some() || region.is_some() {
        f.ip_in = None;
        let mut b: QueryBuilder<Sqlite> = QueryBuilder::new("SELECT DISTINCT ip");
        push_where(&mut b, f, scope, owner);
        let ips: Vec<String> = b.build_query_scalar().fetch_all(&st.db).await?;
        let keep = ips
            .into_iter()
            .filter(|ip| {
                let g = geoip::lookup(ip);
                country
                    .as_deref()
                    .is_none_or(|c| geo_key(&g).eq_ignore_ascii_case(c.trim()))
                    && region.as_deref().is_none_or(|r| g.region == r.trim())
            })
            .collect();
        f.ip_in = Some(keep);
    }
    Ok((scope, owner))
}

/// Country bucket of a lookup: ISO code, "LAN" for private networks, "??" when unknown.
fn geo_key(g: &geoip::Geo) -> String {
    match g.kind {
        "lan" | "loopback" => "LAN".into(),
        _ if !g.code.is_empty() => g.code.clone(),
        _ if !g.country.is_empty() => g.country.clone(),
        _ => "??".into(),
    }
}

/// Visitor geography: events / distinct IPs per country and per province (state).
fn geo_summary(per_ip: &[(String, i64)]) -> Value {
    #[derive(Default)]
    struct Acc {
        name: String,
        count: i64,
        ips: i64,
    }
    let mut countries: HashMap<String, Acc> = HashMap::new();
    let mut regions: HashMap<(String, String), Acc> = HashMap::new();
    for (ip, n) in per_ip {
        let g = geoip::lookup(ip);
        let k = geo_key(&g);
        let name = match k.as_str() {
            "LAN" => "局域网".to_string(),
            "??" => {
                if g.kind == "public" {
                    "公网（未识别）".into()
                } else {
                    "未知".into()
                }
            }
            _ => {
                if g.country.is_empty() {
                    k.clone()
                } else {
                    g.country.clone()
                }
            }
        };
        let c = countries.entry(k.clone()).or_default();
        c.name = name.clone();
        c.count += n;
        c.ips += 1;
        if !g.region.is_empty() {
            let r = regions.entry((k, g.region.clone())).or_default();
            r.name = name;
            r.count += n;
            r.ips += 1;
        }
    }
    let mut cs: Vec<_> = countries.into_iter().collect();
    cs.sort_by(|a, b| b.1.count.cmp(&a.1.count).then(a.0.cmp(&b.0)));
    let mut rs: Vec<_> = regions.into_iter().collect();
    rs.sort_by(|a, b| b.1.count.cmp(&a.1.count).then(a.0.cmp(&b.0)));
    json!({
        "db": geoip::loaded(),
        "by_country": cs.iter().map(|(k, a)| json!({"code": k, "name": a.name, "count": a.count, "ips": a.ips})).collect::<Vec<_>>(),
        "by_region": rs.iter().take(60).map(|((k, r), a)| json!({"code": k, "country": a.name, "region": r, "count": a.count, "ips": a.ips})).collect::<Vec<_>>(),
    })
}

/// Per-visitor-IP statistics (r6 #4): events, first / last seen, users, shares, downloads,
/// uploads, traffic, denied count, clients, last user agent and the IP's region.
#[utoipa::path(operation_id = "access_ips", get, path = "/api/stats/ips", params(StatsQuery), responses((status = 200, description = "paged IP table")))]
pub async fn ips(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(mut f): Query<StatsQuery>,
) -> ApiResult<Json<Value>> {
    let (scope, owner) = prelude(&st, &p, &mut f).await?;
    let per = f.per_page.unwrap_or(20).clamp(1, 200);
    let page = f.page.unwrap_or(1).max(1);
    let list = |v: &[&str]| {
        v.iter()
            .map(|a| format!("'{a}'"))
            .collect::<Vec<_>>()
            .join(",")
    };
    let order = match f.sort.as_deref() {
        Some("last") => "last_ts DESC",
        Some("bytes") => "bytes DESC",
        _ => "events DESC",
    };
    let mut b: QueryBuilder<Sqlite> = QueryBuilder::new("SELECT COUNT(DISTINCT ip)");
    push_where(&mut b, &f, scope, owner);
    let total: i64 = b.build_query_scalar().fetch_one(&st.db).await?;
    let mut b: QueryBuilder<Sqlite> = QueryBuilder::new(format!(
        "SELECT ip, COUNT(*) AS events, MIN(ts), MAX(ts) AS last_ts, \
         COALESCE(GROUP_CONCAT(DISTINCT NULLIF(username, '')), ''), COUNT(DISTINCT share_id), \
         SUM(action IN ({v})), SUM(action IN ({d})), SUM(action IN ({u})), COALESCE(SUM(bytes), 0) AS bytes, \
         SUM(allowed = 0), COALESCE(GROUP_CONCAT(DISTINCT client), ''), \
         COALESCE((SELECT a2.ua FROM audit_log a2 WHERE a2.ip = audit_log.ip ORDER BY a2.id DESC LIMIT 1), '')",
        v = list(VISIT),
        d = list(DOWNLOAD),
        u = list(UPLOAD)
    ));
    push_where(&mut b, &f, scope, owner);
    b.push(format!(" GROUP BY ip ORDER BY {order} LIMIT "))
        .push_bind(per)
        .push(" OFFSET ")
        .push_bind((page - 1) * per);
    let rows: Vec<(
        String,
        i64,
        i64,
        i64,
        String,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        String,
        String,
    )> = b.build_query_as().fetch_all(&st.db).await?;
    Ok(Json(json!({
        "total": total,
        "page": page,
        "per_page": per,
        "db": geoip::loaded(),
        "rows": rows.iter().map(|r| json!({
            "ip": r.0, "events": r.1, "first_ts": r.2, "last_ts": r.3,
            "users": r.4.split(',').filter(|x| !x.is_empty()).collect::<Vec<_>>(),
            "shares": r.5, "visits": r.6, "downloads": r.7, "uploads": r.8, "bytes": r.9, "denied": r.10,
            "clients": r.11.split(',').filter(|x| !x.is_empty()).collect::<Vec<_>>(),
            "ua": r.12, "geo": geoip::lookup(&r.0),
        })).collect::<Vec<_>>(),
    })))
}
