//! WebDAV front-end (DEPTAI-473): a `dav-server` [`GuardedFileSystem`] over an abstract
//! per-request [`Backend`]. The API crate implements `Backend` on top of the mount
//! registry (StorageDriver) + virtual tree + ACL engine, so every DAV operation goes
//! through the same authorization and audit path as the HTTP API.
//!
//! - Reads are streamed with seek support (Range requests become driver range reads).
//! - Writes are spooled to a temp file and streamed to the driver on flush, so large
//!   uploads never sit in memory.
use bytes::{Buf, Bytes};
use dav_server::davpath::DavPath;
use dav_server::fs::{
    DavDirEntry, DavFile, DavMetaData, FsError, FsFuture, FsResult, FsStream, GuardedFileSystem,
    OpenOptions, ReadDirMeta,
};
use drivehub_storage::{ByteRange, ByteStream, Entry};
use futures::{FutureExt, StreamExt};
use std::io::SeekFrom;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub use dav_server::fakels::FakeLs;
pub use dav_server::{body::Body as DavBody, DavHandler};

/// What a DAV operation is about to do (used for permission checks before the body is read).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteIntent {
    Create,
    Overwrite,
}

/// Per-request view of the virtual tree for one principal. Paths are user-visible
/// virtual paths (`/mount/dir/file`). Implementations enforce ACL + audit.
#[async_trait::async_trait]
pub trait Backend: Send + Sync {
    async fn list(&self, path: &str) -> FsResult<Vec<Entry>>;
    async fn stat(&self, path: &str) -> FsResult<Entry>;
    async fn read(&self, path: &str, range: Option<ByteRange>) -> FsResult<ByteStream>;
    /// Permission pre-check for a PUT, before any bytes are accepted.
    async fn check_write(&self, path: &str, intent: WriteIntent) -> FsResult<()>;
    async fn write(&self, path: &str, data: ByteStream, size: u64) -> FsResult<()>;
    async fn mkdir(&self, path: &str) -> FsResult<()>;
    async fn delete(&self, path: &str) -> FsResult<()>;
    async fn rename(&self, from: &str, to: &str) -> FsResult<()>;
    async fn copy(&self, from: &str, to: &str) -> FsResult<()>;
    fn quota(&self) -> Option<(u64, Option<u64>)> {
        None
    }
}

pub type Session = Arc<dyn Backend>;

#[derive(Clone, Default)]
pub struct DriveFs;

fn p(path: &DavPath) -> String {
    let s = String::from_utf8_lossy(path.as_bytes()).to_string();
    let t = s.trim_end_matches('/');
    if t.is_empty() {
        "/".into()
    } else {
        t.to_string()
    }
}

#[derive(Debug, Clone)]
struct Meta {
    len: u64,
    modified: Option<i64>,
    dir: bool,
}

impl Meta {
    fn of(e: &Entry) -> Self {
        Self {
            len: e.size,
            modified: e.modified_unix,
            dir: e.is_dir,
        }
    }
}

impl DavMetaData for Meta {
    fn len(&self) -> u64 {
        self.len
    }
    fn modified(&self) -> FsResult<SystemTime> {
        Ok(self
            .modified
            .map(|t| UNIX_EPOCH + Duration::from_secs(t.max(0) as u64))
            .unwrap_or(UNIX_EPOCH))
    }
    fn is_dir(&self) -> bool {
        self.dir
    }
    fn is_symlink(&self) -> bool {
        false
    }
}

struct DirEntry(Entry);
impl DavDirEntry for DirEntry {
    fn name(&self) -> Vec<u8> {
        self.0.name.as_bytes().to_vec()
    }
    fn metadata(&self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let m: Box<dyn DavMetaData> = Box::new(Meta::of(&self.0));
        async move { Ok(m) }.boxed()
    }
}

enum Mode {
    Read {
        // Mutex only to make the file `Sync`; accessed via `get_mut` (no locking).
        stream: Option<(u64, std::sync::Mutex<ByteStream>, Bytes)>,
    },
    Write {
        file: tokio::fs::File,
        tmp: std::path::PathBuf,
        written: u64,
        dirty: bool,
    },
}

struct File {
    sess: Session,
    path: String,
    meta: Meta,
    pos: u64,
    mode: Mode,
}

impl std::fmt::Debug for File {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DavFile({})", self.path)
    }
}

impl Drop for File {
    fn drop(&mut self) {
        if let Mode::Write { tmp, .. } = &self.mode {
            let _ = std::fs::remove_file(tmp);
        }
    }
}

fn spool_path() -> std::path::PathBuf {
    let dir = std::env::var("DRIVEHUB_DAV_SPOOL")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    let n: u64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    dir.join(format!("drivehub-dav-{}-{n:x}.part", std::process::id()))
}

impl DavFile for File {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let m: Box<dyn DavMetaData> = match &self.mode {
            Mode::Write { written, .. } => Box::new(Meta {
                len: *written,
                ..self.meta.clone()
            }),
            _ => Box::new(self.meta.clone()),
        };
        async move { Ok(m) }.boxed()
    }

    fn write_buf(&mut self, mut buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        let b = buf.copy_to_bytes(buf.remaining());
        self.write_bytes(b)
    }

    fn write_bytes(&mut self, buf: Bytes) -> FsFuture<'_, ()> {
        async move {
            match &mut self.mode {
                Mode::Write {
                    file,
                    written,
                    dirty,
                    ..
                } => {
                    if self.pos != *written {
                        file.seek(SeekFrom::Start(self.pos))
                            .await
                            .map_err(|_| FsError::GeneralFailure)?;
                    }
                    file.write_all(&buf)
                        .await
                        .map_err(|_| FsError::GeneralFailure)?;
                    self.pos += buf.len() as u64;
                    *written = (*written).max(self.pos);
                    *dirty = true;
                    Ok(())
                }
                _ => Err(FsError::Forbidden),
            }
        }
        .boxed()
    }

    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        async move {
            let Mode::Read { stream } = &mut self.mode else {
                return Err(FsError::Forbidden);
            };
            if self.pos >= self.meta.len {
                return Ok(Bytes::new());
            }
            let reopen = !matches!(stream, Some((at, _, _)) if *at == self.pos);
            if reopen {
                let s = self
                    .sess
                    .read(
                        &self.path,
                        Some(ByteRange {
                            start: self.pos,
                            end: None,
                        }),
                    )
                    .await?;
                *stream = Some((self.pos, std::sync::Mutex::new(s), Bytes::new()));
            }
            let (at, s, buf) = stream.as_mut().unwrap();
            let s = s.get_mut().map_err(|_| FsError::GeneralFailure)?;
            while buf.len() < count {
                match s.next().await {
                    Some(Ok(chunk)) => {
                        let mut v = Vec::with_capacity(buf.len() + chunk.len());
                        v.extend_from_slice(buf);
                        v.extend_from_slice(&chunk);
                        *buf = Bytes::from(v);
                    }
                    Some(Err(_)) => return Err(FsError::GeneralFailure),
                    None => break,
                }
            }
            let n = count.min(buf.len());
            let out = buf.split_to(n);
            *at += n as u64;
            self.pos += n as u64;
            Ok(out)
        }
        .boxed()
    }

    fn seek(&mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        async move {
            let len = match &self.mode {
                Mode::Write { written, .. } => *written,
                _ => self.meta.len,
            };
            let np = match pos {
                SeekFrom::Start(n) => n as i64,
                SeekFrom::End(n) => len as i64 + n,
                SeekFrom::Current(n) => self.pos as i64 + n,
            };
            if np < 0 {
                return Err(FsError::GeneralFailure);
            }
            self.pos = np as u64;
            Ok(self.pos)
        }
        .boxed()
    }

    fn flush(&mut self) -> FsFuture<'_, ()> {
        async move {
            let Mode::Write {
                file,
                tmp,
                written,
                dirty,
            } = &mut self.mode
            else {
                return Ok(());
            };
            if !*dirty && *written > 0 {
                return Ok(());
            }
            file.flush().await.map_err(|_| FsError::GeneralFailure)?;
            let f = tokio::fs::File::open(&tmp)
                .await
                .map_err(|_| FsError::GeneralFailure)?;
            let stream = file_stream(f);
            self.sess.write(&self.path, stream, *written).await?;
            *dirty = false;
            Ok(())
        }
        .boxed()
    }
}

/// Streams a spooled temp file in 1 MiB chunks.
fn file_stream(file: tokio::fs::File) -> ByteStream {
    futures::stream::unfold(Some(file), |st| async move {
        let mut file = st?;
        let mut buf = vec![0u8; 1 << 20];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Bytes::from(buf)), Some(file)))
            }
            Err(e) => Some((Err(e), None)),
        }
    })
    .boxed()
}

impl GuardedFileSystem<Session> for DriveFs {
    fn open<'a>(
        &'a self,
        path: &'a DavPath,
        options: OpenOptions,
        sess: &'a Session,
    ) -> FsFuture<'a, Box<dyn DavFile>> {
        async move {
            let vp = p(path);
            let existing = sess.stat(&vp).await;
            if options.write {
                let exists = match &existing {
                    Ok(e) if e.is_dir => return Err(FsError::Forbidden),
                    Ok(_) => true,
                    Err(FsError::NotFound) => false,
                    Err(e) => return Err(*e),
                };
                if exists && options.create_new {
                    return Err(FsError::Exists);
                }
                if !exists && !options.create && !options.create_new {
                    return Err(FsError::NotFound);
                }
                sess.check_write(
                    &vp,
                    if exists {
                        WriteIntent::Overwrite
                    } else {
                        WriteIntent::Create
                    },
                )
                .await?;
                let tmp = spool_path();
                let file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .read(true)
                    .write(true)
                    .open(&tmp)
                    .await
                    .map_err(|_| FsError::GeneralFailure)?;
                let f: Box<dyn DavFile> = Box::new(File {
                    sess: sess.clone(),
                    meta: Meta {
                        len: 0,
                        modified: Some(
                            SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap()
                                .as_secs() as i64,
                        ),
                        dir: false,
                    },
                    path: vp,
                    pos: 0,
                    mode: Mode::Write {
                        file,
                        tmp,
                        written: 0,
                        dirty: true,
                    },
                });
                return Ok(f);
            }
            let e = existing?;
            if e.is_dir {
                return Err(FsError::Forbidden);
            }
            let f: Box<dyn DavFile> = Box::new(File {
                sess: sess.clone(),
                meta: Meta::of(&e),
                path: vp,
                pos: 0,
                mode: Mode::Read { stream: None },
            });
            Ok(f)
        }
        .boxed()
    }

    fn read_dir<'a>(
        &'a self,
        path: &'a DavPath,
        _meta: ReadDirMeta,
        sess: &'a Session,
    ) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        async move {
            let list = sess.list(&p(path)).await?;
            let items: Vec<FsResult<Box<dyn DavDirEntry>>> = list
                .into_iter()
                .map(|e| Ok(Box::new(DirEntry(e)) as Box<dyn DavDirEntry>))
                .collect();
            let s: FsStream<Box<dyn DavDirEntry>> = Box::pin(futures::stream::iter(items));
            Ok(s)
        }
        .boxed()
    }

    fn metadata<'a>(
        &'a self,
        path: &'a DavPath,
        sess: &'a Session,
    ) -> FsFuture<'a, Box<dyn DavMetaData>> {
        async move {
            let e = sess.stat(&p(path)).await?;
            Ok(Box::new(Meta::of(&e)) as Box<dyn DavMetaData>)
        }
        .boxed()
    }

    fn symlink_metadata<'a>(
        &'a self,
        path: &'a DavPath,
        sess: &'a Session,
    ) -> FsFuture<'a, Box<dyn DavMetaData>> {
        self.metadata(path, sess)
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath, sess: &'a Session) -> FsFuture<'a, ()> {
        async move {
            let vp = p(path);
            if sess.stat(&vp).await.is_ok() {
                return Err(FsError::Exists);
            }
            sess.mkdir(&vp).await
        }
        .boxed()
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath, sess: &'a Session) -> FsFuture<'a, ()> {
        async move { sess.delete(&p(path)).await }.boxed()
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath, sess: &'a Session) -> FsFuture<'a, ()> {
        async move { sess.delete(&p(path)).await }.boxed()
    }

    fn rename<'a>(
        &'a self,
        from: &'a DavPath,
        to: &'a DavPath,
        sess: &'a Session,
    ) -> FsFuture<'a, ()> {
        async move { sess.rename(&p(from), &p(to)).await }.boxed()
    }

    fn copy<'a>(
        &'a self,
        from: &'a DavPath,
        to: &'a DavPath,
        sess: &'a Session,
    ) -> FsFuture<'a, ()> {
        async move { sess.copy(&p(from), &p(to)).await }.boxed()
    }

    fn get_quota<'a>(&'a self, sess: &'a Session) -> FsFuture<'a, (u64, Option<u64>)> {
        async move { sess.quota().ok_or(FsError::NotImplemented) }.boxed()
    }
}

/// Builds the handler serving `/dav` (FakeLs so Windows/macOS clients can LOCK).
pub fn handler(prefix: &str) -> DavHandler<Session> {
    DavHandler::builder()
        .strip_prefix(prefix.to_string())
        .filesystem(Box::new(DriveFs))
        .locksystem(FakeLs::new())
        .build_handler()
}

pub use dav_server::fs::FsError as DavError;
