//! RBAC roles (DEPTAI-485 r3): CRUD for roles, group update, role assignment.
use crate::auth::*;
use crate::error::{ApiError, ApiResult};
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use drivehub_core::acl;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa::ToSchema;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn role_json(st: &AppState, id: i64) -> ApiResult<Value> {
    let r: (i64, String, String, i64, i64, i64, Option<String>) = sqlx::query_as(
        "SELECT id, name, description, permissions, builtin, created_at, level FROM roles WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| ApiError::not_found("no such role"))?;
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_roles WHERE role_id = ?")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    let groups: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM group_roles WHERE role_id = ?")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    Ok(json!({"id": r.0, "name": r.1, "description": r.2,
        "permissions": acl::bits_to_names(r.3 as u32), "builtin": r.4 != 0, "created_at": r.5,
        "users": users, "groups": groups, "level": r.6}))
}

/// Roles (admin).
#[utoipa::path(get, path = "/api/admin/roles", responses((status = 200, description = "roles")))]
pub async fn list_roles(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Value>>> {
    p.require_admin()?;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM roles ORDER BY builtin DESC, id")
        .fetch_all(&st.db)
        .await?;
    let mut out = vec![];
    for id in ids {
        out.push(role_json(&st, id).await?);
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RoleBody {
    pub name: String,
    pub description: Option<String>,
    /// read | download | upload | create | edit | delete | share
    #[serde(default)]
    pub permissions: Vec<String>,
}

fn clean_name(n: &str) -> ApiResult<String> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > 48 {
        return Err(ApiError::bad("invalid role name"));
    }
    Ok(n.to_string())
}

/// Creates a role (admin).
#[utoipa::path(post, path = "/api/admin/roles", request_body = RoleBody, responses((status = 200, description = "role")))]
pub async fn add_role(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<RoleBody>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let name = clean_name(&b.name)?;
    let bits = acl::names_to_bits(&b.permissions).map_err(ApiError::bad)?;
    let r = sqlx::query("INSERT INTO roles (name, description, permissions, builtin, created_at) VALUES (?,?,?,0,?)")
        .bind(&name)
        .bind(b.description.clone().unwrap_or_default())
        .bind(bits as i64)
        .bind(now())
        .execute(&st.db)
        .await
        .map_err(|_| ApiError(StatusCode::CONFLICT, "role exists".into()))?;
    st.audit(&p, CH_AUTH, "role_create", "", true, &name);
    Ok(Json(role_json(&st, r.last_insert_rowid()).await?))
}

/// Updates a role's name / description / permissions (admin). Built-in roles can change
/// permissions but not name.
#[utoipa::path(patch, path = "/api/admin/roles/{id}", params(("id" = i64, Path)), request_body = RoleBody, responses((status = 200, description = "role")))]
pub async fn patch_role(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
    Json(b): Json<RoleBody>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let cur: (String, i64) = sqlx::query_as("SELECT name, builtin FROM roles WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such role"))?;
    let name = if cur.1 != 0 { cur.0 } else { clean_name(&b.name)? };
    let bits = acl::names_to_bits(&b.permissions).map_err(ApiError::bad)?;
    sqlx::query("UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?")
        .bind(&name)
        .bind(b.description.clone().unwrap_or_default())
        .bind(bits as i64)
        .bind(id)
        .execute(&st.db)
        .await
        .map_err(|_| ApiError(StatusCode::CONFLICT, "role exists".into()))?;
    st.auth.reload_acl(&st.db).await?;
    st.audit(&p, CH_AUTH, "role_update", "", true, &format!("id={id}"));
    Ok(Json(role_json(&st, id).await?))
}

/// Deletes a role and its assignments (admin).
#[utoipa::path(delete, path = "/api/admin/roles/{id}", params(("id" = i64, Path)), responses((status = 200, description = "deleted")))]
pub async fn delete_role(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let builtin: Option<i64> = sqlx::query_scalar("SELECT builtin FROM roles WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?;
    if builtin.ok_or_else(|| ApiError::not_found("no such role"))? != 0 {
        return Err(ApiError::bad("builtin roles cannot be deleted"));
    }
    let mut tx = st.db.begin().await?;
    let before = effective_admin_count(&mut *tx).await?;
    for q in [
        "DELETE FROM user_roles WHERE role_id = ?",
        "DELETE FROM group_roles WHERE role_id = ?",
        "DELETE FROM roles WHERE id = ?",
    ] {
        sqlx::query(q).bind(id).execute(&mut *tx).await?;
    }
    crate::auth::sync_levels(&mut *tx).await?;
    ensure_admin_remains(&mut tx, before).await?;
    tx.commit().await?;
    st.auth.reload_acl(&st.db).await?;
    st.audit(&p, CH_AUTH, "role_delete", "", true, &format!("id={id}"));
    Ok(Json(json!({"ok": true})))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchGroupBody {
    pub name: Option<String>,
    /// Member user ids (replaces membership).
    pub members: Option<Vec<i64>>,
    /// Role ids (replaces assignment).
    pub roles: Option<Vec<i64>>,
}

/// Renames a group / replaces its members / roles (admin).
#[utoipa::path(patch, path = "/api/admin/groups/{id}", params(("id" = i64, Path)), request_body = PatchGroupBody, responses((status = 200, description = "group")))]
pub async fn patch_group(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
    Json(b): Json<PatchGroupBody>,
) -> ApiResult<Json<Value>> {
    p.require_admin()?;
    let ex: Option<i64> = sqlx::query_scalar("SELECT id FROM groups WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?;
    ex.ok_or_else(|| ApiError::not_found("no such group"))?;
    let mut tx = st.db.begin().await?;
    let before = effective_admin_count(&mut *tx).await?;
    if let Some(n) = &b.name {
        let n = clean_name(n)?;
        sqlx::query("UPDATE groups SET name = ? WHERE id = ?")
            .bind(n)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|_| ApiError(StatusCode::CONFLICT, "group exists".into()))?;
    }
    if let Some(ms) = &b.members {
        sqlx::query("DELETE FROM user_groups WHERE group_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for u in ms {
            sqlx::query("INSERT OR IGNORE INTO user_groups (user_id, group_id) SELECT id, ? FROM users WHERE id = ?")
                .bind(id)
                .bind(u)
                .execute(&mut *tx)
                .await?;
        }
    }
    if let Some(rs) = &b.roles {
        sqlx::query("DELETE FROM group_roles WHERE group_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for r in rs {
            sqlx::query("INSERT OR IGNORE INTO group_roles (group_id, role_id) SELECT ?, id FROM roles WHERE id = ?")
                .bind(id)
                .bind(r)
                .execute(&mut *tx)
                .await?;
        }
    }
    crate::auth::sync_levels(&mut *tx).await?;
    ensure_admin_remains(&mut tx, before).await?;
    tx.commit().await?;
    st.auth.reload_acl(&st.db).await?;
    st.audit(&p, CH_AUTH, "group_update", "", true, &format!("id={id}"));
    Ok(Json(group_json(&st, id).await?))
}

pub async fn group_json(st: &AppState, id: i64) -> ApiResult<Value> {
    let g: (i64, String) = sqlx::query_as("SELECT id, name FROM groups WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such group"))?;
    let members: Vec<(i64, String)> = sqlx::query_as("SELECT u.id, u.username FROM users u JOIN user_groups ug ON ug.user_id = u.id WHERE ug.group_id = ? ORDER BY u.username")
        .bind(id)
        .fetch_all(&st.db)
        .await?;
    let roles: Vec<(i64, String)> = sqlx::query_as("SELECT r.id, r.name FROM roles r JOIN group_roles gr ON gr.role_id = r.id WHERE gr.group_id = ? ORDER BY r.name")
        .bind(id)
        .fetch_all(&st.db)
        .await?;
    Ok(json!({"id": g.0, "name": g.1, "members": members.len(),
        "member_list": members.into_iter().map(|(i, n)| json!({"id": i, "username": n})).collect::<Vec<_>>(),
        "roles": roles.into_iter().map(|(i, n)| json!({"id": i, "name": n})).collect::<Vec<_>>()}))
}
