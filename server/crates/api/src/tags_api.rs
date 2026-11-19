//! File / folder tags (DEPTAI-485 r4 #4). Tags are personal (per user); a tag is attached to a
//! real normalized path and follows renames / moves, and is dropped on delete.
use crate::auth::{Principal, CH_API};
use crate::error::{ApiError, ApiResult};
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use drivehub_core::acl::{READ, TAG};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use utoipa::{IntoParams, ToSchema};

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Tag owner: the user id (0 for setup / no-auth mode).
fn owner(p: &Principal) -> ApiResult<i64> {
    if let Some(id) = p.uid() {
        return Ok(id);
    }
    if p.is_admin() {
        return Ok(0);
    }
    Err(ApiError(StatusCode::UNAUTHORIZED, "login required".into()))
}

pub const COLORS: &[&str] = &[
    "gray", "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink",
];

fn clean_name(n: &str) -> ApiResult<String> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > 32 || n.contains(',') {
        return Err(ApiError::bad("标签名需为 1–32 个字符且不含逗号"));
    }
    Ok(n.to_string())
}

fn clean_color(c: Option<&str>) -> ApiResult<String> {
    match c.map(str::trim).filter(|c| !c.is_empty()) {
        None => Ok("gray".into()),
        Some(c) if COLORS.contains(&c) => Ok(c.to_string()),
        Some(_) => Err(ApiError::bad(format!(
            "color must be one of {}",
            COLORS.join("|")
        ))),
    }
}

async fn tag_json(st: &AppState, uid: i64, id: i64) -> ApiResult<Value> {
    let t: (i64, String, String, i64) = sqlx::query_as(
        "SELECT id, name, color, created_at FROM tags WHERE id = ? AND owner_id = ?",
    )
    .bind(id)
    .bind(uid)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| ApiError::not_found("no such tag"))?;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM path_tags WHERE tag_id = ?")
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    Ok(json!({"id": t.0, "name": t.1, "color": t.2, "created_at": t.3, "count": n}))
}

/// My tags with usage counts.
#[utoipa::path(operation_id = "tags_list", get, path = "/api/tags", responses((status = 200, description = "tags")))]
pub async fn list(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Value>>> {
    let uid = owner(&p)?;
    let rows: Vec<(i64, String, String, i64, i64)> = sqlx::query_as(
        "SELECT t.id, t.name, t.color, t.created_at, (SELECT COUNT(*) FROM path_tags pt WHERE pt.tag_id = t.id) FROM tags t WHERE owner_id = ? ORDER BY lower(t.name)",
    )
    .bind(uid)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|t| json!({"id": t.0, "name": t.1, "color": t.2, "created_at": t.3, "count": t.4}))
            .collect(),
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TagBody {
    pub name: Option<String>,
    /// gray | red | orange | yellow | green | teal | blue | indigo | purple | pink
    pub color: Option<String>,
}

async fn create_tag(st: &AppState, uid: i64, name: &str, color: Option<&str>) -> ApiResult<i64> {
    let name = clean_name(name)?;
    if let Some(id) =
        sqlx::query_scalar::<_, i64>("SELECT id FROM tags WHERE owner_id = ? AND name = ?")
            .bind(uid)
            .bind(&name)
            .fetch_optional(&st.db)
            .await?
    {
        return Ok(id);
    }
    let r = sqlx::query("INSERT INTO tags (owner_id, name, color, created_at) VALUES (?,?,?,?)")
        .bind(uid)
        .bind(&name)
        .bind(clean_color(color)?)
        .bind(now())
        .execute(&st.db)
        .await?;
    Ok(r.last_insert_rowid())
}

/// Creates a tag (returns the existing one if the name is taken).
#[utoipa::path(operation_id = "tags_create", post, path = "/api/tags", request_body = TagBody, responses((status = 200, description = "tag")))]
pub async fn create(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<TagBody>,
) -> ApiResult<Json<Value>> {
    let uid = owner(&p)?;
    let id = create_tag(
        &st,
        uid,
        b.name.as_deref().unwrap_or(""),
        b.color.as_deref(),
    )
    .await?;
    Ok(Json(tag_json(&st, uid, id).await?))
}

/// Renames / recolours a tag.
#[utoipa::path(operation_id = "tags_patch", patch, path = "/api/tags/{id}", params(("id" = i64, Path)), request_body = TagBody, responses((status = 200, description = "tag")))]
pub async fn patch(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
    Json(b): Json<TagBody>,
) -> ApiResult<Json<Value>> {
    let uid = owner(&p)?;
    tag_json(&st, uid, id).await?;
    if let Some(n) = &b.name {
        sqlx::query("UPDATE tags SET name = ? WHERE id = ?")
            .bind(clean_name(n)?)
            .bind(id)
            .execute(&st.db)
            .await
            .map_err(|_| ApiError(StatusCode::CONFLICT, "同名标签已存在".into()))?;
    }
    if b.color.is_some() {
        sqlx::query("UPDATE tags SET color = ? WHERE id = ?")
            .bind(clean_color(b.color.as_deref())?)
            .bind(id)
            .execute(&st.db)
            .await?;
    }
    Ok(Json(tag_json(&st, uid, id).await?))
}

/// Deletes a tag and removes it from every path.
#[utoipa::path(operation_id = "tags_delete", delete, path = "/api/tags/{id}", params(("id" = i64, Path)), responses((status = 200, description = "deleted")))]
pub async fn delete(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let uid = owner(&p)?;
    tag_json(&st, uid, id).await?;
    sqlx::query("DELETE FROM path_tags WHERE tag_id = ?")
        .bind(id)
        .execute(&st.db)
        .await?;
    sqlx::query("DELETE FROM tags WHERE id = ?")
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AssignBody {
    /// Virtual paths (files or folders).
    pub paths: Vec<String>,
    /// Tag ids to attach.
    #[serde(default)]
    pub add: Vec<i64>,
    /// Tag names to attach (created when missing).
    #[serde(default)]
    pub add_names: Vec<String>,
    /// Tag ids to detach.
    #[serde(default)]
    pub remove: Vec<i64>,
    /// Replace the tag set of every path with `add` + `add_names`.
    #[serde(default)]
    pub replace: bool,
}

/// Tags / untags paths (needs `read` on each). Returns the resulting tags per path.
#[utoipa::path(operation_id = "tags_assign", post, path = "/api/tags/assign", request_body = AssignBody, responses((status = 200, description = "path -> tags")))]
pub async fn assign(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<AssignBody>,
) -> ApiResult<Json<Value>> {
    let uid = owner(&p)?;
    if b.paths.is_empty() || b.paths.len() > 1000 {
        return Err(ApiError::bad("paths: 1-1000 entries"));
    }
    let mut add = vec![];
    for id in &b.add {
        tag_json(&st, uid, *id).await?;
        add.push(*id);
    }
    for n in &b.add_names {
        add.push(create_tag(&st, uid, n, None).await?);
    }
    let mut reals = vec![];
    for vp in &b.paths {
        let real = p.map_in(vp)?;
        if real.is_empty() {
            return Err(ApiError::bad("cannot tag the root"));
        }
        st.authorize(&p, &real, READ | TAG, CH_API, "tag")?;
        reals.push((vp.clone(), real));
    }
    for (_, real) in &reals {
        if b.replace {
            sqlx::query("DELETE FROM path_tags WHERE path = ? AND tag_id IN (SELECT id FROM tags WHERE owner_id = ?)")
                .bind(real)
                .bind(uid)
                .execute(&st.db)
                .await?;
        }
        for t in &b.remove {
            sqlx::query("DELETE FROM path_tags WHERE path = ? AND tag_id = ? AND tag_id IN (SELECT id FROM tags WHERE owner_id = ?)")
                .bind(real)
                .bind(t)
                .bind(uid)
                .execute(&st.db)
                .await?;
        }
        for t in &add {
            sqlx::query(
                "INSERT OR IGNORE INTO path_tags (tag_id, path, created_at) VALUES (?,?,?)",
            )
            .bind(t)
            .bind(real)
            .bind(now())
            .execute(&st.db)
            .await?;
        }
    }
    let mut out = serde_json::Map::new();
    for (vp, real) in &reals {
        out.insert(vp.clone(), json!(tags_of(&st, uid, real).await?));
    }
    Ok(Json(Value::Object(out)))
}

async fn tags_of(st: &AppState, uid: i64, real: &str) -> ApiResult<Vec<Value>> {
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT t.id, t.name, t.color FROM path_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.path = ? AND t.owner_id = ? ORDER BY lower(t.name)",
    )
    .bind(real)
    .bind(uid)
    .fetch_all(&st.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(i, n, c)| json!({"id": i, "name": n, "color": c}))
        .collect())
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct OfQuery {
    /// Directory: tags of its direct children.
    pub dir: Option<String>,
    /// Or one path.
    pub path: Option<String>,
}

/// Tags of the direct children of `dir` (or of one `path`): `{ "/local/a.txt": [tag…] }`.
#[utoipa::path(operation_id = "tags_of", get, path = "/api/tags/of", params(OfQuery), responses((status = 200, description = "path -> tags")))]
pub async fn of(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<OfQuery>,
) -> ApiResult<Json<Value>> {
    let uid = owner(&p)?;
    let rows: Vec<(String, i64, String, String)> = if let Some(path) = &q.path {
        let real = p.map_in(path)?;
        sqlx::query_as("SELECT pt.path, t.id, t.name, t.color FROM path_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.owner_id = ? AND pt.path = ? ORDER BY lower(t.name)")
            .bind(uid)
            .bind(real)
            .fetch_all(&st.db)
            .await?
    } else {
        let real = p.map_in(q.dir.as_deref().unwrap_or("/"))?;
        let prefix = if real.is_empty() {
            String::new()
        } else {
            format!("{real}/")
        };
        sqlx::query_as("SELECT pt.path, t.id, t.name, t.color FROM path_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.owner_id = ? AND substr(pt.path, 1, ?) = ? AND instr(substr(pt.path, ? + 1), '/') = 0 ORDER BY lower(t.name)")
            .bind(uid)
            .bind(prefix.chars().count() as i64)
            .bind(&prefix)
            .bind(prefix.chars().count() as i64)
            .fetch_all(&st.db)
            .await?
    };
    let mut m: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (path, id, name, color) in rows {
        if let Some(vp) = p.map_out(&path) {
            m.entry(vp)
                .or_default()
                .push(json!({"id": id, "name": name, "color": color}));
        }
    }
    Ok(Json(json!(m)))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct FilesQuery {
    /// Tag ids, comma separated.
    pub tags: String,
    /// any (default) | all
    pub mode: Option<String>,
    /// Restrict to a directory subtree.
    pub under: Option<String>,
}

/// Paths carrying the given tags (any / all), filtered by read permission.
#[utoipa::path(operation_id = "tags_files", get, path = "/api/tags/files", params(FilesQuery), responses((status = 200, description = "tagged paths")))]
pub async fn files(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<FilesQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    let uid = owner(&p)?;
    let ids: Vec<i64> = q
        .tags
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    if ids.is_empty() {
        return Ok(Json(vec![]));
    }
    let all = q.mode.as_deref() == Some("all");
    let mut b: sqlx::QueryBuilder<sqlx::Sqlite> = sqlx::QueryBuilder::new(
        "SELECT pt.path FROM path_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.owner_id = ",
    );
    b.push_bind(uid).push(" AND pt.tag_id IN (");
    let mut s = b.separated(", ");
    for i in &ids {
        s.push_bind(*i);
    }
    b.push(") GROUP BY pt.path");
    if all {
        b.push(" HAVING COUNT(DISTINCT pt.tag_id) = ")
            .push_bind(ids.len() as i64);
    }
    b.push(" ORDER BY pt.path LIMIT 2000");
    let paths: Vec<String> = b.build_query_scalar().fetch_all(&st.db).await?;
    let under = match &q.under {
        Some(u) => {
            let r = p.map_in(u)?;
            Some(r)
        }
        None => None,
    };
    let mut out = vec![];
    for real in paths {
        if let Some(u) = &under {
            if !u.is_empty() && real != *u && !real.starts_with(&format!("{u}/")) {
                continue;
            }
        }
        if !st.perms(&p, &real).has(READ) {
            continue;
        }
        let Some(vp) = p.map_out(&real) else { continue };
        let name = real.rsplit('/').next().unwrap_or(&real).to_string();
        out.push(json!({"path": vp, "name": name, "tags": tags_of(&st, uid, &real).await?}));
    }
    Ok(Json(out))
}

/// Keeps tags attached after a rename / same-storage move (`from` / `to` real paths).
pub async fn on_move(st: &AppState, from: &str, to: &str) {
    let from = from.trim_matches('/');
    let to = to.trim_matches('/');
    let n = from.chars().count() as i64;
    let _ = sqlx::query(
        "UPDATE OR REPLACE path_tags SET path = ? || substr(path, ? + 1) WHERE path = ? OR substr(path, 1, ? + 1) = ? || '/'",
    )
    .bind(to)
    .bind(n)
    .bind(from)
    .bind(n)
    .bind(from)
    .execute(&st.db)
    .await;
}

/// Drops tags of a deleted path (and everything below it).
pub async fn on_delete(st: &AppState, real: &str) {
    let real = real.trim_matches('/');
    let n = real.chars().count() as i64;
    let _ =
        sqlx::query("DELETE FROM path_tags WHERE path = ? OR substr(path, 1, ? + 1) = ? || '/'")
            .bind(real)
            .bind(n)
            .bind(real)
            .execute(&st.db)
            .await;
}
