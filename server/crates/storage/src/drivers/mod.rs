//! Native cloud-drive drivers (DEPTAI-481), ported from OpenList (AGPL-3.0, see NOTICE).
pub mod p115;
pub mod pikpak;

use crate::{ByteStream, Result, StorageError};
use bytes::Bytes;
use futures::StreamExt;

/// Upload source: small payloads stay in memory, streamed uploads are spooled to a temp file.
pub(crate) enum Src {
    Mem(Bytes),
    File(std::path::PathBuf, u64),
}

impl Src {
    /// Spools a stream to a temp file (removed on drop) so huge uploads never sit in RAM.
    pub(crate) async fn spool(data: &mut ByteStream, tag: &str) -> Result<Src> {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let tmp = std::env::temp_dir().join(format!(
            "drivehub-{tag}-{}-{}.part",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let io = |e: std::io::Error| StorageError::Backend(format!("spool: {e}"));
        let f = std::sync::Arc::new(std::fs::File::create(&tmp).map_err(io)?);
        let mut src = Src::File(tmp, 0);
        let mut n = 0u64;
        while let Some(c) = data.next().await {
            let c = c.map_err(io)?;
            n += c.len() as u64;
            let f = f.clone();
            tokio::task::spawn_blocking(move || {
                use std::io::Write;
                (&*f).write_all(&c)
            })
            .await
            .map_err(std::io::Error::other)
            .and_then(|r| r)
            .map_err(io)?;
        }
        if let Src::File(_, len) = &mut src {
            *len = n;
        }
        Ok(src)
    }

    pub(crate) fn len(&self) -> u64 {
        match self {
            Src::Mem(b) => b.len() as u64,
            Src::File(_, n) => *n,
        }
    }
    pub(crate) async fn slice(&self, off: u64, len: u64) -> Result<Bytes> {
        match self {
            Src::Mem(b) => Ok(b.slice(off as usize..(off + len) as usize)),
            Src::File(p, _) => {
                let p = p.clone();
                tokio::task::spawn_blocking(move || {
                    use std::os::unix::fs::FileExt;
                    let f = std::fs::File::open(p)?;
                    let mut buf = vec![0u8; len as usize];
                    f.read_exact_at(&mut buf, off)?;
                    Ok::<_, std::io::Error>(Bytes::from(buf))
                })
                .await
                .map_err(std::io::Error::other)
                .and_then(|r| r)
                .map_err(|e| StorageError::Backend(format!("spool read: {e}")))
            }
        }
    }
}

impl Drop for Src {
    fn drop(&mut self) {
        if let Src::File(p, _) = self {
            let _ = std::fs::remove_file(p);
        }
    }
}
