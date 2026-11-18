use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use drivehub_core::version::{negotiate, ClientKind, Compat, VersionInfo};
use serde::Serialize;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tower_http::services::{ServeDir, ServeFile};
use utoipa::{OpenApi, ToSchema};

pub const HDR_CLIENT: &str = "x-drivehub-client"; // "app/0.1.0" or "web/0.1.0"
pub const HDR_API: &str = "x-drivehub-api"; // client's API major

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "DriveHub API",
        description = "DriveHub multi-cloud-drive manager"
    ),
    paths(version, health),
    components(schemas(VersionInfo, Health, Compat))
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
    let mut app = Router::new()
        .route("/api/version", get(version))
        .route("/api/openapi.json", get(openapi_json))
        .nest("/api/v1", v1)
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
