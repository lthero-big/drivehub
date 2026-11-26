//! Core file API (DEPTAI-469): mounts, unified tree, list/stat/download(Range)/upload/
//! mkdir/rename/move/copy/delete, tasks.
use crate::auth::{Principal, CH_API};
use crate::error::{ApiError, ApiResult, ErrorBody};
use crate::tasks::TaskInfo;
use crate::vfs::{MountConfig, Resolved};
use crate::AppState;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use drivehub_core::acl::{COPY, CREATE, DELETE, DOWNLOAD, EDIT, MOVE, READ, RENAME, UPLOAD};
use drivehub_storage::{ByteRange, Entry, TransferMode};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Serialize, ToSchema)]
pub struct FsItem {
    pub name: String,
    /// Virtual path `/mount/...`
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_unix: Option<i64>,
    /// Set on virtual-root entries (mount points).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mount_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

fn vjoin(mount: &str, rel: &str) -> String {
    if rel.is_empty() {
        format!("/{mount}")
    } else {
        format!("/{mount}/{rel}")
    }
}

pub(crate) fn item(mount: &str, e: &Entry) -> FsItem {
    FsItem {
        name: e.name.clone(),
        path: vjoin(mount, &e.path),
        is_dir: e.is_dir,
        size: e.size,
        modified_unix: e.modified_unix,
        mount_kind: None,
        read_only: None,
    }
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ListQuery {
    /// Virtual directory path, default "/"
    pub path: Option<String>,
    /// 1-based page, default 1
    pub page: Option<usize>,
    /// default 100, max 1000
    pub per_page: Option<usize>,
    /// name | size | modified (dirs always first)
    pub sort: Option<String>,
    /// asc | desc
    pub order: Option<String>,
    /// bypass the TTL listing cache
    pub refresh: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ListResp {
    pub path: String,
    pub total: usize,
    pub page: usize,
    pub per_page: usize,
    pub items: Vec<FsItem>,
}

/// Lists a virtual directory ("/" lists visible mount points).
#[utoipa::path(get, path = "/api/fs/list", params(ListQuery),
    responses((status = 200, body = ListResp), (status = 404, body = ErrorBody)))]
pub async fn list(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<ListResp>> {
    let path = q.path.clone().unwrap_or_else(|| "/".into());
    let real = p.map_in(&path)?;
    if !real.is_empty() {
        st.authorize(&p, &real, READ, CH_API, "list")?;
        if q.page.unwrap_or(1) <= 1 {
            st.audit(&p, CH_API, "list", &real, true, "");
        }
    }
    let mut items: Vec<FsItem> = match st.vfs.resolve(&real)? {
        Resolved::Root => st
            .vfs
            .mounts()
            .into_iter()
            .filter(|m| m.cfg.listed() && st.can_see_mount(&p, &m.cfg.name))
            .map(|m| FsItem {
                name: m.cfg.name.clone(),
                path: format!("/{}", m.cfg.name),
                is_dir: true,
                size: 0,
                modified_unix: None,
                mount_kind: Some(m.cfg.kind.clone()),
                read_only: Some(m.cfg.read_only),
            })
            .collect(),
        Resolved::InMount { mount, rel } => {
            let entries = st
                .vfs
                .list(&mount, &rel, q.refresh.unwrap_or(false))
                .await?;
            entries
                .iter()
                .map(|e| item(&mount.cfg.name, e))
                .filter(|i| i.name != crate::share_api::ROOMS_DIR)
                .filter(|i| st.perms(&p, &i.path).has(READ))
                .filter_map(|mut i| {
                    i.path = p.map_out(&i.path)?;
                    Some(i)
                })
                .collect()
        }
    };
    let root = items.iter().any(|i| i.mount_kind.is_some());
    if !(root && q.sort.is_none()) {
        let desc = q.order.as_deref() == Some("desc");
        let sort = q.sort.clone().unwrap_or_else(|| "name".into());
        items.sort_by(|a, b| {
            let o = match sort.as_str() {
                "size" => a.size.cmp(&b.size),
                "modified" => a.modified_unix.cmp(&b.modified_unix),
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            };
            let o = if desc { o.reverse() } else { o };
            b.is_dir.cmp(&a.is_dir).then(o)
        });
    }
    let per_page = q.per_page.unwrap_or(100).clamp(1, 1000);
    let page = q.page.unwrap_or(1).max(1);
    let total = items.len();
    let items = items
        .into_iter()
        .skip((page - 1) * per_page)
        .take(per_page)
        .collect();
    Ok(Json(ListResp {
        path: format!("/{}", drivehub_storage::norm(&path)?),
        total,
        page,
        per_page,
        items,
    }))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct PathQuery {
    /// Virtual path `/mount/...`
    pub path: String,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct DownloadQuery {
    /// Virtual path `/mount/...`
    pub path: String,
    /// In-browser preview (audited as `preview` instead of `download`)
    pub preview: Option<bool>,
}

/// File / directory metadata.
#[utoipa::path(get, path = "/api/fs/stat", params(PathQuery),
    responses((status = 200, body = FsItem), (status = 404, body = ErrorBody)))]
pub async fn stat(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<FsItem>> {
    let real = p.map_in(&q.path)?;
    if !real.is_empty() {
        st.authorize(&p, &real, READ, CH_API, "stat")?;
    }
    let user_path = format!("/{}", drivehub_storage::norm(&q.path)?);
    match st.vfs.resolve(&real)? {
        Resolved::Root => Ok(Json(FsItem {
            name: String::new(),
            path: "/".into(),
            is_dir: true,
            size: 0,
            modified_unix: None,
            mount_kind: None,
            read_only: Some(true),
        })),
        Resolved::InMount { mount, rel } => {
            let e = mount.driver.stat(&rel).await?;
            let mut it = item(&mount.cfg.name, &e);
            it.path = user_path;
            if rel.is_empty() {
                it.name = mount.cfg.name.clone();
                it.mount_kind = Some(mount.cfg.kind.clone());
                it.read_only = Some(mount.cfg.read_only);
            }
            Ok(Json(it))
        }
    }
}

/// Parses a single `bytes=` range against `size`. Ok(None) = no/ignored header.
#[allow(clippy::result_unit_err)]
pub fn parse_range(h: &str, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = h.trim().strip_prefix("bytes=") else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None); // multi-range not supported: serve whole body
    }
    let (a, b) = spec.split_once('-').ok_or(())?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        (size.saturating_sub(n), size.saturating_sub(1))
    } else {
        let s: u64 = a.parse().map_err(|_| ())?;
        let e: u64 = if b.is_empty() {
            size.saturating_sub(1)
        } else {
            b.parse::<u64>()
                .map_err(|_| ())?
                .min(size.saturating_sub(1))
        };
        (s, e)
    };
    if size == 0 || start > end || start >= size {
        return Err(());
    }
    Ok(Some((start, end)))
}

/// Downloads a file. Supports `Range: bytes=a-b`; honours the mount transfer mode
/// (direct/auto → 302 to a presigned link when the backend offers one, else proxy).
#[utoipa::path(get, path = "/api/fs/download", params(DownloadQuery),
    responses((status = 200, description = "file bytes"), (status = 206, description = "partial content"),
              (status = 302, description = "redirect to direct link"), (status = 416, description = "bad range"),
              (status = 404, body = ErrorBody)))]
pub async fn download(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Query(q): Query<DownloadQuery>,
) -> ApiResult<Response> {
    let real = p.map_in(&q.path)?;
    st.authorize(&p, &real, DOWNLOAD, CH_API, "download")?;
    let (mount, rel) = st.vfs.resolve_in(&real, false)?;
    let e = mount.driver.stat(&rel).await?;
    if e.is_dir {
        return Err(ApiError::bad("is a directory"));
    }
    let preview = q.preview.unwrap_or(false);
    let r = serve_entry(&mount, &rel, &e, &headers, false).await?;
    if counts_as_download(&headers) {
        st.audit_ev(
            crate::audit::AuditEvent::new(
                &p,
                CH_API,
                if preview { "preview" } else { "download" },
                &real,
                true,
                "",
            )
            .bytes(e.size as i64),
        );
    }
    Ok(r)
}

/// True unless this is a Range continuation (`bytes=N-` with N > 0).
pub fn counts_as_download(headers: &HeaderMap) -> bool {
    let Some(r) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    match r
        .trim()
        .strip_prefix("bytes=")
        .and_then(|x| x.split_once('-'))
    {
        Some((a, _)) if !a.is_empty() => a.trim().parse::<u64>().map(|n| n == 0).unwrap_or(true),
        Some(_) => false, // suffix range
        None => true,
    }
}

/// Serves one file entry (Range, mime, sandbox CSP; direct-link redirect when allowed).
pub(crate) async fn serve_entry(
    mount: &crate::vfs::Mount,
    rel: &str,
    e: &Entry,
    headers: &HeaderMap,
    attachment: bool,
) -> ApiResult<Response> {
    let rel = rel.to_string();
    if mount.cfg.mode() != TransferMode::Proxy {
        if let Some(url) = mount.driver.link(&rel, Duration::from_secs(3600)).await? {
            return Ok((
                StatusCode::FOUND,
                [
                    (header::LOCATION, url),
                    ("x-drivehub-transfer".parse().unwrap(), "direct".to_string()),
                ],
            )
                .into_response());
        }
    }
    let mime = mime_of(&e.name);
    let disp = format!(
        "{}; filename*=UTF-8''{}",
        if attachment { "attachment" } else { "inline" },
        pct(&e.name)
    );
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let parsed = match range {
        Some(r) => match parse_range(r, e.size) {
            Ok(v) => v,
            Err(()) => {
                return Ok((
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [(header::CONTENT_RANGE, format!("bytes */{}", e.size))],
                )
                    .into_response());
            }
        },
        None => None,
    };
    let (status, br, len) = match parsed {
        Some((s, en)) => (
            StatusCode::PARTIAL_CONTENT,
            Some(ByteRange {
                start: s,
                end: Some(en + 1),
            }),
            en - s + 1,
        ),
        None => (StatusCode::OK, None, e.size),
    };
    let stream = mount.driver.read(&rel, br).await?;
    let mut resp = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, len)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_DISPOSITION, disp)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header("x-drivehub-transfer", "proxy");
    // Active content (html/svg/…) from user storage must not run with this origin's rights.
    if !(mime.starts_with("image/") && mime != "image/svg+xml"
        || mime.starts_with("video/")
        || mime.starts_with("audio/")
        || mime == "application/pdf")
    {
        resp = resp.header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        );
    }
    if let Some((s, en)) = parsed {
        resp = resp.header(header::CONTENT_RANGE, format!("bytes {s}-{en}/{}", e.size));
    }
    Ok(resp.body(Body::from_stream(stream)).unwrap())
}

pub(crate) fn pct(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

pub(crate) fn mime_of(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "txt" | "log" | "md" | "markdown" | "csv" | "tsv" | "ini" | "conf" | "toml" | "yaml"
        | "yml" | "rs" | "go" | "py" | "js" | "ts" | "tsx" | "jsx" | "java" | "kt" | "c" | "h"
        | "cpp" | "hpp" | "cs" | "sh" | "sql" | "xml" | "css" | "vue" | "rb" | "php" | "swift"
        | "lua" | "srt" | "vtt" => "text/plain; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "m3u8" => "application/vnd.apple.mpegurl",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/aac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct UploadQuery {
    /// Target virtual file path `/mount/dir/name.ext`
    pub path: String,
    /// Overwrite an existing file (default true)
    pub overwrite: Option<bool>,
}

/// Uploads a file; the request body is the raw file content (streamed).
#[utoipa::path(put, path = "/api/fs/upload", params(UploadQuery), request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    responses((status = 200, body = FsItem), (status = 403, body = ErrorBody), (status = 409, body = ErrorBody)))]
pub async fn upload(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Query(q): Query<UploadQuery>,
    body: Body,
) -> ApiResult<Json<FsItem>> {
    let real = p.map_in(&q.path)?;
    let (mount, rel) = st.vfs.resolve_in(&real, true)?;
    let exists = mount.driver.stat(&rel).await.ok();
    if exists.as_ref().is_some_and(|e| e.is_dir) {
        return Err(ApiError(StatusCode::CONFLICT, "is a directory".into()));
    }
    let need = if exists.is_some() {
        UPLOAD | EDIT
    } else {
        UPLOAD
    };
    st.authorize(&p, &real, need, CH_API, "upload")?;
    if exists.is_some() && !q.overwrite.unwrap_or(true) {
        return Err(ApiError(StatusCode::CONFLICT, "file exists".into()));
    }
    let len = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    st.check_quota(&p, len.unwrap_or(0)).await?;
    let stream = body.into_data_stream().map_err(std::io::Error::other);
    let n = mount
        .driver
        .write_stream(&rel, Box::pin(stream), &|_| {})
        .await?;
    st.vfs.invalidate(&mount.cfg.name);
    st.add_usage(&p, n as i64 - exists.map(|e| e.size as i64).unwrap_or(0))
        .await;
    st.audit_ev(
        crate::audit::AuditEvent::new(&p, CH_API, "upload", &real, true, "").bytes(n as i64),
    );
    let e = mount.driver.stat(&rel).await?;
    st.index_upsert(&mount.cfg.name, &e).await;
    let mut it = item(&mount.cfg.name, &e);
    it.path = p.map_out(&it.path).unwrap_or_default();
    Ok(Json(it))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PathBody {
    pub path: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OkResp {
    pub ok: bool,
    /// Present when the operation runs as a background task (cross-storage copy/move).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<i64>,
}

/// Creates a directory (parents included).
#[utoipa::path(post, path = "/api/fs/mkdir", request_body = PathBody, responses((status = 200, body = OkResp)))]
pub async fn mkdir(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<PathBody>,
) -> ApiResult<Json<OkResp>> {
    let real = p.map_in(&b.path)?;
    st.authorize(&p, &real, CREATE, CH_API, "mkdir")?;
    let (mount, rel) = st.vfs.resolve_in(&real, true)?;
    mount.driver.mkdir(&rel).await?;
    st.audit(&p, CH_API, "mkdir", &real, true, "");
    st.after_change(&mount.cfg.name);
    Ok(Json(OkResp {
        ok: true,
        task_id: None,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RenameBody {
    pub path: String,
    pub new_name: String,
}

/// Renames a file or directory in place.
#[utoipa::path(post, path = "/api/fs/rename", request_body = RenameBody, responses((status = 200, body = OkResp)))]
pub async fn rename(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<RenameBody>,
) -> ApiResult<Json<OkResp>> {
    if b.new_name.is_empty() || b.new_name.contains('/') || b.new_name == ".." {
        return Err(ApiError::bad("invalid new_name"));
    }
    let real = p.map_in(&b.path)?;
    st.authorize(&p, &real, RENAME, CH_API, "rename")?;
    let (mount, rel) = st.vfs.resolve_in(&real, true)?;
    let to = match rel.rsplit_once('/') {
        Some((parent, _)) => format!("{parent}/{}", b.new_name),
        None => b.new_name.clone(),
    };
    st.authorize(
        &p,
        &format!("{}/{to}", mount.cfg.name),
        RENAME,
        CH_API,
        "rename",
    )?;
    mount.driver.rename(&rel, &to).await?;
    crate::tags_api::on_move(&st, &real, &format!("{}/{to}", mount.cfg.name)).await;
    st.audit(&p, CH_API, "rename", &real, true, &b.new_name);
    st.after_change(&mount.cfg.name);
    Ok(Json(OkResp {
        ok: true,
        task_id: None,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SrcDst {
    /// Source virtual path
    pub src: String,
    /// Full destination virtual path (including the new name)
    pub dst: String,
}

async fn copy_or_move(
    st: AppState,
    p: Principal,
    b: SrcDst,
    kind: &str,
) -> ApiResult<Json<OkResp>> {
    let (src, dst) = (p.map_in(&b.src)?, p.map_in(&b.dst)?);
    let (sm, srel) = st.vfs.resolve_in(&src, kind == "move")?;
    let (dm, drel) = st.vfs.resolve_in(&dst, true)?;
    let se = sm.driver.stat(&srel).await?;
    let src_need = if kind == "move" {
        MOVE
    } else {
        READ | DOWNLOAD | COPY
    };
    st.authorize(&p, &src, src_need, CH_API, kind)?;
    let dst_need = if se.is_dir { CREATE } else { UPLOAD };
    let dst_need = if kind == "move" {
        dst_need | MOVE
    } else {
        dst_need
    };
    st.authorize(&p, &dst, dst_need, CH_API, kind)?;
    st.audit(&p, CH_API, kind, &src, true, &format!("-> /{dst}"));
    if sm.cfg.name == dm.cfg.name {
        if drel == srel || drel.starts_with(&format!("{srel}/")) {
            return Err(ApiError::bad("destination is inside source"));
        }
        if kind == "move" {
            sm.driver.r#move(&srel, &drel).await?;
            crate::tags_api::on_move(&st, &src, &dst).await;
        } else {
            sm.driver.copy(&srel, &drel).await?;
        }
        st.after_change(&sm.cfg.name);
        return Ok(Json(OkResp {
            ok: true,
            task_id: None,
        }));
    }
    let id = st
        .tasks
        .enqueue(kind, &format!("/{src}"), &format!("/{dst}"))
        .await?;
    Ok(Json(OkResp {
        ok: true,
        task_id: Some(id),
    }))
}

/// Copies; same storage = synchronous, cross-storage = background task (see /api/tasks).
#[utoipa::path(post, path = "/api/fs/copy", request_body = SrcDst, responses((status = 200, body = OkResp)))]
pub async fn copy(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<SrcDst>,
) -> ApiResult<Json<OkResp>> {
    copy_or_move(st, p, b, "copy").await
}

/// Moves; same storage = synchronous rename, cross-storage = background copy+delete task.
#[utoipa::path(post, path = "/api/fs/move", request_body = SrcDst, responses((status = 200, body = OkResp)))]
pub async fn move_(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<SrcDst>,
) -> ApiResult<Json<OkResp>> {
    copy_or_move(st, p, b, "move").await
}

/// Deletes a file or directory (recursive).
#[utoipa::path(post, path = "/api/fs/delete", request_body = PathBody, responses((status = 200, body = OkResp)))]
pub async fn delete(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<PathBody>,
) -> ApiResult<Json<OkResp>> {
    let real = p.map_in(&b.path)?;
    st.authorize(&p, &real, DELETE, CH_API, "delete")?;
    let (mount, rel) = st.vfs.resolve_in(&real, true)?;
    let size = mount
        .driver
        .stat(&rel)
        .await
        .ok()
        .filter(|e| !e.is_dir)
        .map(|e| e.size as i64);
    mount.driver.delete(&rel).await?;
    crate::tags_api::on_delete(&st, &real).await;
    if let Some(sz) = size {
        st.add_usage(&p, -sz).await;
    }
    st.audit(&p, CH_API, "delete", &real, true, "");
    st.after_change(&mount.cfg.name);
    Ok(Json(OkResp {
        ok: true,
        task_id: None,
    }))
}

fn secret_opt_key(k: &str) -> bool {
    let l = k.to_ascii_lowercase();
    ["secret", "password", "token", "cookie"]
        .iter()
        .any(|s| l.contains(s))
        || matches!(l.as_str(), "uid" | "cid" | "seid" | "kid")
}

/// Accept split 115 fields, persist only the composed cookie, and drop the
/// split keys so they are not stored in cleartext next to the cookie.
fn normalize_p115_options(cfg: &mut MountConfig) {
    if cfg.kind != "p115" && cfg.kind != "115" {
        return;
    }
    if let Ok(cookie) = drivehub_storage::drivers::p115::cookie_from_options(&cfg.options) {
        cfg.options.insert("cookie".into(), cookie);
        for k in ["uid", "cid", "seid", "kid", "UID", "CID", "SEID", "KID"] {
            cfg.options.remove(k);
        }
    }
}

#[utoipa::path(get, path = "/api/mounts", responses((status = 200, body = Vec<MountConfig>)))]
pub async fn mounts(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<MountConfig>>> {
    st.require_cap(&p, drivehub_core::acl::ADMIN_MOUNTS)?;
    Ok(Json(
        st.vfs
            .mounts()
            .iter()
            .map(|m| {
                let mut c = m.cfg.clone();
                for (k, v) in c.options.iter_mut() {
                    if secret_opt_key(k) {
                        *v = "***".into(); // never echo credentials
                    }
                }
                c
            })
            .collect(),
    ))
}

/// Creates or updates a mount point, then indexes it in the background.
#[utoipa::path(post, path = "/api/mounts", request_body = MountConfig, responses((status = 200, body = OkResp), (status = 400, body = ErrorBody)))]
pub async fn add_mount(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(mut cfg): Json<MountConfig>,
) -> ApiResult<Json<OkResp>> {
    st.require_cap(&p, drivehub_core::acl::ADMIN_MOUNTS)?;
    // Editing from the UI echoes masked credentials back as "***": keep the stored value.
    if let Some(old) = st.vfs.mounts().iter().find(|m| m.cfg.name == cfg.name) {
        for (k, v) in cfg.options.iter_mut() {
            if v == "***" {
                if let Some(o) = old.cfg.options.get(k) {
                    *v = o.clone();
                }
            }
        }
    }
    normalize_p115_options(&mut cfg);
    let name = cfg.name.clone();
    let enabled = cfg.enabled;
    let summary = format!(
        "kind={} read_only={} enabled={} mode={:?}",
        cfg.kind, cfg.read_only, enabled, cfg.transfer_mode
    );
    st.vfs.add(cfg).await?;
    st.audit(
        &p,
        crate::auth::CH_ADMIN,
        "mount_save",
        &name,
        true,
        &summary,
    );
    if enabled {
        st.after_change(&name);
    } else {
        st.vfs.invalidate(&name);
        let _ = st.search.remove_mount(&name);
    }
    Ok(Json(OkResp {
        ok: true,
        task_id: None,
    }))
}

/// Removes a mount point (files on the backend are untouched).
#[utoipa::path(delete, path = "/api/mounts/{name}", params(("name" = String, Path)), responses((status = 200, body = OkResp), (status = 404, body = ErrorBody)))]
pub async fn remove_mount(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(name): Path<String>,
) -> ApiResult<Json<OkResp>> {
    st.require_cap(&p, drivehub_core::acl::ADMIN_MOUNTS)?;
    if !st.vfs.remove(&name).await? {
        return Err(ApiError::not_found("no such mount"));
    }
    let _ = st.search.remove_mount(&name);
    st.audit(&p, crate::auth::CH_ADMIN, "mount_remove", &name, true, "");
    Ok(Json(OkResp {
        ok: true,
        task_id: None,
    }))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct TasksQuery {
    /// pending | running | done | failed
    pub status: Option<String>,
    pub limit: Option<i64>,
}

/// Background tasks with progress.
#[utoipa::path(get, path = "/api/tasks", params(TasksQuery), responses((status = 200, body = Vec<TaskInfo>)))]
pub async fn tasks(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<TasksQuery>,
) -> ApiResult<Json<Vec<TaskInfo>>> {
    st.require_cap(&p, drivehub_core::acl::ADMIN_MOUNTS)?;
    Ok(Json(
        st.tasks
            .list(q.status.as_deref(), q.limit.unwrap_or(100).clamp(1, 1000))
            .await?,
    ))
}

/// One task.
#[utoipa::path(get, path = "/api/tasks/{id}", params(("id" = i64, Path)), responses((status = 200, body = TaskInfo), (status = 404, body = ErrorBody)))]
pub async fn task(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<TaskInfo>> {
    st.require_cap(&p, drivehub_core::acl::ADMIN_MOUNTS)?;
    st.tasks
        .get(id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such task"))
}
