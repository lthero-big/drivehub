pub mod error;
pub mod fs_api;
pub mod search_api;
pub mod tasks;
pub mod vfs;

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use drivehub_core::version::{negotiate, ClientKind, Compat, VersionInfo};
use drivehub_search::{Embedder, NoopEmbedder, SearchIndex};
use serde::Serialize;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::services::{ServeDir, ServeFile};
use utoipa::{OpenApi, ToSchema};

pub const HDR_CLIENT: &str = "x-drivehub-client"; // "app/0.1.0" or "web/0.1.0"
pub const HDR_API: &str = "x-drivehub-api"; // client's API major

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub vfs: Arc<vfs::Vfs>,
    pub tasks: Arc<tasks::Tasks>,
    pub search: Arc<SearchIndex>,
    pub embedder: Arc<dyn Embedder>,
    pub index_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    /// Loads mounts, opens the search index (`<data_dir>/index`, or in-RAM when None)
    /// and starts the background task worker (resuming interrupted tasks).
    pub async fn new(db: SqlitePool, data_dir: Option<&std::path::Path>) -> anyhow::Result<Self> {
        let ttl = std::env::var("DRIVEHUB_LIST_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);
        let vfs = Arc::new(vfs::Vfs::load(db.clone(), std::time::Duration::from_secs(ttl)).await?);
        let search = Arc::new(SearchIndex::open(
            data_dir.map(|d| d.join("index")).as_deref(),
        )?);
        let st = Self {
            tasks: tasks::Tasks::new(db.clone()),
            db,
            vfs: vfs.clone(),
            search,
            embedder: Arc::new(NoopEmbedder),
            index_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        let st2 = st.clone();
        let resumed = st
            .tasks
            .start(vfs, Arc::new(move |m: String| st2.reindex_later(&m)))
            .await?;
        if resumed > 0 {
            tracing::info!(resumed, "resumed interrupted tasks");
        }
        Ok(st)
    }

    /// Invalidates the listing cache and re-indexes the mount in the background.
    pub fn after_change(&self, mount: &str) {
        self.vfs.invalidate(mount);
        self.reindex_later(mount);
    }

    pub fn reindex_later(&self, mount: &str) {
        let (st, m) = (self.clone(), mount.to_string());
        tokio::spawn(async move {
            if let Err(e) = search_api::index_mount(&st, &m).await {
                tracing::warn!(mount = %m, error = %e.1, "reindex failed");
            }
        });
    }

    /// Cheap incremental index update for a single uploaded file.
    pub async fn index_upsert(&self, mount: &str, e: &drivehub_storage::Entry) {
        let d = search_api::to_doc(mount, e);
        let _ = search_api::upsert_rows(&self.db, std::slice::from_ref(&d)).await;
        let s = self.search.clone();
        let _ = tokio::task::spawn_blocking(move || s.upsert(&[d])).await;
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "DriveHub API",
        description = "DriveHub multi-cloud-drive manager"
    ),
    paths(
        version,
        health,
        fs_api::list,
        fs_api::stat,
        fs_api::download,
        fs_api::upload,
        fs_api::mkdir,
        fs_api::rename,
        fs_api::copy,
        fs_api::move_,
        fs_api::delete,
        fs_api::mounts,
        fs_api::add_mount,
        fs_api::remove_mount,
        fs_api::tasks,
        fs_api::task,
        search_api::search,
        search_api::reindex
    ),
    components(schemas(
        VersionInfo,
        Health,
        Compat,
        error::ErrorBody,
        fs_api::FsItem,
        fs_api::ListResp,
        fs_api::PathBody,
        fs_api::OkResp,
        fs_api::RenameBody,
        fs_api::SrcDst,
        vfs::MountConfig,
        tasks::TaskInfo,
        search_api::SearchResp,
        search_api::SearchHitDto,
        search_api::ReindexResp
    ))
)]
pub struct ApiDoc;

#[derive(Serialize, ToSchema)]
pub struct Health {
    pub status: &'static str,
    pub db: bool,
}

/// Server / API versions and minimum client versions for negotiation.
#[utoipa::path(get, path = "/api/version", responses((status = 200, body = VersionInfo)))]
pub async fn version() -> Json<VersionInfo> {
    Json(VersionInfo::current())
}

/// Liveness plus database check.
#[utoipa::path(get, path = "/api/v1/health", responses((status = 200, body = Health)))]
pub async fn health(State(st): State<AppState>) -> Json<Health> {
    let db = sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&st.db)
        .await
        .is_ok();
    Json(Health { status: "ok", db })
}

async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    Json(ApiDoc::openapi())
}

/// Rejects incompatible clients on /api/v1/* with 426 and a machine-readable Compat body.
/// Requests without the header pass (curl, WebDAV, third-party API users).
async fn version_gate(headers: HeaderMap, req: Request, next: Next) -> Response {
    let client = headers.get(HDR_CLIENT).and_then(|v| v.to_str().ok());
    if let Some((kind, ver)) = client.and_then(|c| c.split_once('/')) {
        let kind = match kind {
            "app" => Some(ClientKind::App),
            "web" => Some(ClientKind::Web),
            _ => None,
        };
        if let Some(kind) = kind {
            let api = headers
                .get(HDR_API)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok());
            match negotiate(kind, ver, api) {
                Compat::Ok => {}
                c @ Compat::Invalid { .. } => {
                    return (StatusCode::BAD_REQUEST, Json(c)).into_response()
                }
                c => return (StatusCode::UPGRADE_REQUIRED, Json(c)).into_response(),
            }
        }
    }
    next.run(req).await
}

pub fn router(state: AppState, web_dir: Option<PathBuf>) -> Router {
    let v1 = Router::new()
        .route("/health", get(health))
        .layer(middleware::from_fn(version_gate));
    // M1 resource API. Same version gate as /api/v1 (header-less clients pass).
    let m1 = Router::new()
        .route("/fs/list", get(fs_api::list))
        .route("/fs/stat", get(fs_api::stat))
        .route("/fs/download", get(fs_api::download))
        .route("/fs/upload", put(fs_api::upload).post(fs_api::upload))
        .route("/fs/mkdir", post(fs_api::mkdir))
        .route("/fs/rename", post(fs_api::rename))
        .route("/fs/copy", post(fs_api::copy))
        .route("/fs/move", post(fs_api::move_))
        .route("/fs/delete", post(fs_api::delete))
        .route("/mounts", get(fs_api::mounts).post(fs_api::add_mount))
        .route("/mounts/{name}", delete(fs_api::remove_mount))
        .route("/tasks", get(fs_api::tasks))
        .route("/tasks/{id}", get(fs_api::task))
        .route("/search", get(search_api::search))
        .route("/search/reindex", post(search_api::reindex))
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn(version_gate));
    let mut app = Router::new()
        .route("/api/version", get(version))
        .route("/api/openapi.json", get(openapi_json))
        .nest("/api/v1", v1)
        .nest("/api", m1)
        .with_state(state);
    if let Some(dir) = web_dir {
        let index = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }
    app.layer(tower_http::trace::TraceLayer::new_for_http())
}

pub async fn connect(url: &str) -> anyhow::Result<SqlitePool> {
    let pool = SqlitePool::connect(url).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
