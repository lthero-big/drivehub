//! Robust local-directory listing for the `fs` driver.
//!
//! OpenDAL's Fs lister calls `metadata()` on every dirent and aborts the whole
//! listing on any error other than NotFound. A stale FUSE / rclone mount in the
//! directory then surfaces as:
//! `Unexpected (temporary) at list ... path: / listed: N ... os error 107` (ENOTCONN).
//!
//! This walker keeps the rest of the directory: unreadable entries are still
//! returned (name + best-effort type) so the folder can be opened.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::{Entry, Result, StorageError};

/// I/O errors that should not fail a whole directory listing.
pub fn is_skippable_io(err: &std::io::Error) -> bool {
    match err.kind() {
        ErrorKind::NotFound
        | ErrorKind::PermissionDenied
        | ErrorKind::TimedOut
        | ErrorKind::Interrupted
        | ErrorKind::BrokenPipe
        | ErrorKind::ConnectionReset
        | ErrorKind::NotADirectory => true,
        _ => match err.raw_os_error() {
            // Linux: ENOTCONN, EIO, ESTALE, EPERM, ELOOP, ENXIO, ENODEV,
            // ETIMEDOUT, EHOSTDOWN, EHOSTUNREACH, ENETDOWN, ENETUNREACH.
            Some(1 | 5 | 6 | 19 | 40 | 100 | 101 | 107 | 110 | 112 | 113 | 116) => true,
            _ => false,
        },
    }
}

fn abs(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    if !rel.is_empty() {
        for part in rel.split('/') {
            if !part.is_empty() {
                p.push(part);
            }
        }
    }
    p
}

fn child_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn io_to_storage(context: &str, e: std::io::Error) -> StorageError {
    let msg = format!("{context}: {e}");
    match e.kind() {
        ErrorKind::NotFound => StorageError::NotFound(msg),
        ErrorKind::AlreadyExists => StorageError::AlreadyExists(msg),
        _ => StorageError::Backend(msg),
    }
}

fn modified_unix(m: &std::fs::Metadata) -> Option<i64> {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

fn entry_from_meta(rel: String, name: String, meta: &std::fs::Metadata) -> Entry {
    let is_dir = meta.is_dir();
    Entry {
        path: rel,
        name,
        is_dir,
        size: if is_dir { 0 } else { meta.len() },
        modified_unix: modified_unix(meta),
    }
}

fn fallback_entry(rel: String, name: String, ft: Option<std::fs::FileType>) -> Entry {
    Entry {
        path: rel,
        name,
        is_dir: ft.map(|t| t.is_dir()).unwrap_or(false),
        size: 0,
        modified_unix: None,
    }
}

/// Lists direct children of `rel` ("" = mount root). Never includes the directory itself.
pub async fn list_dir(root: &Path, rel: &str) -> Result<Vec<Entry>> {
    let dir = abs(root, rel);
    let mut rd = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| io_to_storage(&format!("list {}", dir.display()), e))?;
    let mut out = Vec::new();
    loop {
        let de = match rd.next_entry().await {
            Ok(Some(de)) => de,
            Ok(None) => break,
            Err(e) if is_skippable_io(&e) => {
                // The stream itself failed mid-way; return what we have.
                break;
            }
            Err(e) => return Err(io_to_storage(&format!("list {}", dir.display()), e)),
        };
        let os_name = de.file_name();
        let name = os_name.to_string_lossy();
        if name == "." || name == ".." {
            continue;
        }
        let rel_path = child_rel(rel, &name);
        let name = name.into_owned();
        match de.metadata().await {
            Ok(meta) => out.push(entry_from_meta(rel_path, name, &meta)),
            Err(e) if is_skippable_io(&e) => {
                let ft = de.file_type().await.ok();
                out.push(fallback_entry(rel_path, name, ft));
            }
            Err(e) => return Err(io_to_storage(&rel_path, e)),
        }
    }
    Ok(out)
}

/// Depth-first listing of every descendant. Unreadable subtrees are skipped.
pub async fn list_recursive(root: &Path, rel: &str) -> Result<Vec<Entry>> {
    let mut stack = vec![rel.to_string()];
    let mut out = Vec::new();
    let mut first = true;
    while let Some(dir) = stack.pop() {
        match list_dir(root, &dir).await {
            Ok(entries) => {
                for e in entries {
                    if e.is_dir {
                        stack.push(e.path.clone());
                    }
                    out.push(e);
                }
            }
            Err(e)
                if !first && matches!(e, StorageError::Backend(_) | StorageError::NotFound(_)) =>
            {
                // A child tree is a stale mount or vanished; skip it.
            }
            Err(e) => return Err(e),
        }
        first = false;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[test]
    fn skippable_io_recognizes_enotconn() {
        let e = std::io::Error::from_raw_os_error(107);
        assert!(is_skippable_io(&e), "ENOTCONN must be skippable");
        let eio = std::io::Error::from_raw_os_error(5);
        assert!(is_skippable_io(&eio));
        let estale = std::io::Error::from_raw_os_error(116);
        assert!(is_skippable_io(&estale));
        let other = std::io::Error::from_raw_os_error(28); // ENOSPC
        assert!(!is_skippable_io(&other));
    }

    #[tokio::test]
    async fn list_includes_broken_symlink_and_siblings() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("ok.txt"), b"hi").unwrap();
        symlink(tmp.path().join("missing-target"), tmp.path().join("broken")).unwrap();
        let entries = list_dir(tmp.path(), "").await.unwrap();
        let mut names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["broken", "ok.txt"]);
        let broken = entries.iter().find(|e| e.name == "broken").unwrap();
        assert!(!broken.is_dir);
    }

    #[tokio::test]
    async fn list_survives_stale_fuse_among_many_files() {
        let rclone = match Command::new("rclone").arg("version").output() {
            Ok(o) if o.status.success() => "rclone",
            _ => return, // environment without rclone: skip
        };
        let parent = tempfile::tempdir().unwrap();
        for i in 0..43 {
            fs::write(parent.path().join(format!("f{i:02}.txt")), b"x").unwrap();
        }
        let src = tempfile::tempdir().unwrap();
        fs::write(src.path().join("inside.txt"), b"y").unwrap();
        let mnt = parent.path().join("stale_mnt");
        fs::create_dir(&mnt).unwrap();

        let mut child = match Command::new(rclone)
            .arg("mount")
            .arg(format!(":local:{}", src.path().display()))
            .arg(&mnt)
            .arg("--daemon=false")
            .arg("--vfs-cache-mode")
            .arg("off")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        // Wait until the mount is actually a FUSE filesystem.
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        let mut mounted = false;
        while std::time::Instant::now() < deadline {
            if mnt.join("inside.txt").is_file() {
                mounted = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !mounted {
            let _ = child.kill();
            let _ = child.wait();
            let _ = Command::new("fusermount3")
                .args(["-u", "-z"])
                .arg(&mnt)
                .status();
            let _ = Command::new("fusermount")
                .args(["-u", "-z"])
                .arg(&mnt)
                .status();
            return;
        }

        // Drop the FUSE daemon so the mount point starts returning ENOTCONN.
        let _ = child.kill();
        let _ = child.wait();
        // Give the kernel a moment to mark the connection as closed.
        tokio::time::sleep(Duration::from_millis(200)).await;

        let result = list_dir(parent.path(), "").await;

        let _ = Command::new("fusermount3")
            .args(["-u", "-z"])
            .arg(&mnt)
            .status();
        let _ = Command::new("fusermount")
            .args(["-u", "-z"])
            .arg(&mnt)
            .status();

        let entries = result.expect("listing a dir that contains a stale FUSE mount must not fail");
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names
                .iter()
                .filter(|n| n.starts_with('f') && n.ends_with(".txt"))
                .count()
                == 43,
            "expected the 43 regular files to remain visible, got {names:?}"
        );
        // The stale mount should still appear (as a dir or unknown), not abort the list.
        assert!(
            names.contains(&"stale_mnt"),
            "stale mount point should still be listed, got {names:?}"
        );
    }
}
