//! Storage driver layer (DEPTAI-468).
//!
//! `StorageDriver` is the single abstraction the core uses. The M1 implementation is
//! `OpendalDriver`, backed by Apache OpenDAL services:
//! - `fs`     local directory
//! - `s3`     any S3-compatible object store (AWS / MinIO / R2 / OSS-S3 ...)
//! - `webdav` generic WebDAV — also the bridge to rclone (`rclone serve webdav`) and
//!   OpenList/AList (`/dav`), which covers drives OpenDAL lacks (115, PikPak, Aliyun ...).
pub mod drivers;

use async_trait::async_trait;
use bytes::Bytes;
use futures::{stream::BoxStream, StreamExt, TryStreamExt};
use opendal::{ErrorKind, Operator};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    /// Path relative to the mount root, no leading slash; dirs have no trailing slash.
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_unix: Option<i64>,
}

/// How file bytes reach the client.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransferMode {
    /// Redirect the client to the backend's direct link (presigned URL); error if none.
    Direct,
    /// Always stream through the DriveHub server.
    Proxy,
    /// Redirect when the driver offers a direct link, else proxy.
    #[default]
    Auto,
}

impl TransferMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "direct" => Some(Self::Direct),
            "proxy" => Some(Self::Proxy),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Proxy => "proxy",
            Self::Auto => "auto",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("invalid config: {0}")]
    Config(String),
    #[error("backend: {0}")]
    Backend(String),
}

impl From<opendal::Error> for StorageError {
    fn from(e: opendal::Error) -> Self {
        match e.kind() {
            ErrorKind::NotFound => StorageError::NotFound(e.to_string()),
            ErrorKind::AlreadyExists => StorageError::AlreadyExists(e.to_string()),
            ErrorKind::Unsupported => StorageError::Unsupported(e.to_string()),
            ErrorKind::ConfigInvalid => StorageError::Config(e.to_string()),
            _ => StorageError::Backend(e.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, StorageError>;
pub type ByteStream = BoxStream<'static, std::io::Result<Bytes>>;

/// Half-open byte range `[start, end)`; `end = None` means to EOF.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: Option<u64>,
}

#[async_trait]
pub trait StorageDriver: Send + Sync {
    fn kind(&self) -> &'static str;
    /// Lists direct children of a directory ("" = mount root).
    async fn list(&self, path: &str) -> Result<Vec<Entry>>;
    /// Lists every descendant (used by the indexer and cross-storage copy).
    async fn list_recursive(&self, path: &str) -> Result<Vec<Entry>>;
    async fn stat(&self, path: &str) -> Result<Entry>;
    async fn read(&self, path: &str, range: Option<ByteRange>) -> Result<ByteStream>;
    async fn write(&self, path: &str, data: Bytes) -> Result<()>;
    /// Streaming write; returns bytes written. `on_progress` gets the running total.
    async fn write_stream(
        &self,
        path: &str,
        data: ByteStream,
        on_progress: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<u64>;
    async fn mkdir(&self, path: &str) -> Result<()>;
    async fn rename(&self, from: &str, to: &str) -> Result<()>;
    /// Move within the same storage; falls back to copy+delete when rename is unsupported.
    async fn r#move(&self, from: &str, to: &str) -> Result<()>;
    async fn copy(&self, from: &str, to: &str) -> Result<()>;
    /// Deletes a file or a directory recursively.
    async fn delete(&self, path: &str) -> Result<()>;
    /// Direct (presigned) link if the backend supports one.
    async fn link(&self, path: &str, expire: Duration) -> Result<Option<String>>;
}

/// Normalizes a mount-relative path: strips leading/trailing slashes, rejects `..`.
pub fn norm(path: &str) -> Result<String> {
    let mut parts = Vec::new();
    for p in path.split('/') {
        match p {
            "" | "." => {}
            ".." => return Err(StorageError::Config("'..' not allowed in path".into())),
            p => parts.push(p),
        }
    }
    Ok(parts.join("/"))
}

fn dir_key(p: &str) -> String {
    if p.is_empty() {
        "/".into()
    } else {
        format!("{p}/")
    }
}

fn unix(m: &opendal::Metadata) -> Option<i64> {
    m.last_modified().and_then(|t| {
        SystemTime::from(t)
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs() as i64)
    })
}

fn to_entry(path: &str, m: &opendal::Metadata) -> Entry {
    let clean = path.trim_matches('/').to_string();
    let name = clean.rsplit('/').next().unwrap_or("").to_string();
    Entry {
        path: clean,
        name,
        is_dir: m.is_dir(),
        size: if m.is_dir() { 0 } else { m.content_length() },
        modified_unix: unix(m),
    }
}

pub struct OpendalDriver {
    kind: &'static str,
    op: Operator,
}

impl OpendalDriver {
    pub fn new(kind: &'static str, op: Operator) -> Self {
        Self { kind, op }
    }
    pub fn operator(&self) -> &Operator {
        &self.op
    }
}

/// Builds a driver from a kind + string options (as stored in the mounts table).
///
/// - fs:     root
/// - s3:     bucket, endpoint, region, access_key_id, secret_access_key, root
/// - webdav: endpoint, username, password, token, root
pub fn build_driver(kind: &str, opts: &HashMap<String, String>) -> Result<Box<dyn StorageDriver>> {
    let get = |k: &str| opts.get(k).map(|s| s.as_str()).filter(|s| !s.is_empty());
    let need =
        |k: &str| get(k).ok_or_else(|| StorageError::Config(format!("{kind}: missing '{k}'")));
    match kind {
        "fs" => {
            let root = need("root")?;
            std::fs::create_dir_all(root).map_err(|e| StorageError::Config(e.to_string()))?;
            let b = opendal::services::Fs::default().root(root);
            Ok(Box::new(OpendalDriver::new("fs", Operator::new(b)?)))
        }
        "s3" => {
            let mut b = opendal::services::S3::default()
                .bucket(need("bucket")?)
                .region(get("region").unwrap_or("us-east-1"));
            if let Some(v) = get("endpoint") {
                b = b.endpoint(v);
            }
            if let Some(v) = get("access_key_id") {
                b = b.access_key_id(v);
            }
            if let Some(v) = get("secret_access_key") {
                b = b.secret_access_key(v);
            }
            if let Some(v) = get("root") {
                b = b.root(v);
            }
            b = b.disable_config_load().disable_ec2_metadata();
            Ok(Box::new(OpendalDriver::new("s3", Operator::new(b)?)))
        }
        "webdav" => {
            let mut b = opendal::services::Webdav::default().endpoint(need("endpoint")?);
            if let Some(v) = get("username") {
                b = b.username(v);
            }
            if let Some(v) = get("password") {
                b = b.password(v);
            }
            if let Some(v) = get("token") {
                b = b.token(v);
            }
            if let Some(v) = get("root") {
                b = b.root(v);
            }
            Ok(Box::new(OpendalDriver::new("webdav", Operator::new(b)?)))
        }
        "p115" | "115" => Ok(Box::new(drivers::p115::P115Driver::new(opts)?)),
        "pikpak" => Ok(Box::new(drivers::pikpak::PikPakDriver::new(opts)?)),
        other => Err(StorageError::Unsupported(format!(
            "storage kind '{other}' (supported: fs, s3, webdav; onedrive/gdrive/115/pikpak via rclone/OpenList webdav bridge)"
        ))),
    }
}

#[async_trait]
impl StorageDriver for OpendalDriver {
    fn kind(&self) -> &'static str {
        self.kind
    }

    async fn list(&self, path: &str) -> Result<Vec<Entry>> {
        let p = norm(path)?;
        let key = dir_key(&p);
        let mut out = Vec::new();
        for e in self.op.list(&key).await? {
            let ep = e.path().trim_matches('/');
            if ep == p || ep.is_empty() {
                continue; // OpenDAL may include the directory itself
            }
            let meta = if e.metadata().is_file() && e.metadata().content_length() == 0 {
                // some services omit size in listings
                self.op
                    .stat(e.path())
                    .await
                    .unwrap_or_else(|_| e.metadata().clone())
            } else {
                e.metadata().clone()
            };
            out.push(to_entry(e.path(), &meta));
        }
        Ok(out)
    }

    async fn list_recursive(&self, path: &str) -> Result<Vec<Entry>> {
        let p = norm(path)?;
        let mut out = Vec::new();
        let mut l = self.op.lister_with(&dir_key(&p)).recursive(true).await?;
        while let Some(e) = l.try_next().await? {
            let ep = e.path().trim_matches('/');
            if ep == p || ep.is_empty() {
                continue;
            }
            out.push(to_entry(e.path(), e.metadata()));
        }
        Ok(out)
    }

    async fn stat(&self, path: &str) -> Result<Entry> {
        let p = norm(path)?;
        if p.is_empty() {
            return Ok(Entry {
                path: String::new(),
                name: String::new(),
                is_dir: true,
                size: 0,
                modified_unix: None,
            });
        }
        match self.op.stat(&p).await {
            Ok(m) => Ok(to_entry(&p, &m)),
            Err(e) if e.kind() == ErrorKind::NotFound => {
                let m = self.op.stat(&dir_key(&p)).await?;
                Ok(to_entry(&p, &m))
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn read(&self, path: &str, range: Option<ByteRange>) -> Result<ByteStream> {
        let p = norm(path)?;
        let r = self.op.reader(&p).await?;
        let s = match range {
            None => r.into_bytes_stream(..).await?,
            Some(ByteRange { start, end: None }) => r.into_bytes_stream(start..).await?,
            Some(ByteRange {
                start,
                end: Some(e),
            }) => r.into_bytes_stream(start..e).await?,
        };
        Ok(s.boxed())
    }

    async fn write(&self, path: &str, data: Bytes) -> Result<()> {
        self.op.write(&norm(path)?, data).await?;
        Ok(())
    }

    async fn write_stream(
        &self,
        path: &str,
        mut data: ByteStream,
        on_progress: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<u64> {
        let path = norm(path)?;
        if !self.op.info().capability().write_can_multi {
            // e.g. WebDAV: one-shot PUT only — buffer then write once
            let mut buf = Vec::new();
            while let Some(chunk) = data.next().await {
                let chunk = chunk.map_err(|e| StorageError::Backend(e.to_string()))?;
                buf.extend_from_slice(&chunk);
                on_progress(buf.len() as u64);
            }
            let n = buf.len() as u64;
            self.op.write(&path, buf).await?;
            return Ok(n);
        }
        let mut w = self.op.writer(&path).await?;
        let mut total = 0u64;
        while let Some(chunk) = data.next().await {
            let chunk = chunk.map_err(|e| StorageError::Backend(e.to_string()))?;
            total += chunk.len() as u64;
            w.write(chunk).await?;
            on_progress(total);
        }
        w.close().await?;
        Ok(total)
    }

    async fn mkdir(&self, path: &str) -> Result<()> {
        self.op.create_dir(&dir_key(&norm(path)?)).await?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let (f, t) = (norm(from)?, norm(to)?);
        if self.stat(&f).await?.is_dir {
            // object stores have no dir rename: copy tree then delete
            self.copy(&f, &t).await?;
            return self.delete(&f).await;
        }
        match self.op.rename(&f, &t).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::Unsupported => {
                self.op.copy(&f, &t).await?;
                self.op.delete(&f).await?;
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn r#move(&self, from: &str, to: &str) -> Result<()> {
        self.rename(from, to).await
    }

    async fn copy(&self, from: &str, to: &str) -> Result<()> {
        let (f, t) = (norm(from)?, norm(to)?);
        let st = self.stat(&f).await?;
        if !st.is_dir {
            return match self.op.copy(&f, &t).await {
                Ok(_) => Ok(()),
                Err(e) if e.kind() == ErrorKind::Unsupported => {
                    let bs = self.op.read(&f).await?;
                    self.op.write(&t, bs).await?;
                    Ok(())
                }
                Err(e) => Err(e.into()),
            };
        }
        self.mkdir(&t).await?;
        for e in self.list_recursive(&f).await? {
            let rel = e
                .path
                .strip_prefix(&f)
                .unwrap_or(&e.path)
                .trim_start_matches('/');
            let dst = format!("{t}/{rel}");
            if e.is_dir {
                self.mkdir(&dst).await?;
            } else {
                match self.op.copy(&e.path, &dst).await {
                    Ok(_) => {}
                    Err(err) if err.kind() == ErrorKind::Unsupported => {
                        let bs = self.op.read(&e.path).await?;
                        self.op.write(&dst, bs).await?;
                    }
                    Err(err) => return Err(err.into()),
                }
            }
        }
        Ok(())
    }

    async fn delete(&self, path: &str) -> Result<()> {
        let p = norm(path)?;
        if p.is_empty() {
            return Err(StorageError::Config("refusing to delete mount root".into()));
        }
        if self.stat(&p).await?.is_dir {
            self.op.delete_with(&dir_key(&p)).recursive(true).await?;
        } else {
            self.op.delete(&p).await?;
        }
        Ok(())
    }

    async fn link(&self, path: &str, expire: Duration) -> Result<Option<String>> {
        if !self.op.info().capability().presign_read {
            return Ok(None);
        }
        let req = self.op.presign_read(&norm(path)?, expire).await?;
        Ok(Some(req.uri().to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs_driver() -> (tempfile::TempDir, Box<dyn StorageDriver>) {
        let dir = tempfile::tempdir().unwrap();
        let opts = HashMap::from([("root".to_string(), dir.path().display().to_string())]);
        (dir, build_driver("fs", &opts).unwrap())
    }

    async fn collect(s: ByteStream) -> Vec<u8> {
        let v: Vec<Bytes> = s.try_collect().await.unwrap();
        v.concat()
    }

    #[test]
    fn norm_rejects_parent() {
        assert_eq!(norm("/a//b/").unwrap(), "a/b");
        assert!(norm("a/../b").is_err());
    }

    #[test]
    fn unknown_kind_and_missing_opts() {
        assert!(build_driver("ftpx", &HashMap::new()).is_err());
        assert!(build_driver("s3", &HashMap::new()).is_err());
        assert!(build_driver("webdav", &HashMap::new()).is_err());
    }

    #[test]
    fn s3_and_webdav_config_builds() {
        let s3 = HashMap::from([
            ("bucket".into(), "b".into()),
            ("endpoint".into(), "http://127.0.0.1:9000".into()),
            ("access_key_id".into(), "k".into()),
            ("secret_access_key".into(), "s".into()),
        ]);
        assert_eq!(build_driver("s3", &s3).unwrap().kind(), "s3");
        let dav = HashMap::from([("endpoint".into(), "http://127.0.0.1:5005".into())]);
        assert_eq!(build_driver("webdav", &dav).unwrap().kind(), "webdav");
    }

    #[tokio::test]
    async fn fs_full_cycle() {
        let (_d, drv) = fs_driver();
        drv.mkdir("docs").await.unwrap();
        drv.write("docs/a.txt", Bytes::from_static(b"hello world"))
            .await
            .unwrap();
        let st = drv.stat("docs/a.txt").await.unwrap();
        assert_eq!((st.size, st.is_dir, st.name.as_str()), (11, false, "a.txt"));
        assert!(drv.stat("docs").await.unwrap().is_dir);
        let ls = drv.list("docs").await.unwrap();
        assert_eq!(ls.len(), 1);
        assert_eq!(ls[0].path, "docs/a.txt");
        let part = collect(
            drv.read(
                "docs/a.txt",
                Some(ByteRange {
                    start: 6,
                    end: Some(11),
                }),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(part, b"world");
        let tail = collect(
            drv.read(
                "docs/a.txt",
                Some(ByteRange {
                    start: 6,
                    end: None,
                }),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(tail, b"world");
        drv.copy("docs/a.txt", "docs/b.txt").await.unwrap();
        drv.rename("docs/b.txt", "docs/c.txt").await.unwrap();
        drv.r#move("docs/c.txt", "moved.txt").await.unwrap();
        assert!(drv.stat("docs/c.txt").await.is_err());
        assert_eq!(
            collect(drv.read("moved.txt", None).await.unwrap()).await,
            b"hello world"
        );
        drv.copy("docs", "docs2").await.unwrap();
        assert_eq!(drv.list("docs2").await.unwrap().len(), 1);
        drv.rename("docs2", "docs3").await.unwrap();
        assert!(drv.stat("docs2").await.is_err());
        let rec = drv.list_recursive("").await.unwrap();
        assert!(rec.iter().any(|e| e.path == "docs3/a.txt"));
        drv.delete("docs3").await.unwrap();
        assert!(drv.stat("docs3").await.is_err());
        assert!(drv.delete("").await.is_err());
        assert_eq!(
            drv.link("moved.txt", Duration::from_secs(60))
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn fs_write_stream_reports_progress() {
        let (_d, drv) = fs_driver();
        let chunks: Vec<std::io::Result<Bytes>> = vec![
            Ok(Bytes::from_static(b"abc")),
            Ok(Bytes::from_static(b"de")),
        ];
        let seen = std::sync::Mutex::new(Vec::new());
        let n = drv
            .write_stream("s.bin", futures::stream::iter(chunks).boxed(), &|t| {
                seen.lock().unwrap().push(t)
            })
            .await
            .unwrap();
        assert_eq!(n, 5);
        assert_eq!(*seen.lock().unwrap(), vec![3, 5]);
    }

    /// Live S3 test; runs only when DRIVEHUB_TEST_S3_ENDPOINT is set (e.g. local MinIO).
    #[tokio::test]
    async fn s3_live_if_configured() {
        let Ok(ep) = std::env::var("DRIVEHUB_TEST_S3_ENDPOINT") else {
            return;
        };
        let opts = HashMap::from([
            (
                "bucket".to_string(),
                std::env::var("DRIVEHUB_TEST_S3_BUCKET").unwrap_or("drivehub".into()),
            ),
            ("endpoint".to_string(), ep),
            (
                "access_key_id".to_string(),
                std::env::var("DRIVEHUB_TEST_S3_KEY").unwrap(),
            ),
            (
                "secret_access_key".to_string(),
                std::env::var("DRIVEHUB_TEST_S3_SECRET").unwrap(),
            ),
        ]);
        let drv = build_driver("s3", &opts).unwrap();
        let chunks: Vec<std::io::Result<Bytes>> = vec![
            Ok(Bytes::from(vec![1u8; 6 << 20])),
            Ok(Bytes::from(vec![2u8; 1 << 20])),
        ];
        let n = drv
            .write_stream(
                "t/multi.bin",
                futures::stream::iter(chunks).boxed(),
                &|_| {},
            )
            .await
            .unwrap();
        assert_eq!(n, 7 << 20);
        assert_eq!(drv.stat("t/multi.bin").await.unwrap().size, 7 << 20);
        drv.write("t/x.txt", Bytes::from_static(b"0123456789"))
            .await
            .unwrap();
        assert_eq!(drv.stat("t/x.txt").await.unwrap().size, 10);
        let part = collect(
            drv.read(
                "t/x.txt",
                Some(ByteRange {
                    start: 2,
                    end: Some(5),
                }),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(part, b"234");
        assert!(drv
            .list("t")
            .await
            .unwrap()
            .iter()
            .any(|e| e.name == "x.txt"));
        drv.copy("t/x.txt", "t/y.txt").await.unwrap();
        drv.rename("t/y.txt", "t/z.txt").await.unwrap();
        assert!(drv
            .link("t/z.txt", Duration::from_secs(60))
            .await
            .unwrap()
            .is_some());
        drv.delete("t").await.unwrap();
    }

    /// Live WebDAV test (e.g. `rclone serve webdav`); runs only when DRIVEHUB_TEST_DAV_ENDPOINT is set.
    #[tokio::test]
    async fn webdav_live_if_configured() {
        let Ok(ep) = std::env::var("DRIVEHUB_TEST_DAV_ENDPOINT") else {
            return;
        };
        let drv = build_driver("webdav", &HashMap::from([("endpoint".to_string(), ep)])).unwrap();
        drv.mkdir("w").await.unwrap();
        let chunks: Vec<std::io::Result<Bytes>> = vec![
            Ok(Bytes::from(vec![1u8; 3 << 20])),
            Ok(Bytes::from(vec![2u8; 1 << 20])),
        ];
        let n = drv
            .write_stream(
                "w/multi.bin",
                futures::stream::iter(chunks).boxed(),
                &|_| {},
            )
            .await
            .unwrap();
        assert_eq!(n, 4 << 20);
        assert_eq!(drv.stat("w/multi.bin").await.unwrap().size, 4 << 20);
        drv.write("w/x.txt", Bytes::from_static(b"0123456789"))
            .await
            .unwrap();
        assert_eq!(drv.stat("w/x.txt").await.unwrap().size, 10);
        let part = collect(
            drv.read(
                "w/x.txt",
                Some(ByteRange {
                    start: 2,
                    end: Some(5),
                }),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(part, b"234");
        assert!(drv
            .list("w")
            .await
            .unwrap()
            .iter()
            .any(|e| e.name == "x.txt"));
        drv.copy("w/x.txt", "w/y.txt").await.unwrap();
        drv.rename("w/y.txt", "w/z.txt").await.unwrap();
        drv.delete("w").await.unwrap();
    }
}
