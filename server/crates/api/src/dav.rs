//! WebDAV endpoint `/dav` (DEPTAI-473): `drivehub-webdav` handler over the virtual tree.
//! Credentials: Basic with account password (not when TOTP is on), app password or API
//! token as password; Bearer also works. Every operation goes through
//! [`AppState::authorize`] (same ACL as the HTTP API) and is audited on channel `webdav`.
use crate::AppState;
use crate::auth::{CH_DAV, Principal, dav_challenge};
use crate::error::ApiError;
use crate::vfs::Resolved;
use axum::{
    body::Body,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use drivehub_core::acl::{CREATE, DELETE, DOWNLOAD, EDIT, MOVE, READ, UPLOAD};
use drivehub_storage::{ByteRange, ByteStream, Entry, StorageError};
use drivehub_webdav::{Backend, DavError, DavHandler, Session, WriteIntent};
use std::sync::{Arc, OnceLock};

type R<T> = Result<T, DavError>;

fn map_api(e: ApiError) -> DavError {
    match e.0 {
        StatusCode::NOT_FOUND => DavError::NotFound,
        StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED => DavError::Forbidden,
        StatusCode::CONFLICT => DavError::Exists,
        StatusCode::PAYLOAD_TOO_LARGE | StatusCode::INSUFFICIENT_STORAGE => {
            DavError::InsufficientStorage
        }
        StatusCode::BAD_REQUEST => DavError::Forbidden,
        _ => DavError::GeneralFailure,
    }
}

fn map_st(e: StorageError) -> DavError {
    match e {
        StorageError::NotFound(_) => DavError::NotFound,
        StorageError::AlreadyExists(_) => DavError::Exists,
        StorageError::Unsupported(_) => DavError::NotImplemented,
        _ => DavError::GeneralFailure,
    }
}

pub struct DavSession {
    st: AppState,
    p: Principal,
}

impl DavSession {
    fn real(&self, path: &str) -> R<String> {
        self.p.map_in(path).map_err(map_api)
    }
    fn authz(&self, real: &str, need: u32, action: &str) -> R<()> {
        self.st
            .authorize(&self.p, real, need, CH_DAV, action)
            .map_err(map_api)
    }
    fn in_mount(&self, real: &str, write: bool) -> R<(Arc<crate::vfs::Mount>, String)> {
        self.st.vfs.resolve_in(real, write).map_err(map_api)
    }
    fn root_entry(name: &str) -> Entry {
        Entry {
            path: String::new(),
            name: name.into(),
            is_dir: true,
            size: 0,
            modified_unix: None,
        }
    }
}

#[async_trait::async_trait]
impl Backend for DavSession {
    async fn list(&self, path: &str) -> R<Vec<Entry>> {
        let real = self.real(path)?;
        if !real.is_empty() {
            self.authz(&real, READ, "list")?;
            self.st.audit(&self.p, CH_DAV, "list", &real, true, "");
        }
        match self.st.vfs.resolve(&real).map_err(map_api)? {
            Resolved::Root => Ok(self
                .st
                .vfs
                .mounts()
                .into_iter()
                .filter(|m| m.cfg.listed() && self.st.can_see_mount(&self.p, &m.cfg.name))
                .map(|m| Self::root_entry(&m.cfg.name))
                .collect()),
            Resolved::InMount { mount, rel } => {
                let entries = self
                    .st
                    .vfs
                    .list(&mount, &rel, false)
                    .await
                    .map_err(map_api)?;
                Ok(entries
                    .iter()
                    .filter(|e| e.name != crate::share_api::ROOMS_DIR)
                    .filter(|e| {
                        self.st
                            .perms(&self.p, &format!("{}/{}", mount.cfg.name, e.path))
                            .has(READ)
                    })
                    .cloned()
                    .collect())
            }
        }
    }

    async fn stat(&self, path: &str) -> R<Entry> {
        let real = self.real(path)?;
        if real.is_empty() {
            return Ok(Self::root_entry(""));
        }
        self.authz(&real, READ, "stat")?;
        let (m, rel) = self.in_mount(&real, false)?;
        let mut e = m.driver.stat(&rel).await.map_err(map_st)?;
        if rel.is_empty() {
            e.is_dir = true;
            e.name = m.cfg.name.clone();
        }
        Ok(e)
    }

    async fn read(&self, path: &str, range: Option<ByteRange>) -> R<ByteStream> {
        let real = self.real(path)?;
        self.authz(&real, DOWNLOAD, "download")?;
        let (m, rel) = self.in_mount(&real, false)?;
        if range.is_none_or(|r| r.start == 0) {
            let size = m
                .driver
                .stat(&rel)
                .await
                .map(|e| e.size as i64)
                .unwrap_or(0);
            self.st.audit_ev(
                crate::audit::AuditEvent::new(&self.p, CH_DAV, "download", &real, true, "")
                    .bytes(size),
            );
        }
        m.driver.read(&rel, range).await.map_err(map_st)
    }

    async fn check_write(&self, path: &str, intent: WriteIntent) -> R<()> {
        let real = self.real(path)?;
        self.in_mount(&real, true)?;
        let need = match intent {
            WriteIntent::Create => UPLOAD,
            WriteIntent::Overwrite => UPLOAD | EDIT,
        };
        self.authz(&real, need, "upload")?;
        self.st.check_quota(&self.p, 0).await.map_err(map_api)
    }

    async fn write(&self, path: &str, data: ByteStream, size: u64) -> R<()> {
        let real = self.real(path)?;
        let (m, rel) = self.in_mount(&real, true)?;
        let old = m
            .driver
            .stat(&rel)
            .await
            .ok()
            .map(|e| e.size as i64)
            .unwrap_or(0);
        self.authz(
            &real,
            if old > 0 { UPLOAD | EDIT } else { UPLOAD },
            "upload",
        )?;
        self.st.check_quota(&self.p, size).await.map_err(map_api)?;
        let n = m
            .driver
            .write_stream(&rel, data, &|_| {})
            .await
            .map_err(map_st)?;
        self.st.vfs.invalidate(&m.cfg.name);
        self.st.add_usage(&self.p, n as i64 - old).await;
        if let Ok(e) = m.driver.stat(&rel).await {
            self.st.index_upsert(&m.cfg.name, &e).await;
        }
        self.st.audit_ev(
            crate::audit::AuditEvent::new(&self.p, CH_DAV, "upload", &real, true, "")
                .bytes(n as i64),
        );
        Ok(())
    }

    async fn mkdir(&self, path: &str) -> R<()> {
        let real = self.real(path)?;
        self.authz(&real, CREATE, "mkdir")?;
        let (m, rel) = self.in_mount(&real, true)?;
        m.driver.mkdir(&rel).await.map_err(map_st)?;
        self.st.after_change(&m.cfg.name);
        self.st.audit(&self.p, CH_DAV, "mkdir", &real, true, "");
        Ok(())
    }

    async fn delete(&self, path: &str) -> R<()> {
        let real = self.real(path)?;
        self.authz(&real, DELETE, "delete")?;
        let (m, rel) = self.in_mount(&real, true)?;
        let size = m
            .driver
            .stat(&rel)
            .await
            .ok()
            .filter(|e| !e.is_dir)
            .map(|e| e.size as i64);
        m.driver.delete(&rel).await.map_err(map_st)?;
        if let Some(s) = size {
            self.st.add_usage(&self.p, -s).await;
        }
        self.st.after_change(&m.cfg.name);
        self.st.audit(&self.p, CH_DAV, "delete", &real, true, "");
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> R<()> {
        let (src, dst) = (self.real(from)?, self.real(to)?);
        self.authz(&src, MOVE, "move")?;
        let (sm, srel) = self.in_mount(&src, true)?;
        let (dm, drel) = self.in_mount(&dst, true)?;
        let se = sm.driver.stat(&srel).await.map_err(map_st)?;
        self.authz(&dst, MOVE | if se.is_dir { CREATE } else { UPLOAD }, "move")?;
        if sm.cfg.name != dm.cfg.name {
            return Err(DavError::IsRemote); // → 502; clients fall back to copy+delete
        }
        sm.driver.r#move(&srel, &drel).await.map_err(map_st)?;
        self.st.after_change(&sm.cfg.name);
        self.st
            .audit(&self.p, CH_DAV, "move", &src, true, &format!("-> /{dst}"));
        Ok(())
    }

    async fn copy(&self, from: &str, to: &str) -> R<()> {
        let (src, dst) = (self.real(from)?, self.real(to)?);
        self.authz(&src, READ | DOWNLOAD, "copy")?;
        let (sm, srel) = self.in_mount(&src, false)?;
        let (dm, drel) = self.in_mount(&dst, true)?;
        let se = sm.driver.stat(&srel).await.map_err(map_st)?;
        self.authz(&dst, if se.is_dir { CREATE } else { UPLOAD }, "copy")?;
        if sm.cfg.name == dm.cfg.name {
            sm.driver.copy(&srel, &drel).await.map_err(map_st)?;
        } else if !se.is_dir {
            let s = sm.driver.read(&srel, None).await.map_err(map_st)?;
            dm.driver
                .write_stream(&drel, s, &|_| {})
                .await
                .map_err(map_st)?;
        } else {
            return Err(DavError::NotImplemented);
        }
        self.st.after_change(&dm.cfg.name);
        self.st
            .audit(&self.p, CH_DAV, "copy", &src, true, &format!("-> /{dst}"));
        Ok(())
    }

    fn quota(&self) -> Option<(u64, Option<u64>)> {
        let u = self.p.user.as_ref()?;
        Some((
            u.used_bytes.max(0) as u64,
            u.quota_bytes.map(|q| q.max(0) as u64),
        ))
    }
}

fn handler() -> &'static DavHandler<Session> {
    static H: OnceLock<DavHandler<Session>> = OnceLock::new();
    H.get_or_init(|| drivehub_webdav::handler("/dav"))
}

/// `/dav` and `/dav/*` (all methods). Principal comes from the authn middleware.
pub async fn serve(State(st): State<AppState>, req: Request) -> Response {
    let Some(p) = req.extensions().get::<Principal>().cloned() else {
        return dav_challenge();
    };
    if p.user.is_none() && !p.setup {
        // anonymous WebDAV is not offered; ask the client for credentials
        return dav_challenge();
    }
    let principal = format!("/principals/users/{}", p.name());
    let sess: Session = Arc::new(DavSession { st, p });
    let resp = handler().handle_guarded(req, principal, sess).await;
    let (parts, body) = resp.into_parts();
    Response::from_parts(parts, Body::new(body)).into_response()
}
