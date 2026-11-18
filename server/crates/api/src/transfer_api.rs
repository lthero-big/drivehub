//! Web transfer helpers (DEPTAI-476): resumable chunked upload sessions and streaming
//! zip ("打包下载"). Both go through the same `AppState::authorize` path as the core fs API.
use crate::auth::{Principal, CH_API};
use crate::error::{ApiError, ApiResult, ErrorBody};
use crate::fs_api::{item, FsItem};
use crate::AppState;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::Response,
    Extension, Json,
};
use drivehub_core::acl::{DOWNLOAD, EDIT, READ, UPLOAD};
use futures::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::io::{AsyncWriteExt, DuplexStream};
use utoipa::{IntoParams, ToSchema};

/// Suggested chunk size for clients (8 MiB).
pub const CHUNK: u64 = 8 << 20;
/// Sessions untouched this long are removed at startup / on create.
const STALE_SECS: u64 = 24 * 3600;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Meta {
    path: String,
    size: u64,
    overwrite: bool,
    uid: Option<i64>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct NewUpload {
    /// Target virtual file path `/mount/dir/name.ext`
    pub path: String,
    /// Total file size in bytes
    pub size: u64,
    /// Overwrite an existing file (default true)
    pub overwrite: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UploadSession {
    pub id: String,
    pub path: String,
    pub size: u64,
    /// Bytes already received; the next chunk must start here.
    pub offset: u64,
    pub chunk_size: u64,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ChunkQuery {
    /// Byte offset of this chunk; must equal the session's current offset
    pub offset: u64,
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

impl AppState {
    fn up_paths(&self, id: &str) -> ApiResult<(PathBuf, PathBuf)> {
        if !valid_id(id) {
            return Err(ApiError::not_found("upload session not found"));
        }
        Ok((
            self.upload_dir.join(format!("{id}.json")),
            self.upload_dir.join(format!("{id}.part")),
        ))
    }

    async fn up_load(&self, p: &Principal, id: &str) -> ApiResult<(Meta, PathBuf, u64)> {
        let (mj, part) = self.up_paths(id)?;
        let raw = tokio::fs::read(&mj)
            .await
            .map_err(|_| ApiError::not_found("upload session not found"))?;
        let m: Meta = serde_json::from_slice(&raw).map_err(|e| ApiError::bad(e.to_string()))?;
        if m.uid != p.uid() {
            return Err(ApiError::not_found("upload session not found"));
        }
        let off = tokio::fs::metadata(&part)
            .await
            .map(|x| x.len())
            .unwrap_or(0);
        Ok((m, part, off))
    }

    /// Removes upload sessions idle for more than a day.
    pub fn sweep_uploads(&self) {
        let dir = self.upload_dir.clone();
        tokio::spawn(async move {
            let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
                return;
            };
            while let Ok(Some(e)) = rd.next_entry().await {
                let old = e
                    .metadata()
                    .await
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|d| d.as_secs() > STALE_SECS);
                if old {
                    let _ = tokio::fs::remove_file(e.path()).await;
                }
            }
        });
    }
}

fn session(id: &str, m: &Meta, offset: u64) -> UploadSession {
    UploadSession {
        id: id.into(),
        path: m.path.clone(),
        size: m.size,
        offset,
        chunk_size: CHUNK,
    }
}

/// Checks permission / overwrite / quota for writing `size` bytes at `user_path`.
async fn precheck(
    st: &AppState,
    p: &Principal,
    user_path: &str,
    size: u64,
    overwrite: bool,
) -> ApiResult<Option<u64>> {
    let real = p.map_in(user_path)?;
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
    st.authorize(p, &real, need, CH_API, "upload")?;
    if exists.is_some() && !overwrite {
        return Err(ApiError(StatusCode::CONFLICT, "file exists".into()));
    }
    let old = exists.map(|e| e.size);
    st.check_quota(p, size.saturating_sub(old.unwrap_or(0)))
        .await?;
    Ok(old)
}

/// Starts a resumable upload session.
#[utoipa::path(post, path = "/api/fs/uploads", request_body = NewUpload,
    responses((status = 200, body = UploadSession), (status = 403, body = ErrorBody), (status = 409, body = ErrorBody)))]
pub async fn create(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<NewUpload>,
) -> ApiResult<Json<UploadSession>> {
    let overwrite = b.overwrite.unwrap_or(true);
    precheck(&st, &p, &b.path, b.size, overwrite).await?;
    tokio::fs::create_dir_all(&st.upload_dir)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let id: String = (0..16)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect();
    let m = Meta {
        path: b.path,
        size: b.size,
        overwrite,
        uid: p.uid(),
    };
    let (mj, part) = st.up_paths(&id)?;
    let io = |e: std::io::Error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    tokio::fs::write(&part, b"").await.map_err(io)?;
    tokio::fs::write(&mj, serde_json::to_vec(&m).unwrap())
        .await
        .map_err(io)?;
    st.sweep_uploads();
    Ok(Json(session(&id, &m, 0)))
}

/// Upload session state (use `offset` to resume after a disconnect / reload).
#[utoipa::path(get, path = "/api/fs/uploads/{id}", params(("id" = String, Path)),
    responses((status = 200, body = UploadSession), (status = 404, body = ErrorBody)))]
pub async fn get_session(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<UploadSession>> {
    let (m, _, off) = st.up_load(&p, &id).await?;
    Ok(Json(session(&id, &m, off)))
}

/// Appends one chunk (raw body) at `offset`. A mismatched offset answers 409 with the
/// current state so the client can resume from there.
#[utoipa::path(put, path = "/api/fs/uploads/{id}", params(("id" = String, Path), ChunkQuery),
    request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    responses((status = 200, body = UploadSession), (status = 409, body = ErrorBody)))]
pub async fn put_chunk(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Query(q): Query<ChunkQuery>,
    body: Body,
) -> ApiResult<Json<UploadSession>> {
    let (m, part, off) = st.up_load(&p, &id).await?;
    if q.offset != off {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!("offset mismatch: expected {off}"),
        ));
    }
    let io = |e: std::io::Error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    let mut f = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&part)
        .await
        .map_err(io)?;
    let mut s = body.into_data_stream();
    let mut n = off;
    while let Some(c) = s.next().await {
        let c = c.map_err(|e| ApiError::bad(e.to_string()))?;
        n += c.len() as u64;
        if n > m.size {
            drop(f);
            let t = tokio::fs::OpenOptions::new()
                .write(true)
                .open(&part)
                .await
                .map_err(io)?;
            t.set_len(off).await.map_err(io)?;
            return Err(ApiError::bad("chunk exceeds declared size"));
        }
        f.write_all(&c).await.map_err(io)?;
    }
    f.flush().await.map_err(io)?;
    Ok(Json(session(&id, &m, n)))
}

/// Finishes the session: streams the staged file into the target storage.
#[utoipa::path(post, path = "/api/fs/uploads/{id}/complete", params(("id" = String, Path)),
    responses((status = 200, body = FsItem), (status = 409, body = ErrorBody)))]
pub async fn complete(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<FsItem>> {
    let (m, part, off) = st.up_load(&p, &id).await?;
    if off != m.size {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!("incomplete: {off}/{} bytes", m.size),
        ));
    }
    let old = precheck(&st, &p, &m.path, m.size, m.overwrite).await?;
    let real = p.map_in(&m.path)?;
    let (mount, rel) = st.vfs.resolve_in(&real, true)?;
    let f = tokio::fs::File::open(&part)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let stream = tokio_util::io::ReaderStream::with_capacity(f, 1 << 20);
    let n = mount
        .driver
        .write_stream(&rel, Box::pin(stream), &|_| {})
        .await?;
    let (mj, _) = st.up_paths(&id)?;
    let _ = tokio::fs::remove_file(&part).await;
    let _ = tokio::fs::remove_file(&mj).await;
    st.vfs.invalidate(&mount.cfg.name);
    st.add_usage(&p, n as i64 - old.map(|s| s as i64).unwrap_or(0))
        .await;
    st.audit(
        &p,
        CH_API,
        "upload",
        &real,
        true,
        &format!("{n} bytes (chunked)"),
    );
    let e = mount.driver.stat(&rel).await?;
    st.index_upsert(&mount.cfg.name, &e).await;
    let mut it = item(&mount.cfg.name, &e);
    it.path = p.map_out(&it.path).unwrap_or_default();
    Ok(Json(it))
}

/// Cancels an upload session and deletes the staged bytes.
#[utoipa::path(delete, path = "/api/fs/uploads/{id}", params(("id" = String, Path)),
    responses((status = 200, body = crate::fs_api::OkResp)))]
pub async fn cancel(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<crate::fs_api::OkResp>> {
    let (_, part, _) = st.up_load(&p, &id).await?;
    let (mj, _) = st.up_paths(&id)?;
    let _ = tokio::fs::remove_file(&part).await;
    let _ = tokio::fs::remove_file(&mj).await;
    Ok(Json(crate::fs_api::OkResp {
        ok: true,
        task_id: None,
    }))
}

// ---- zip ------------------------------------------------------------------

#[derive(Debug, Deserialize, IntoParams)]
pub struct ZipQuery {
    /// Newline-separated virtual paths (files and/or directories)
    pub paths: String,
    /// Archive file name (default `drivehub.zip`)
    pub name: Option<String>,
}

struct ZipItem {
    mount: std::sync::Arc<crate::vfs::Mount>,
    rel: String,
    name: String,
    size: u64,
}

/// Max total bytes / entries in one archive (classic zip32, no zip64).
const ZIP_MAX_BYTES: u64 = 0xFFFF_0000;
const ZIP_MAX_ENTRIES: usize = 65_000;

/// Streams the selected files/folders as an uncompressed zip. Entries the caller may not
/// read+download are skipped silently inside folders and rejected when named directly.
#[utoipa::path(get, path = "/api/fs/zip", params(ZipQuery),
    responses((status = 200, content_type = "application/zip", body = Vec<u8>), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub async fn zip(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<ZipQuery>,
) -> ApiResult<Response> {
    let mut items: Vec<ZipItem> = Vec::new();
    let mut total = 0u64;
    for up in q.paths.lines().map(str::trim).filter(|s| !s.is_empty()) {
        let real = p.map_in(up)?;
        st.authorize(&p, &real, READ | DOWNLOAD, CH_API, "zip")?;
        let (mount, rel) = st.vfs.resolve_in(&real, false)?;
        let e = mount.driver.stat(&rel).await?;
        let base = if rel.is_empty() {
            mount.cfg.name.clone()
        } else {
            e.name.clone()
        };
        if !e.is_dir {
            total += e.size;
            items.push(ZipItem {
                mount: mount.clone(),
                rel: rel.clone(),
                name: base,
                size: e.size,
            });
            continue;
        }
        let prefix = if rel.is_empty() {
            String::new()
        } else {
            format!("{rel}/")
        };
        for c in mount.driver.list_recursive(&rel).await? {
            if c.is_dir {
                continue;
            }
            let vreal = format!("{}/{}", mount.cfg.name, c.path);
            if !st.perms(&p, &vreal).has(READ | DOWNLOAD) {
                continue;
            }
            let sub = c.path.strip_prefix(&prefix).unwrap_or(&c.path);
            total += c.size;
            items.push(ZipItem {
                mount: mount.clone(),
                rel: c.path.clone(),
                name: format!("{base}/{sub}"),
                size: c.size,
            });
        }
        if items.len() > ZIP_MAX_ENTRIES || total > ZIP_MAX_BYTES {
            break;
        }
    }
    if items.is_empty() {
        return Err(ApiError::bad("nothing to pack"));
    }
    if items.len() > ZIP_MAX_ENTRIES || total > ZIP_MAX_BYTES {
        return Err(ApiError::bad(
            "selection too large for one zip (max ~4 GiB / 65000 files)",
        ));
    }
    st.audit(
        &p,
        CH_API,
        "zip",
        q.paths.lines().next().unwrap_or(""),
        true,
        &format!("{} files, {total} bytes", items.len()),
    );
    let (w, r) = tokio::io::duplex(1 << 16);
    tokio::spawn(async move {
        if let Err(e) = write_zip(w, items).await {
            tracing::warn!(error = %e, "zip stream aborted");
        }
    });
    let name = q.name.unwrap_or_else(|| "drivehub.zip".into());
    let name = if name.to_lowercase().ends_with(".zip") {
        name
    } else {
        format!("{name}.zip")
    };
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename*=UTF-8''{}", crate::fs_api::pct(&name)),
        )
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(r)))
        .unwrap())
}

async fn write_zip(mut w: DuplexStream, items: Vec<ZipItem>) -> anyhow::Result<()> {
    // (name, crc, size, local header offset)
    let mut central: Vec<(String, u32, u32, u32)> = Vec::with_capacity(items.len());
    let mut off: u64 = 0;
    for it in items {
        let name = it.name.into_bytes();
        let mut h = Vec::with_capacity(30 + name.len());
        h.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        h.extend_from_slice(&20u16.to_le_bytes()); // version needed
        h.extend_from_slice(&(0x0008u16 | 0x0800).to_le_bytes()); // data descriptor + UTF-8
        h.extend_from_slice(&0u16.to_le_bytes()); // stored
        h.extend_from_slice(&0u32.to_le_bytes()); // dos time/date
        h.extend_from_slice(&[0u8; 12]); // crc, csize, usize (in descriptor)
        h.extend_from_slice(&(name.len() as u16).to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes());
        h.extend_from_slice(&name);
        w.write_all(&h).await?;
        let start = off;
        off += h.len() as u64;
        let mut crc = crc32fast::Hasher::new();
        let mut n: u64 = 0;
        if it.size > 0 {
            let mut s = it.mount.driver.read(&it.rel, None).await?;
            while let Some(c) = s.try_next().await? {
                crc.update(&c);
                n += c.len() as u64;
                w.write_all(&c).await?;
            }
        }
        let crc = crc.finalize();
        let mut d = Vec::with_capacity(16);
        d.extend_from_slice(&0x0807_4b50u32.to_le_bytes());
        d.extend_from_slice(&crc.to_le_bytes());
        d.extend_from_slice(&(n as u32).to_le_bytes());
        d.extend_from_slice(&(n as u32).to_le_bytes());
        w.write_all(&d).await?;
        off += n + 16;
        central.push((
            String::from_utf8(name).unwrap_or_default(),
            crc,
            n as u32,
            start as u32,
        ));
    }
    let cd_start = off;
    let mut cd = Vec::new();
    for (name, crc, size, lho) in &central {
        cd.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        cd.extend_from_slice(&0x031Eu16.to_le_bytes()); // made by unix, 3.0
        cd.extend_from_slice(&20u16.to_le_bytes());
        cd.extend_from_slice(&(0x0008u16 | 0x0800).to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u32.to_le_bytes());
        cd.extend_from_slice(&crc.to_le_bytes());
        cd.extend_from_slice(&size.to_le_bytes());
        cd.extend_from_slice(&size.to_le_bytes());
        cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
        cd.extend_from_slice(&[0u8; 8]); // extra len, comment len, disk, internal attrs
        cd.extend_from_slice(&(0o100644u32 << 16).to_le_bytes()); // external attrs
        cd.extend_from_slice(&lho.to_le_bytes());
        cd.extend_from_slice(name.as_bytes());
    }
    let count = central.len() as u16;
    cd.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    cd.extend_from_slice(&[0u8; 4]);
    cd.extend_from_slice(&count.to_le_bytes());
    cd.extend_from_slice(&count.to_le_bytes());
    cd.extend_from_slice(&((cd.len() - 12) as u32).to_le_bytes());
    cd.extend_from_slice(&(cd_start as u32).to_le_bytes());
    cd.extend_from_slice(&0u16.to_le_bytes());
    w.write_all(&cd).await?;
    w.shutdown().await?;
    Ok(())
}
