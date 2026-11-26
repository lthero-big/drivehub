//! Search API + mount indexer (DEPTAI-470).
use crate::auth::Principal;
use crate::error::{ApiError, ApiResult, ErrorBody};
use crate::AppState;
use axum::{
    extract::{Query, State},
    Extension, Json,
};
use drivehub_search::{AclFilter, FileDoc, SearchMode};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Deserialize, IntoParams)]
pub struct SearchQuery {
    /// Keywords plus filters: `ext:pdf,docx size:>10m size:<1g size:1m..5m mount:name`
    pub q: String,
    /// keyword | semantic | hybrid (semantic/hybrid not enabled in M1)
    pub mode: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SearchHitDto {
    pub score: f32,
    pub mount: String,
    /// Virtual path `/mount/...`
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified_unix: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SearchResp {
    pub mode: String,
    /// false when the requested mode is unavailable (semantic/hybrid in M1)
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub total: usize,
    pub took_ms: f64,
    pub hits: Vec<SearchHitDto>,
}

/// Visibility = not hidden + the same ACL decision (READ) as list/stat/WebDAV.
struct VisibleTo<'a> {
    mounts: HashSet<String>,
    st: &'a AppState,
    p: &'a Principal,
}
impl AclFilter for VisibleTo<'_> {
    fn allow(&self, mount: &str, path: &str) -> bool {
        self.mounts.contains(mount)
            && !crate::share_api::is_room_path(path)
            && self
                .st
                .perms(self.p, &format!("{mount}/{path}"))
                .has(drivehub_core::acl::READ)
    }
}

/// Searches indexed file metadata.
#[utoipa::path(get, path = "/api/search", params(SearchQuery), responses((status = 200, body = SearchResp), (status = 400, body = ErrorBody)))]
pub async fn search(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<SearchResp>> {
    let mode = match q.mode.as_deref() {
        None | Some("keyword") => SearchMode::Keyword,
        Some("semantic") => SearchMode::Semantic,
        Some("hybrid") => SearchMode::Hybrid,
        Some(_) => return Err(ApiError::bad("mode must be keyword|semantic|hybrid")),
    };
    if mode != SearchMode::Keyword && !st.embedder.enabled() {
        let name = if mode == SearchMode::Semantic {
            "semantic"
        } else {
            "hybrid"
        };
        return Ok(Json(SearchResp {
            mode: name.into(),
            enabled: false,
            message: Some(
                "语义/混合搜索未启用（未配置 Embedder/VectorStore），请使用 mode=keyword".into(),
            ),
            total: 0,
            took_ms: 0.0,
            hits: vec![],
        }));
    }
    let acl = VisibleTo {
        mounts: st
            .vfs
            .mounts()
            .iter()
            .filter(|m| m.cfg.listed())
            .map(|m| m.cfg.name.clone())
            .collect(),
        st: &st,
        p: &p,
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let r = st.search.search(&q.q, limit, q.offset.unwrap_or(0), &acl)?;
    Ok(Json(SearchResp {
        mode: "keyword".into(),
        enabled: true,
        message: None,
        total: r.total,
        took_ms: r.took_ms,
        hits: r
            .hits
            .into_iter()
            .map(|h| SearchHitDto {
                score: h.score,
                path: p
                    .map_out(&format!("{}/{}", h.doc.mount, h.doc.path))
                    .unwrap_or_default(),
                mount: h.doc.mount,
                name: h.doc.name,
                ext: h.doc.ext,
                size: h.doc.size,
                is_dir: h.doc.is_dir,
                modified_unix: h.doc.modified_unix,
            })
            .collect(),
    }))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ReindexQuery {
    /// Mount name; omit to reindex all mounts
    pub mount: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReindexResp {
    pub mounts: Vec<String>,
    pub files: usize,
    pub took_ms: f64,
}

/// Scans mount(s) and rebuilds the metadata table + keyword index (synchronous).
#[utoipa::path(post, path = "/api/search/reindex", params(ReindexQuery), responses((status = 200, body = ReindexResp)))]
pub async fn reindex(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<ReindexQuery>,
) -> ApiResult<Json<ReindexResp>> {
    st.require_cap(&p, drivehub_core::acl::ADMIN_MOUNTS)?;
    let t0 = std::time::Instant::now();
    let names: Vec<String> = match q.mount {
        Some(m) => {
            st.vfs
                .get(&m)
                .ok_or_else(|| ApiError::not_found("no such mount"))?;
            vec![m]
        }
        None => st
            .vfs
            .mounts()
            .iter()
            .filter(|m| m.cfg.enabled)
            .map(|m| m.cfg.name.clone())
            .collect(),
    };
    let mut files = 0;
    for n in &names {
        files += index_mount(&st, n).await?;
    }
    Ok(Json(ReindexResp {
        mounts: names,
        files,
        took_ms: t0.elapsed().as_secs_f64() * 1000.0,
    }))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

pub fn to_doc(mount: &str, e: &drivehub_storage::Entry) -> FileDoc {
    FileDoc {
        mount: mount.into(),
        path: e.path.clone(),
        name: e.name.clone(),
        ext: if e.is_dir {
            String::new()
        } else {
            FileDoc::ext_of(&e.name)
        },
        size: e.size,
        is_dir: e.is_dir,
        modified_unix: e.modified_unix,
    }
}

pub async fn upsert_rows(db: &sqlx::SqlitePool, docs: &[FileDoc]) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    let t = now();
    for d in docs {
        sqlx::query("INSERT OR REPLACE INTO files (mount, path, name, ext, size, is_dir, modified_unix, indexed_at) VALUES (?,?,?,?,?,?,?,?)")
            .bind(&d.mount)
            .bind(&d.path)
            .bind(&d.name)
            .bind(&d.ext)
            .bind(d.size as i64)
            .bind(d.is_dir as i64)
            .bind(d.modified_unix)
            .bind(t)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

/// Full rescan of one mount: SQLite `files` rows + tantivy docs are replaced.
pub async fn index_mount(st: &AppState, name: &str) -> ApiResult<usize> {
    let _g = st.index_lock.lock().await;
    let m = st
        .vfs
        .get(name)
        .ok_or_else(|| ApiError::not_found("no such mount"))?;
    let entries = m.driver.list_recursive("").await?;
    let docs: Vec<FileDoc> = entries.iter().map(|e| to_doc(name, e)).collect();
    sqlx::query("DELETE FROM files WHERE mount = ?")
        .bind(name)
        .execute(&st.db)
        .await?;
    upsert_rows(&st.db, &docs).await?;
    let search = st.search.clone();
    let n = name.to_string();
    let docs2 = docs.clone();
    tokio::task::spawn_blocking(move || search.replace_mount(&n, &docs2))
        .await
        .map_err(|e| anyhow::anyhow!(e))??;
    Ok(docs.len())
}
