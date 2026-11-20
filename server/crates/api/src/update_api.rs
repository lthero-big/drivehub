//! Update API (DEPTAI-484): status / check / apply / settings for admins, plus the public
//! client-package endpoint (`/api/client/android/latest`).
use crate::auth::{Principal, CH_ADMIN};
use crate::error::{ApiError, ApiResult};
use crate::update::{install, Actor, Effective, LastCheck, UpdateSettings, UpdateStatus};
use crate::AppState;
use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode},
    response::Response,
    Extension, Json,
};
use drivehub_core::version::server_version;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use utoipa::ToSchema;

#[derive(Serialize, ToSchema)]
pub struct UpdateOverview {
    pub current_version: String,
    pub status: UpdateStatus,
    pub last_check: Option<LastCheck>,
    pub settings: UpdateSettings,
    pub effective: Effective,
}

fn actor(p: &Principal) -> Actor {
    Actor {
        name: p.name(),
        uid: p.uid(),
        ip: p.ip.clone(),
    }
}

async fn overview(st: &AppState) -> UpdateOverview {
    let u = &st.updater;
    UpdateOverview {
        current_version: server_version().into(),
        status: u.status(),
        last_check: u.last_check(),
        settings: u.settings().await,
        effective: u.effective().await,
    }
}

/// Update status: current / latest version, release notes, progress, settings (admin).
#[utoipa::path(get, path = "/api/admin/update/status", responses((status = 200, body = UpdateOverview)))]
pub async fn status(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<UpdateOverview>> {
    p.require_admin()?;
    Ok(Json(overview(&st).await))
}

/// Checks the update source now (signature-verified) (admin).
#[utoipa::path(post, path = "/api/admin/update/check", responses((status = 200, body = UpdateOverview)))]
pub async fn check(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<UpdateOverview>> {
    p.require_admin()?;
    st.updater
        .check(&actor(&p))
        .await
        .map_err(|e| ApiError(StatusCode::CONFLICT, format!("{e:#}")))?;
    Ok(Json(overview(&st).await))
}

#[derive(Debug, Deserialize, ToSchema, Default)]
#[serde(default)]
pub struct ApplyBody {
    /// Only download + verify (state `ready`), do not install.
    pub download_only: bool,
}

/// Starts installing the latest release (download → verify → DB backup → swap → restart →
/// health check, automatic rollback). Progress: GET /api/admin/update/status (admin).
#[utoipa::path(post, path = "/api/admin/update/apply", request_body = ApplyBody, responses((status = 202, body = UpdateOverview), (status = 409, description = "busy / disabled / not possible")))]
pub async fn apply(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    body: Option<Json<ApplyBody>>,
) -> ApiResult<(StatusCode, Json<UpdateOverview>)> {
    p.require_admin()?;
    let b = body.map(|b| b.0).unwrap_or_default();
    if let Err(e) = st.updater.start(actor(&p), !b.download_only).await {
        st.audit(&p, CH_ADMIN, "update_apply", "", false, &format!("{e:#}"));
        return Err(ApiError(StatusCode::CONFLICT, format!("{e:#}")));
    }
    Ok((StatusCode::ACCEPTED, Json(overview(&st).await)))
}

/// Update settings: mode (notify / download / install), maintenance window, source, channel,
/// interval, notifications (admin).
#[utoipa::path(put, path = "/api/admin/update/settings", request_body = UpdateSettings, responses((status = 200, body = UpdateOverview)))]
pub async fn put_settings(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(s): Json<UpdateSettings>,
) -> ApiResult<Json<UpdateOverview>> {
    p.require_admin()?;
    st.updater
        .save_settings(&s)
        .await
        .map_err(|e| ApiError::bad(format!("{e:#}")))?;
    st.audit(
        &p,
        CH_ADMIN,
        "update_settings",
        "",
        true,
        &serde_json::to_string(&s).unwrap_or_default(),
    );
    Ok(Json(overview(&st).await))
}

#[derive(Serialize, ToSchema)]
pub struct ClientPackage {
    /// local (hosted by this server) | manifest (release download)
    pub source: String,
    pub version: Option<String>,
    pub version_code: Option<u64>,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub min_client_version: Option<String>,
    pub notes: Option<String>,
}

fn android_dir(st: &AppState) -> Option<PathBuf> {
    st.data_dir.as_ref().map(|d| d.join("clients/android"))
}

fn newest_apk(st: &AppState) -> Option<PathBuf> {
    let rd = std::fs::read_dir(android_dir(st)?).ok()?;
    rd.flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".apk"))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())
        .map(|e| e.path())
}

/// Latest Android client: a package hosted by this server (`<data>/clients/android/*.apk`)
/// or the APK listed in the latest verified release manifest.
#[utoipa::path(get, path = "/api/client/android/latest", responses((status = 200, body = ClientPackage), (status = 404, description = "no package known")))]
pub async fn android_latest(State(st): State<AppState>) -> ApiResult<Json<ClientPackage>> {
    if let Some(apk) = newest_apk(&st) {
        let p = apk.clone();
        let (sha, size) = tokio::task::spawn_blocking(move || {
            (
                install::file_sha256(&p).unwrap_or_default(),
                p.metadata().map(|m| m.len()).unwrap_or(0),
            )
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let name = apk.file_name().unwrap().to_string_lossy().to_string();
        let version = name
            .trim_end_matches(".apk")
            .rsplit(['-', '_'])
            .next()
            .filter(|v| semver::Version::parse(v.trim_start_matches('v')).is_ok())
            .map(|v| v.trim_start_matches('v').to_string());
        return Ok(Json(ClientPackage {
            source: "local".into(),
            version,
            version_code: None,
            url: "/api/client/android/download".into(),
            sha256: sha,
            size,
            min_client_version: None,
            notes: None,
        }));
    }
    let lc = st.updater.last_check();
    let m = lc
        .as_ref()
        .and_then(|l| l.latest.as_ref())
        .ok_or_else(|| ApiError::not_found("no Android package known"))?;
    let a = m
        .artifact("android", "")
        .ok_or_else(|| ApiError::not_found("latest release has no Android package"))?;
    Ok(Json(ClientPackage {
        source: "manifest".into(),
        version: Some(m.version.clone()),
        version_code: a.version_code,
        url: install::resolve(&lc.as_ref().unwrap().source_url, &a.url)?,
        sha256: a.sha256.clone(),
        size: a.size,
        min_client_version: Some(m.min_client_version.clone()),
        notes: Some(m.notes.clone()),
    }))
}

/// Downloads the APK hosted by this server.
#[utoipa::path(get, path = "/api/client/android/download", responses((status = 200, description = "APK"), (status = 404, description = "none hosted")))]
pub async fn android_download(State(st): State<AppState>) -> ApiResult<Response> {
    let apk = newest_apk(&st).ok_or_else(|| ApiError::not_found("no APK hosted on this server"))?;
    let f = tokio::fs::File::open(&apk)
        .await
        .map_err(|e| ApiError::not_found(e.to_string()))?;
    let len = f.metadata().await.map(|m| m.len()).unwrap_or(0);
    let name = apk.file_name().unwrap().to_string_lossy().to_string();
    Response::builder()
        .header(
            header::CONTENT_TYPE,
            "application/vnd.android.package-archive",
        )
        .header(header::CONTENT_LENGTH, len)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", name.replace('"', "")),
        )
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(f)))
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}
