pub mod admin_api;
pub mod audit;
pub mod audit_api;
pub mod auth;
pub mod auth_api;
pub mod dav;
pub mod error;
pub mod fs_api;
pub mod roles_api;
pub mod search_api;
pub mod settings;
pub mod share_api;
pub mod stats_api;
pub mod tags_api;
pub mod tasks;
pub mod transfer_api;
pub mod vfs;

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, delete, get, post, put},
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
    pub auth: Arc<auth::Auth>,
    /// Staging area for resumable upload sessions (`<data_dir>/uploads`).
    pub upload_dir: PathBuf,
    /// Ordered hash-chained audit writer + alert engine (DEPTAI-475).
    pub audit_log: Arc<audit::AuditLog>,
    /// Share PIN brute-force protection (DEPTAI-474).
    pub share_guard: Arc<share_api::ShareGuard>,
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
        let auth = Arc::new(auth::Auth::load(&db).await?);
        let upload_dir = data_dir.map(|d| d.join("uploads")).unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "drivehub-uploads-{}-{:x}",
                std::process::id(),
                rand::random::<u32>()
            ))
        });
        let audit_log = audit::AuditLog::start(db.clone(), auth.clone()).await?;
        let st = Self {
            audit_log,
            share_guard: Arc::new(share_api::ShareGuard::from_env()),
            auth,
            upload_dir,
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
        st.sweep_uploads();
        if data_dir.is_some() {
            let db = st.db.clone();
            tokio::spawn(async move {
                loop {
                    let days = audit::retention_days(&db).await;
                    if days > 0 {
                        match audit::purge(&db, days).await {
                            Ok((n, a)) if n > 0 => {
                                tracing::info!(deleted = n, anchor = a, "audit retention purge")
                            }
                            Err(e) => tracing::warn!(error = %e, "audit retention purge failed"),
                            _ => {}
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                }
            });
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

    /// Rejects writes that would exceed the user's quota (507).
    pub async fn check_quota(&self, p: &auth::Principal, add: u64) -> error::ApiResult<()> {
        let Some(uid) = p.uid() else { return Ok(()) };
        let row: Option<(Option<i64>, i64)> =
            sqlx::query_as("SELECT quota_bytes, used_bytes FROM users WHERE id = ?")
                .bind(uid)
                .fetch_optional(&self.db)
                .await?;
        if let Some((Some(q), used)) = row {
            if used + add as i64 > q || (add == 0 && used >= q) {
                return Err(error::ApiError(
                    StatusCode::INSUFFICIENT_STORAGE,
                    format!("quota exceeded ({used}/{q} bytes)"),
                ));
            }
        }
        Ok(())
    }

    /// Tracks bytes written by a user (uploads add, deletes subtract).
    pub async fn add_usage(&self, p: &auth::Principal, delta: i64) {
        if let Some(uid) = p.uid() {
            let _ =
                sqlx::query("UPDATE users SET used_bytes = MAX(0, used_bytes + ?) WHERE id = ?")
                    .bind(delta)
                    .bind(uid)
                    .execute(&self.db)
                    .await;
        }
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
        transfer_api::create,
        transfer_api::get_session,
        transfer_api::put_chunk,
        transfer_api::complete,
        transfer_api::cancel,
        transfer_api::zip,
        fs_api::mounts,
        fs_api::add_mount,
        fs_api::remove_mount,
        fs_api::tasks,
        fs_api::task,
        search_api::search,
        search_api::reindex,
        auth_api::status,
        auth_api::init,
        auth_api::register,
        auth_api::login,
        auth_api::login_totp,
        auth_api::refresh,
        auth_api::logout,
        auth_api::me,
        auth_api::change_password,
        auth_api::forgot_password,
        auth_api::reset_password,
        auth_api::verify_email,
        auth_api::resend_verification,
        auth_api::sessions,
        auth_api::revoke_session,
        auth_api::totp_setup,
        auth_api::totp_enable,
        auth_api::totp_disable,
        auth_api::list_tokens,
        auth_api::create_token,
        auth_api::delete_token,
        auth_api::list_app_passwords,
        auth_api::create_app_password,
        auth_api::delete_app_password,
        auth_api::identities,
        auth_api::unlink_identity,
        auth_api::oauth_start,
        auth_api::oauth_callback,
        admin_api::get_settings,
        admin_api::put_settings,
        admin_api::list_users,
        admin_api::add_user,
        admin_api::patch_user,
        admin_api::delete_user,
        admin_api::user_sessions,
        admin_api::force_logout,
        admin_api::list_groups,
        admin_api::add_group,
        admin_api::delete_group,
        roles_api::list_roles,
        roles_api::add_role,
        roles_api::patch_role,
        roles_api::delete_role,
        roles_api::patch_group,
        audit_api::list,
        audit_api::export,
        audit_api::verify,
        audit_api::get_policy,
        audit_api::put_policy,
        audit_api::purge,
        audit_api::dashboard,
        audit_api::list_alerts,
        audit_api::add_alert,
        audit_api::put_alert,
        audit_api::delete_alert,
        audit_api::test_alert,
        audit_api::alert_events,
        share_api::create,
        share_api::list,
        share_api::get_one,
        share_api::patch,
        share_api::revoke,
        share_api::delete,
        share_api::open,
        share_api::claim,
        share_api::captcha,
        share_api::visit_list,
        share_api::visit_download,
        share_api::visit_direct,
        share_api::visit_upload,
        stats_api::access,
        tags_api::list,
        tags_api::create,
        tags_api::patch,
        tags_api::delete,
        tags_api::assign,
        tags_api::of,
        tags_api::files,
        admin_api::list_rules,
        admin_api::catalog,
        admin_api::add_rule,
        admin_api::delete_rule,
        admin_api::list_gates,
        admin_api::put_gate,
        admin_api::effective
    ),
    components(schemas(
        VersionInfo,
        Health,
        Compat,
        error::ErrorBody,
        fs_api::FsItem,
        transfer_api::NewUpload,
        transfer_api::UploadSession,
        fs_api::ListResp,
        fs_api::PathBody,
        fs_api::OkResp,
        fs_api::RenameBody,
        fs_api::SrcDst,
        vfs::MountConfig,
        tasks::TaskInfo,
        search_api::SearchResp,
        search_api::SearchHitDto,
        search_api::ReindexResp,
        settings::Settings,
        settings::SettingsPatch,
        auth_api::TokenPair,
        auth_api::AuthStatus,
        auth_api::InitBody,
        auth_api::RegisterBody,
        auth_api::LoginBody,
        auth_api::TicketBody,
        auth_api::RefreshBody,
        auth_api::ChangePwBody,
        auth_api::ForgotBody,
        auth_api::ResetBody,
        auth_api::TokenBody,
        auth_api::CodeBody,
        auth_api::NewTokenBody,
        auth_api::NameBody,
        admin_api::NewUserBody,
        admin_api::PatchUserBody,
        admin_api::GroupBody,
        roles_api::RoleBody,
        roles_api::PatchGroupBody,
        admin_api::RuleBody,
        admin_api::GateBody,
        audit_api::PolicyBody,
        audit_api::AlertBody,
        share_api::NewShare,
        share_api::ClaimBody,
        share_api::Captcha,
        tags_api::TagBody,
        tags_api::AssignBody
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
        .route("/fs/uploads", post(transfer_api::create))
        .route(
            "/fs/uploads/{id}",
            get(transfer_api::get_session)
                .put(transfer_api::put_chunk)
                .delete(transfer_api::cancel),
        )
        .route("/fs/uploads/{id}/complete", post(transfer_api::complete))
        .route("/fs/zip", get(transfer_api::zip))
        .route("/mounts", get(fs_api::mounts).post(fs_api::add_mount))
        .route("/mounts/{name}", delete(fs_api::remove_mount))
        .route("/tasks", get(fs_api::tasks))
        .route("/tasks/{id}", get(fs_api::task))
        .route("/search", get(search_api::search))
        .route("/search/reindex", post(search_api::reindex))
        // M2 auth / admin / ACL
        .route("/auth/status", get(auth_api::status))
        .route("/auth/init", post(auth_api::init))
        .route("/auth/register", post(auth_api::register))
        .route("/auth/login", post(auth_api::login))
        .route("/auth/login/totp", post(auth_api::login_totp))
        .route("/auth/refresh", post(auth_api::refresh))
        .route("/auth/logout", post(auth_api::logout))
        .route("/auth/me", get(auth_api::me))
        .route("/auth/password/change", post(auth_api::change_password))
        .route("/auth/password/forgot", post(auth_api::forgot_password))
        .route("/auth/password/reset", post(auth_api::reset_password))
        .route("/auth/email/verify", post(auth_api::verify_email))
        .route("/auth/email/resend", post(auth_api::resend_verification))
        .route("/auth/sessions", get(auth_api::sessions))
        .route("/auth/sessions/{id}", delete(auth_api::revoke_session))
        .route("/auth/totp/setup", post(auth_api::totp_setup))
        .route("/auth/totp/enable", post(auth_api::totp_enable))
        .route("/auth/totp/disable", post(auth_api::totp_disable))
        .route(
            "/auth/tokens",
            get(auth_api::list_tokens).post(auth_api::create_token),
        )
        .route("/auth/tokens/{id}", delete(auth_api::delete_token))
        .route(
            "/auth/app-passwords",
            get(auth_api::list_app_passwords).post(auth_api::create_app_password),
        )
        .route(
            "/auth/app-passwords/{id}",
            delete(auth_api::delete_app_password),
        )
        .route("/auth/identities", get(auth_api::identities))
        .route(
            "/auth/identities/{provider}",
            delete(auth_api::unlink_identity),
        )
        .route("/auth/oauth/{provider}/start", get(auth_api::oauth_start))
        .route(
            "/auth/oauth/{provider}/callback",
            get(auth_api::oauth_callback),
        )
        .route(
            "/admin/settings",
            get(admin_api::get_settings).put(admin_api::put_settings),
        )
        .route(
            "/admin/users",
            get(admin_api::list_users).post(admin_api::add_user),
        )
        .route(
            "/admin/users/{id}",
            axum::routing::patch(admin_api::patch_user).delete(admin_api::delete_user),
        )
        .route("/admin/users/{id}/sessions", get(admin_api::user_sessions))
        .route("/admin/users/{id}/logout", post(admin_api::force_logout))
        .route(
            "/admin/groups",
            get(admin_api::list_groups).post(admin_api::add_group),
        )
        .route(
            "/admin/groups/{id}",
            delete(admin_api::delete_group).patch(roles_api::patch_group),
        )
        .route(
            "/admin/roles",
            get(roles_api::list_roles).post(roles_api::add_role),
        )
        .route(
            "/admin/roles/{id}",
            delete(roles_api::delete_role).patch(roles_api::patch_role),
        )
        .route("/admin/audit", get(audit_api::list))
        .route("/admin/audit/export", get(audit_api::export))
        .route("/admin/audit/verify", get(audit_api::verify))
        .route(
            "/admin/audit/policy",
            get(audit_api::get_policy).put(audit_api::put_policy),
        )
        .route("/admin/audit/purge", post(audit_api::purge))
        .route("/admin/audit/dashboard", get(audit_api::dashboard))
        .route(
            "/admin/alerts",
            get(audit_api::list_alerts).post(audit_api::add_alert),
        )
        .route("/admin/alerts/events", get(audit_api::alert_events))
        .route(
            "/admin/alerts/{id}",
            put(audit_api::put_alert).delete(audit_api::delete_alert),
        )
        .route("/admin/alerts/{id}/test", post(audit_api::test_alert))
        // M3 shares (DEPTAI-474)
        .route("/shares", get(share_api::list).post(share_api::create))
        .route(
            "/shares/{id}",
            get(share_api::get_one)
                .patch(share_api::patch)
                .delete(share_api::delete),
        )
        .route("/shares/{id}/revoke", post(share_api::revoke))
        // DEPTAI-485 r4: access statistics + tags
        .route("/stats/access", get(stats_api::access))
        .route("/tags", get(tags_api::list).post(tags_api::create))
        .route("/tags/assign", post(tags_api::assign))
        .route("/tags/of", get(tags_api::of))
        .route("/tags/files", get(tags_api::files))
        .route(
            "/tags/{id}",
            axum::routing::patch(tags_api::patch).delete(tags_api::delete),
        )
        .route("/s/captcha", get(share_api::captcha))
        .route("/s/claim", post(share_api::claim))
        .route("/s/{code}", get(share_api::open))
        .route("/s/{code}/list", get(share_api::visit_list))
        .route("/s/{code}/download", get(share_api::visit_download))
        .route("/s/{code}/direct", get(share_api::visit_direct))
        .route(
            "/s/{code}/upload",
            put(share_api::visit_upload).post(share_api::visit_upload),
        )
        .route(
            "/acl/rules",
            get(admin_api::list_rules).post(admin_api::add_rule),
        )
        .route("/acl/rules/{id}", delete(admin_api::delete_rule))
        .route(
            "/acl/gates",
            get(admin_api::list_gates).put(admin_api::put_gate),
        )
        .route("/acl/effective", get(admin_api::effective))
        .route("/acl/catalog", get(admin_api::catalog))
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(state.clone(), auth::authn))
        .layer(middleware::from_fn(version_gate));
    // WebDAV (M2 / DEPTAI-473): same authn middleware, ACL enforced per operation.
    let dav = Router::new()
        .route("/dav", any(dav::serve))
        .route("/dav/", any(dav::serve))
        .route("/dav/{*rest}", any(dav::serve))
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(state.clone(), auth::authn));
    // Public share entry points: short link + signed direct link (DEPTAI-474).
    let index = web_dir.as_ref().map(|d| d.join("index.html"));
    let public = Router::new()
        .route(
            "/s/{code}",
            get(
                move |State(st): State<AppState>,
                      axum::Extension(p): axum::Extension<auth::Principal>,
                      headers: HeaderMap,
                      axum::extract::Path(code): axum::extract::Path<String>,
                      axum::extract::Query(q): axum::extract::Query<share_api::OpenQuery>| {
                    let index = index.clone();
                    async move { share_api::short_link(st, p, headers, code, q, index).await }
                },
            ),
        )
        .route("/d/{token}/{name}", get(share_api::direct))
        .layer(middleware::from_fn_with_state(state.clone(), auth::authn));
    let mut app = Router::new()
        .route("/api/version", get(version))
        .route("/api/openapi.json", get(openapi_json))
        .nest("/api/v1", v1)
        .nest("/api", m1)
        .merge(dav)
        .merge(public)
        .with_state(state);
    if let Some(dir) = web_dir {
        let index = dir.join("index.html");
        app = app.fallback_service(
            ServeDir::new(dir)
                .precompressed_br()
                .precompressed_gzip()
                .fallback(ServeFile::new(index)),
        );
        app = app.layer(middleware::from_fn(static_headers));
    }
    app.layer(tower_http::trace::TraceLayer::new_for_http())
}

/// Long-lived caching for hashed build assets, no-cache for the SPA shell, and baseline
/// security headers on every web response.
async fn static_headers(req: Request, next: Next) -> Response {
    use axum::http::{header, HeaderValue};
    let path = req.uri().path().to_string();
    let mut res = next.run(req).await;
    if path.starts_with("/api/") || path.starts_with("/dav") || path.starts_with("/d/") {
        return res;
    }
    let h = res.headers_mut();
    let cc = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cc));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    res
}

pub async fn connect(url: &str) -> anyhow::Result<SqlitePool> {
    let pool = SqlitePool::connect(url).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
