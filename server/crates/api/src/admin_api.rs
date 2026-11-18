//! Admin + ACL API (DEPTAI-471/472): settings, users, groups, ACL rules / access gates,
//! effective-permission viewer, audit log.
#![allow(clippy::type_complexity)]
use crate::auth::*;
use crate::auth_api::{create_user, list_sessions_of, set_password, user_json};
use crate::error::{ApiError, ApiResult};
use crate::settings::{Settings, SettingsPatch};
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use drivehub_core::acl::{self, Role, Subject};
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa::{IntoParams, ToSchema};

/// Server settings (admin).
#[utoipa::path(get, path = "/api/admin/settings", responses((status = 200, body = Settings)))]
pub async fn get_settings(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Settings>> {
    p.require_admin()?;
    Ok(Json(Settings::load(&st.db).await?))
}

/// Updates settings, e.g. `{"open_registration": true}` (admin).
#[utoipa::path(put, path = "/api/admin/settings", request_body = SettingsPatch, responses((status = 200, body = Settings)))]
pub async fn put_settings(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<SettingsPatch>,
) -> ApiResult<Json<Settings>> {
    p.require_admin()?;
    let s = Settings::apply(&st.db, &b).await?;
    st.audit(
        &p,
        CH_AUTH,
        "settings",
        "",
        true,
        &serde_json::to_string(&s).unwrap(),
    );
    Ok(Json(s))
}

/// All users (admin).
#[utoipa::path(get, path = "/api/admin/users", responses((status = 200, description = "users")))]
pub async fn list_users(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Value>>> {
    p.require_admin()?;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM users ORDER BY id")
        .fetch_all(&st.db)
        .await?;
    let mut out = vec![];
    for id in ids {
        out.push(user_json(&st, id).await?);
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct NewUserBody {
    pub username: String,
    pub email: Option<String>,
    pub password: Option<String>,
    /// admin | user | guest (default user)
    pub role: Option<String>,
}

/// Creates a user (admin).
#[utoipa::path(post, path = "/api/admin/users", request_body = NewUserBody, responses((status = 200, description = "user")))]
pub async fn add_user(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<NewUserBody>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let role = Role::parse(b.role.as_deref().unwrap_or("user"))
        .ok_or_else(|| ApiError::bad("bad role"))?;
    let id = create_user(
        &st,
        &b.username,
        b.email.as_deref(),
        b.password.as_deref(),
        role,
        true,
    )
    .await?;
    st.audit(&p, CH_AUTH, "user_create", "", true, &b.username);
    Ok(Json(user_json(&st, id).await?))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchUserBody {
    pub role: Option<String>,
    pub disabled: Option<bool>,
    pub email: Option<String>,
    pub password: Option<String>,
    pub email_verified: Option<bool>,
    /// Group ids (replaces membership).
    pub groups: Option<Vec<i64>>,
    /// Role ids (replaces assignment).
    pub roles: Option<Vec<i64>>,
    /// Jail root, e.g. "/local/home/alice" ("/" = whole tree).
    pub root_path: Option<String>,
    /// Mount names; `[]`… or null via `clear_visible_mounts` for all.
    pub visible_mounts: Option<Vec<String>>,
    pub clear_visible_mounts: Option<bool>,
    /// Bytes; negative clears the quota.
    pub quota_bytes: Option<i64>,
    /// Disable TOTP (lost device recovery).
    pub reset_totp: Option<bool>,
}

async fn admin_count(st: &AppState) -> ApiResult<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0")
            .fetch_one(&st.db)
            .await?,
    )
}

async fn is_admin_user(st: &AppState, id: i64) -> ApiResult<bool> {
    let r: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?;
    Ok(r.ok_or_else(|| ApiError::not_found("no such user"))? == "admin")
}

/// Updates role / status / groups / root / visible mounts / quota (admin).
#[utoipa::path(patch, path = "/api/admin/users/{id}", params(("id" = i64, Path)), request_body = PatchUserBody, responses((status = 200, description = "user")))]
pub async fn patch_user(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
    Json(b): Json<PatchUserBody>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let was_admin = is_admin_user(&st, id).await?;
    let demote = b.role.as_deref().is_some_and(|r| r != "admin") || b.disabled == Some(true);
    if was_admin && demote && admin_count(&st).await? <= 1 {
        return Err(ApiError::bad("cannot demote/disable the last admin"));
    }
    if let Some(r) = &b.role {
        Role::parse(r).ok_or_else(|| ApiError::bad("bad role"))?;
        sqlx::query("UPDATE users SET role = ? WHERE id = ?")
            .bind(r)
            .bind(id)
            .execute(&st.db)
            .await?;
    }
    if let Some(d) = b.disabled {
        sqlx::query("UPDATE users SET disabled = ? WHERE id = ?")
            .bind(d as i64)
            .bind(id)
            .execute(&st.db)
            .await?;
        if d {
            sqlx::query("UPDATE sessions SET revoked = 1 WHERE user_id = ?")
                .bind(id)
                .execute(&st.db)
                .await?;
        }
    }
    if let Some(e) = &b.email {
        sqlx::query("UPDATE users SET email = ? WHERE id = ?")
            .bind(e.to_lowercase())
            .bind(id)
            .execute(&st.db)
            .await?;
    }
    if let Some(v) = b.email_verified {
        sqlx::query("UPDATE users SET email_verified = ? WHERE id = ?")
            .bind(v as i64)
            .bind(id)
            .execute(&st.db)
            .await?;
    }
    if let Some(pw) = &b.password {
        set_password(&st, id, pw).await?;
    }
    if let Some(gs) = &b.groups {
        sqlx::query("DELETE FROM user_groups WHERE user_id = ?")
            .bind(id)
            .execute(&st.db)
            .await?;
        for g in gs {
            sqlx::query("INSERT OR IGNORE INTO user_groups (user_id, group_id) SELECT ?, id FROM groups WHERE id = ?")
                .bind(id)
                .bind(g)
                .execute(&st.db)
                .await?;
        }
    }
    if let Some(rs) = &b.roles {
        sqlx::query("DELETE FROM user_roles WHERE user_id = ?")
            .bind(id)
            .execute(&st.db)
            .await?;
        for r in rs {
            sqlx::query("INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE id = ?")
                .bind(id)
                .bind(r)
                .execute(&st.db)
                .await?;
        }
        st.auth.reload_acl(&st.db).await?;
    }
    if let Some(r) = &b.root_path {
        let r = drivehub_storage::norm(r)?;
        sqlx::query("UPDATE users SET root_path = ? WHERE id = ?")
            .bind(r)
            .bind(id)
            .execute(&st.db)
            .await?;
    }
    if b.clear_visible_mounts == Some(true) {
        sqlx::query("UPDATE users SET visible_mounts = NULL WHERE id = ?")
            .bind(id)
            .execute(&st.db)
            .await?;
    } else if let Some(v) = &b.visible_mounts {
        sqlx::query("UPDATE users SET visible_mounts = ? WHERE id = ?")
            .bind(serde_json::to_string(v).unwrap())
            .bind(id)
            .execute(&st.db)
            .await?;
    }
    if let Some(q) = b.quota_bytes {
        sqlx::query("UPDATE users SET quota_bytes = ? WHERE id = ?")
            .bind(if q < 0 { None } else { Some(q) })
            .bind(id)
            .execute(&st.db)
            .await?;
    }
    if b.reset_totp == Some(true) {
        sqlx::query("UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?")
            .bind(id)
            .execute(&st.db)
            .await?;
    }
    st.auth.forget_basic();
    st.audit(&p, CH_AUTH, "user_update", "", true, &format!("id={id}"));
    Ok(Json(user_json(&st, id).await?))
}

/// Deletes a user and all their credentials (admin; not the last admin).
#[utoipa::path(delete, path = "/api/admin/users/{id}", params(("id" = i64, Path)), responses((status = 200, description = "deleted")))]
pub async fn delete_user(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    if is_admin_user(&st, id).await? && admin_count(&st).await? <= 1 {
        return Err(ApiError::bad("cannot delete the last admin"));
    }
    for q in [
        "DELETE FROM sessions WHERE user_id = ?",
        "DELETE FROM api_tokens WHERE user_id = ?",
        "DELETE FROM app_passwords WHERE user_id = ?",
        "DELETE FROM identities WHERE user_id = ?",
        "DELETE FROM user_groups WHERE user_id = ?",
        "DELETE FROM user_roles WHERE user_id = ?",
        "DELETE FROM email_tokens WHERE user_id = ?",
        "DELETE FROM acl_rules WHERE subject_type = 'user' AND subject_id = ?",
        "DELETE FROM users WHERE id = ?",
    ] {
        sqlx::query(q).bind(id).execute(&st.db).await?;
    }
    st.auth.reload_acl(&st.db).await?;
    st.auth.forget_basic();
    st.audit(&p, CH_AUTH, "user_delete", "", true, &format!("id={id}"));
    Ok(Json(json!({"ok": true})))
}

/// Sessions of a user (admin).
#[utoipa::path(get, path = "/api/admin/users/{id}/sessions", params(("id" = i64, Path)), responses((status = 200, description = "sessions")))]
pub async fn user_sessions(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Vec<Value>>> {
    p.require_admin()?;
    Ok(Json(list_sessions_of(&st, id, None).await?))
}

/// Force logout: revokes every session of a user (admin).
#[utoipa::path(post, path = "/api/admin/users/{id}/logout", params(("id" = i64, Path)), responses((status = 200, description = "revoked")))]
pub async fn force_logout(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let r = sqlx::query("UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0")
        .bind(id)
        .execute(&st.db)
        .await?;
    st.auth.forget_basic();
    st.audit(&p, CH_AUTH, "force_logout", "", true, &format!("id={id}"));
    Ok(Json(json!({"ok": true, "revoked": r.rows_affected()})))
}

/// User groups (admin).
#[utoipa::path(get, path = "/api/admin/groups", responses((status = 200, description = "groups")))]
pub async fn list_groups(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Value>>> {
    p.require_admin()?;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM groups ORDER BY name")
        .fetch_all(&st.db)
        .await?;
    let mut out = vec![];
    for id in ids {
        out.push(crate::roles_api::group_json(&st, id).await?);
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GroupBody {
    pub name: String,
}

/// Creates a group (admin).
#[utoipa::path(post, path = "/api/admin/groups", request_body = GroupBody, responses((status = 200, description = "group")))]
pub async fn add_group(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<GroupBody>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let r = sqlx::query("INSERT INTO groups (name, created_at) VALUES (?, ?)")
        .bind(b.name.trim())
        .bind(now())
        .execute(&st.db)
        .await
        .map_err(|_| ApiError(StatusCode::CONFLICT, "group exists".into()))?;
    Ok(Json(
        json!({"id": r.last_insert_rowid(), "name": b.name.trim()}),
    ))
}

/// Deletes a group, its memberships and rules (admin).
#[utoipa::path(delete, path = "/api/admin/groups/{id}", params(("id" = i64, Path)), responses((status = 200, description = "deleted")))]
pub async fn delete_group(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    for q in [
        "DELETE FROM user_groups WHERE group_id = ?",
        "DELETE FROM group_roles WHERE group_id = ?",
        "DELETE FROM acl_rules WHERE subject_type = 'group' AND subject_id = ?",
        "DELETE FROM groups WHERE id = ?",
    ] {
        sqlx::query(q).bind(id).execute(&st.db).await?;
    }
    st.auth.reload_acl(&st.db).await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct AuditQuery {
    pub limit: Option<i64>,
    /// only denied events
    pub denied: Option<bool>,
    pub channel: Option<String>,
}

/// Audit log, newest first (admin).
#[utoipa::path(get, path = "/api/admin/audit", params(AuditQuery), responses((status = 200, description = "events")))]
pub async fn audit(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<AuditQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    p.require_admin()?;
    let rows: Vec<(
        i64,
        i64,
        Option<i64>,
        String,
        String,
        String,
        String,
        i64,
        String,
    )> = sqlx::query_as(
        "SELECT id, ts, user_id, username, channel, action, path, allowed, detail FROM audit_log
         WHERE (? = 0 OR allowed = 0) AND (? IS NULL OR channel = ?) ORDER BY id DESC LIMIT ?",
    )
    .bind(q.denied.unwrap_or(false) as i64)
    .bind(&q.channel)
    .bind(&q.channel)
    .bind(q.limit.unwrap_or(100).clamp(1, 1000))
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, ts, uid, u, ch, a, path, ok, d)| {
                json!({"id": id, "ts": ts, "user_id": uid, "username": u, "channel": ch, "action": a, "path": path, "allowed": ok != 0, "detail": d})
            })
            .collect(),
    ))
}

// ------------------------------------------------------------------ ACL

#[derive(Debug, Deserialize, IntoParams)]
pub struct RulesQuery {
    /// Only rules on this exact directory.
    pub path: Option<String>,
}

fn rule_json(r: &acl::Rule) -> Value {
    json!({"id": r.id, "path": format!("/{}", r.path), "subject": r.subject.kind(), "subject_id": r.subject.id(),
           "allow": acl::bits_to_names(r.allow), "deny": acl::bits_to_names(r.deny)})
}

/// ACL rules (admin).
#[utoipa::path(get, path = "/api/acl/rules", params(RulesQuery), responses((status = 200, description = "rules")))]
pub async fn list_rules(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<RulesQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    p.require_admin()?;
    let want = q.path.as_deref().map(drivehub_storage::norm).transpose()?;
    let a = st.auth.acl();
    Ok(Json(
        a.rules
            .iter()
            .filter(|r| r.id > 0 && want.as_ref().is_none_or(|w| &r.path == w))
            .map(rule_json)
            .collect(),
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RuleBody {
    /// Directory (subtree) path, e.g. "/local/team"
    pub path: String,
    /// anonymous | logged_in | group | user
    pub subject: String,
    pub subject_id: Option<i64>,
    /// read | download | upload | create | edit | delete | share
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

/// Adds an ACL rule (admin).
#[utoipa::path(post, path = "/api/acl/rules", request_body = RuleBody, responses((status = 200, description = "rule")))]
pub async fn add_rule(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<RuleBody>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let path = drivehub_storage::norm(&b.path)?;
    let subj = Subject::parse(&b.subject, b.subject_id)
        .ok_or_else(|| ApiError::bad("bad subject / subject_id"))?;
    let allow = acl::names_to_bits(&b.allow).map_err(ApiError::bad)?;
    let deny = acl::names_to_bits(&b.deny).map_err(ApiError::bad)?;
    let r = sqlx::query("INSERT INTO acl_rules (path, subject_type, subject_id, allow_bits, deny_bits, created_at) VALUES (?,?,?,?,?,?)")
        .bind(&path)
        .bind(subj.kind())
        .bind(subj.id())
        .bind(allow as i64)
        .bind(deny as i64)
        .bind(now())
        .execute(&st.db)
        .await?;
    st.auth.reload_acl(&st.db).await?;
    st.audit(
        &p,
        CH_AUTH,
        "acl_rule_add",
        &path,
        true,
        &format!(
            "{} {:?} +{:?} -{:?}",
            subj.kind(),
            subj.id(),
            b.allow,
            b.deny
        ),
    );
    Ok(Json(rule_json(&acl::Rule {
        id: r.last_insert_rowid(),
        path,
        subject: subj,
        allow,
        deny,
    })))
}

/// Deletes an ACL rule (admin).
#[utoipa::path(delete, path = "/api/acl/rules/{id}", params(("id" = i64, Path)), responses((status = 200, description = "deleted")))]
pub async fn delete_rule(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    sqlx::query("DELETE FROM acl_rules WHERE id = ?")
        .bind(id)
        .execute(&st.db)
        .await?;
    st.auth.reload_acl(&st.db).await?;
    Ok(Json(json!({"ok": true})))
}

/// Access gates (per-directory access modes) (admin).
#[utoipa::path(get, path = "/api/acl/gates", responses((status = 200, description = "gates")))]
pub async fn list_gates(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Value>>> {
    p.require_admin()?;
    Ok(Json(
        st.auth
            .acl()
            .gates
            .iter()
            .map(|g| json!({"path": format!("/{}", g.path), "modes": gate_modes(g.modes), "has_password": g.password_hash.is_some()}))
            .collect(),
    ))
}

fn gate_modes(m: u32) -> Vec<&'static str> {
    let mut v = vec![];
    if m & acl::GATE_ANON != 0 {
        v.push("anonymous");
    }
    if m & acl::GATE_LOGIN != 0 {
        v.push("logged_in");
    }
    if m & acl::GATE_PASSWORD != 0 {
        v.push("password");
    }
    v
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GateBody {
    pub path: String,
    /// any of anonymous | logged_in | password (combinable); empty list removes the gate
    pub modes: Vec<String>,
    /// required when "password" is in modes (kept if omitted on update)
    pub password: Option<String>,
}

/// Sets the access mode(s) of a directory subtree (admin).
#[utoipa::path(put, path = "/api/acl/gates", request_body = GateBody, responses((status = 200, description = "gate")))]
pub async fn put_gate(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<GateBody>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let path = drivehub_storage::norm(&b.path)?;
    let mut modes = 0;
    for m in &b.modes {
        modes |= match m.as_str() {
            "anonymous" => acl::GATE_ANON,
            "logged_in" => acl::GATE_LOGIN,
            "password" => acl::GATE_PASSWORD,
            _ => return Err(ApiError::bad("modes: anonymous | logged_in | password")),
        };
    }
    if modes == 0 {
        sqlx::query("DELETE FROM acl_gates WHERE path = ?")
            .bind(&path)
            .execute(&st.db)
            .await?;
    } else {
        let existing: Option<Option<String>> =
            sqlx::query_scalar("SELECT password_hash FROM acl_gates WHERE path = ?")
                .bind(&path)
                .fetch_optional(&st.db)
                .await?;
        let hash = match &b.password {
            Some(pw) if !pw.is_empty() => Some(hash_password(pw)?),
            _ => existing.flatten(),
        };
        if modes & acl::GATE_PASSWORD != 0 && hash.is_none() {
            return Err(ApiError::bad("password mode needs a password"));
        }
        sqlx::query("INSERT INTO acl_gates (path, modes, password_hash) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET modes = excluded.modes, password_hash = excluded.password_hash")
            .bind(&path)
            .bind(modes as i64)
            .bind(hash)
            .execute(&st.db)
            .await?;
    }
    st.auth.reload_acl(&st.db).await?;
    st.audit(
        &p,
        CH_AUTH,
        "acl_gate",
        &path,
        true,
        &format!("{:?}", b.modes),
    );
    Ok(Json(
        json!({"path": format!("/{path}"), "modes": gate_modes(modes)}),
    ))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct EffectiveQuery {
    /// Virtual path (as seen by the inspected user)
    pub path: String,
    /// Inspect another user (admin only); omit for yourself; `0` = anonymous
    pub user_id: Option<i64>,
}

/// Effective-permission viewer: resulting bits plus the gate + rule trace that produced them.
#[utoipa::path(get, path = "/api/acl/effective", params(EffectiveQuery), responses((status = 200, description = "effective permissions")))]
pub async fn effective(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<EffectiveQuery>,
) -> ApiResult<Json<Value>> {
    let target = match q.user_id {
        Some(uid) if Some(uid) != p.uid() => {
            p.require_admin()?;
            let mut t = Principal::anonymous(false, p.ip.clone());
            if uid != 0 {
                t.user = Some(
                    st.load_user(uid)
                        .await?
                        .ok_or_else(|| ApiError::not_found("no such user"))?,
                );
                t.via = "inspect";
            }
            t.path_password = p.path_password.clone();
            t
        }
        _ => p.clone(),
    };
    let real = target.map_in(&q.path)?;
    let e = st.perms(&target, &real);
    Ok(Json(json!({
        "path": format!("/{}", drivehub_storage::norm(&q.path)?),
        "real_path": format!("/{real}"),
        "user_id": target.uid(),
        "username": target.name(),
        "permissions": acl::bits_to_names(e.bits),
        "bits": e.bits,
        "reason": e.reason,
        "gate": e.gate.as_ref().map(|g| json!({"path": format!("/{}", g.path), "modes": gate_modes(g.modes), "passed": g.passed})),
        "trace": e.trace.iter().map(|t| json!({"path": format!("/{}", t.path), "subject": t.subject.kind(), "subject_id": t.subject.id(),
            "allow": acl::bits_to_names(t.allow), "deny": acl::bits_to_names(t.deny), "after": acl::bits_to_names(t.bits_after)})).collect::<Vec<_>>(),
    })))
}
