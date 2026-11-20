//! Binary deployment mechanics: fetch + verify, atomic replace with `.bak`, database snapshot,
//! the on-disk "pending update" marker that lets the *new* process finish (health check) or
//! undo (rollback) the upgrade, and the in-place restart.
//!
//! Restart strategy: by default the server `exec`s the (new) executable in place — same PID,
//! so pm2 / systemd / a plain shell all keep tracking it and no supervisor configuration is
//! needed. `restart = "exit"` instead exits with code 75 for supervisors that restart on exit
//! (systemd `Restart=always`, pm2 autorestart, Docker `restart: unless-stopped`).
use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

/// Hard cap for any downloaded artifact.
pub const MAX_ARTIFACT_BYTES: u64 = 2 << 30;
pub const EXIT_RESTART: i32 = 75;
/// A new binary that keeps crashing before its health check is rolled back on this boot.
pub const MAX_BOOT_ATTEMPTS: u32 = 3;

/// Fetches a small document (manifest / signature): `http(s)://` or `file://`.
pub async fn fetch_small(http: &reqwest::Client, url: &str) -> anyhow::Result<Vec<u8>> {
    if let Some(p) = file_path(url) {
        return tokio::fs::read(&p)
            .await
            .with_context(|| format!("read {}", p.display()));
    }
    let r = http
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !r.status().is_success() {
        bail!("GET {url}: HTTP {}", r.status());
    }
    let b = r.bytes().await?;
    if b.len() > 4 << 20 {
        bail!("{url}: document too large");
    }
    Ok(b.to_vec())
}

fn file_path(url: &str) -> Option<PathBuf> {
    url::Url::parse(url)
        .ok()
        .filter(|u| u.scheme() == "file")
        .and_then(|u| u.to_file_path().ok())
}

/// Resolves an artifact URL relative to the manifest URL.
pub fn resolve(base: &str, rel: &str) -> anyhow::Result<String> {
    if url::Url::parse(rel).is_ok() {
        return Ok(rel.to_string());
    }
    Ok(url::Url::parse(base)
        .context("bad manifest url")?
        .join(rel)
        .context("bad artifact url")?
        .to_string())
}

/// Streams `url` into `dest`, reporting progress, enforcing `expect_size`, and returning the
/// SHA-256 of what was written.
pub async fn download(
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    expect_size: u64,
    mut progress: impl FnMut(u64),
) -> anyhow::Result<String> {
    let limit = if expect_size > 0 {
        expect_size
    } else {
        MAX_ARTIFACT_BYTES
    };
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut f = tokio::fs::File::create(dest).await?;
    let mut h = Sha256::new();
    let mut n: u64 = 0;
    let mut push = |chunk: &[u8], f_n: &mut u64| -> anyhow::Result<()> {
        *f_n += chunk.len() as u64;
        if *f_n > limit {
            bail!("artifact larger than its declared size ({limit} bytes)");
        }
        h.update(chunk);
        Ok(())
    };
    if let Some(p) = file_path(url) {
        let mut src = tokio::fs::File::open(&p)
            .await
            .with_context(|| format!("open {}", p.display()))?;
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let k = tokio::io::AsyncReadExt::read(&mut src, &mut buf).await?;
            if k == 0 {
                break;
            }
            push(&buf[..k], &mut n)?;
            f.write_all(&buf[..k]).await?;
            progress(n);
        }
    } else {
        let mut r = http
            .get(url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if !r.status().is_success() {
            bail!("GET {url}: HTTP {}", r.status());
        }
        while let Some(chunk) = r.chunk().await? {
            push(&chunk, &mut n)?;
            f.write_all(&chunk).await?;
            progress(n);
        }
    }
    f.flush().await?;
    f.sync_all().await?;
    if expect_size > 0 && n != expect_size {
        bail!("size mismatch: got {n} bytes, manifest says {expect_size}");
    }
    Ok(crate::update::manifest::hex(&h.finalize()))
}

/// Download + SHA-256 check; the file is removed when the hash does not match.
pub async fn download_verified(
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    sha256: &str,
    size: u64,
    progress: impl FnMut(u64),
) -> anyhow::Result<()> {
    let got = match download(http, url, dest, size, progress).await {
        Ok(h) => h,
        Err(e) => {
            let _ = tokio::fs::remove_file(dest).await;
            return Err(e);
        }
    };
    if !got.eq_ignore_ascii_case(sha256) {
        let _ = tokio::fs::remove_file(dest).await;
        bail!("sha256 mismatch: expected {sha256}, got {got} (corrupt or tampered package)");
    }
    Ok(())
}

/// SHA-256 of a file on disk.
pub fn file_sha256(p: &Path) -> anyhow::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h)?;
    Ok(crate::update::manifest::hex(&h.finalize()))
}

/// Runs `<exe> version` and returns the reported server version (pre-flight: the staged
/// binary must start on this host and identify as the release we expect).
pub async fn probe_version(exe: &Path) -> anyhow::Result<String> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        tokio::process::Command::new(exe)
            .arg("version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| anyhow!("new binary did not answer `version` within 20s"))?
    .with_context(|| format!("cannot execute {}", exe.display()))?;
    if !out.status.success() {
        bail!(
            "new binary `version` failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| anyhow!("new binary printed no version JSON"))?;
    v["server_version"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| anyhow!("new binary printed no server_version"))
}

#[cfg(unix)]
fn make_executable(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))
}
#[cfg(not(unix))]
fn make_executable(_: &Path) -> std::io::Result<()> {
    Ok(())
}

pub fn chmod_x(p: &Path) -> anyhow::Result<()> {
    make_executable(p).with_context(|| format!("chmod {}", p.display()))
}

fn sibling(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

pub fn backup_path(exe: &Path) -> PathBuf {
    sibling(exe, ".bak")
}

/// Copies `src` next to `dst` and renames it over `dst` (atomic on the same filesystem).
pub fn atomic_install(src: &Path, dst: &Path) -> anyhow::Result<()> {
    let tmp = sibling(dst, ".new");
    std::fs::copy(src, &tmp).with_context(|| format!("copy to {}", tmp.display()))?;
    chmod_x(&tmp)?;
    std::fs::File::open(&tmp)?.sync_all()?;
    std::fs::rename(&tmp, dst).with_context(|| format!("rename onto {}", dst.display()))?;
    if let Some(d) = dst.parent() {
        if let Ok(f) = std::fs::File::open(d) {
            let _ = f.sync_all();
        }
    }
    Ok(())
}

/// Keeps the previous executable as `<exe>.bak`, then atomically swaps in `new`.
pub fn swap_binary(new: &Path, exe: &Path) -> anyhow::Result<PathBuf> {
    let bak = backup_path(exe);
    atomic_install(exe, &bak).context("saving previous version as .bak")?;
    atomic_install(new, exe)?;
    Ok(bak)
}

/// Replaces `web_dir` with `new_dir`, keeping the previous bundle as `<web_dir>.bak`.
pub fn swap_dir(new_dir: &Path, web_dir: &Path) -> anyhow::Result<PathBuf> {
    let bak = sibling(web_dir, ".bak");
    if bak.exists() {
        std::fs::remove_dir_all(&bak)?;
    }
    if web_dir.exists() {
        std::fs::rename(web_dir, &bak).context("moving current web bundle to .bak")?;
    }
    if let Err(e) = std::fs::rename(new_dir, web_dir) {
        let _ = std::fs::rename(&bak, web_dir);
        return Err(e).context("installing new web bundle");
    }
    Ok(bak)
}

/// Unpacks a `.tar.gz` web bundle into `dest` (entries escaping `dest` are refused by tar).
pub fn unpack_tar_gz(archive: &Path, dest: &Path) -> anyhow::Result<()> {
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }
    std::fs::create_dir_all(dest)?;
    let f = std::fs::File::open(archive)?;
    let mut a = tar::Archive::new(flate2::read::GzDecoder::new(f));
    a.set_preserve_permissions(false);
    for e in a.entries()? {
        let mut e = e?;
        if !e.unpack_in(dest)? {
            bail!("web bundle entry escapes the target directory");
        }
    }
    if !dest.join("index.html").exists() {
        bail!("web bundle has no index.html");
    }
    Ok(())
}

/// SQLite file behind a `sqlite://` URL (None for in-memory databases).
pub fn sqlite_file(url: &str) -> Option<PathBuf> {
    let rest = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))?;
    let path = rest.split('?').next()?;
    if path.is_empty() || path.contains(":memory:") {
        return None;
    }
    Some(PathBuf::from(path))
}

/// Restores a database snapshot over `db` (connections must be closed).
pub fn restore_db(backup: &Path, db: &Path) -> anyhow::Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(sibling(db, suffix));
    }
    let tmp = sibling(db, ".restore");
    std::fs::copy(backup, &tmp).context("copy db backup")?;
    std::fs::rename(&tmp, db).context("restore db backup")?;
    Ok(())
}

/// On-disk marker written right before the restart into a new version.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Pending {
    /// restarting (new version booting) | rolled_back (old version restored)
    pub state: String,
    pub from_version: String,
    pub to_version: String,
    pub exe_path: PathBuf,
    pub exe_backup: PathBuf,
    pub db_path: Option<PathBuf>,
    pub db_backup: Option<PathBuf>,
    pub web_dir: Option<PathBuf>,
    pub web_backup: Option<PathBuf>,
    pub boot_attempts: u32,
    pub started_at: i64,
    pub actor: String,
    pub restart: String,
    pub error: Option<String>,
    /// Audit records of this attempt. A rollback restores the pre-update database snapshot,
    /// which would erase them, so the restored process replays the journal into the log.
    #[serde(default)]
    pub journal: Vec<JournalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct JournalEntry {
    pub ts: i64,
    pub action: String,
    pub allowed: bool,
    pub detail: String,
}

impl Pending {
    pub fn note(&mut self, action: &str, allowed: bool, detail: &str) {
        self.journal.push(JournalEntry {
            ts: crate::auth::now(),
            action: action.into(),
            allowed,
            detail: detail.into(),
        });
    }
}

pub fn pending_path(data_dir: &Path) -> PathBuf {
    data_dir.join("update").join("pending.json")
}

impl Pending {
    pub fn load(data_dir: &Path) -> Option<Self> {
        let s = std::fs::read(pending_path(data_dir)).ok()?;
        serde_json::from_slice(&s).ok()
    }
    pub fn save(&self, data_dir: &Path) -> anyhow::Result<()> {
        let p = pending_path(data_dir);
        std::fs::create_dir_all(p.parent().unwrap())?;
        let tmp = sibling(&p, ".tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, p)?;
        Ok(())
    }
    pub fn clear(data_dir: &Path) {
        let _ = std::fs::remove_file(pending_path(data_dir));
    }

    /// Puts the previous executable, database snapshot and web bundle back. Database
    /// connections must already be closed.
    pub fn rollback_files(&self) -> anyhow::Result<()> {
        let mut errs = vec![];
        if self.exe_backup.exists() {
            if let Err(e) = atomic_install(&self.exe_backup, &self.exe_path) {
                errs.push(format!("binary: {e:#}"));
            }
        } else {
            errs.push("binary: .bak missing".into());
        }
        if let (Some(b), Some(db)) = (&self.db_backup, &self.db_path) {
            if let Err(e) = restore_db(b, db) {
                errs.push(format!("database: {e:#}"));
            }
        }
        if let (Some(b), Some(w)) = (&self.web_backup, &self.web_dir) {
            if b.exists() {
                let failed = sibling(w, ".failed");
                let _ = std::fs::remove_dir_all(&failed);
                let _ = std::fs::rename(w, &failed);
                if let Err(e) = std::fs::rename(b, w) {
                    errs.push(format!("web: {e}"));
                }
            }
        }
        if errs.is_empty() {
            Ok(())
        } else {
            Err(anyhow!(errs.join("; ")))
        }
    }

    /// Rolls back, records why, and restarts into the restored executable.
    pub fn rollback_and_restart(mut self, data_dir: &Path, reason: &str) -> ! {
        tracing::error!(from = %self.to_version, to = %self.from_version, %reason, "update failed, rolling back");
        self.note("update_rollback", false, reason);
        let res = self.rollback_files();
        self.state = "rolled_back".into();
        self.error = Some(match &res {
            Ok(()) => reason.to_string(),
            Err(e) => format!("{reason}; rollback problems: {e}"),
        });
        if let Err(e) = self.save(data_dir) {
            tracing::error!(error = %e, "cannot write update marker");
        }
        restart(&self.exe_path, &self.restart)
    }
}

/// Replaces the process with `exe` (same PID, same args / env) or exits for the supervisor.
pub fn restart(exe: &Path, mode: &str) -> ! {
    if mode == "exit" {
        tracing::warn!("exiting with code {EXIT_RESTART} for the supervisor to restart us");
        std::process::exit(EXIT_RESTART);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        tracing::warn!(exe = %exe.display(), "re-executing");
        let err = std::process::Command::new(exe).args(args).exec();
        tracing::error!(error = %err, "exec failed; exiting for the supervisor");
    }
    std::process::exit(EXIT_RESTART)
}

/// Inside the `[start, end)` UTC maintenance window ("HH:MM"); wraps past midnight.
/// No window configured = always allowed.
pub fn in_window(now_minute_of_day: u32, start: Option<&str>, end: Option<&str>) -> bool {
    fn parse(s: &str) -> Option<u32> {
        let (h, m) = s.trim().split_once(':')?;
        let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
        (h < 24 && m < 60).then_some(h * 60 + m)
    }
    let (Some(s), Some(e)) = (start.and_then(parse), end.and_then(parse)) else {
        return true;
    };
    if s == e {
        return true;
    }
    if s < e {
        (s..e).contains(&now_minute_of_day)
    } else {
        now_minute_of_day >= s || now_minute_of_day < e
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_logic() {
        assert!(in_window(100, None, None));
        assert!(in_window(150, Some("02:00"), Some("03:00")));
        assert!(!in_window(180, Some("02:00"), Some("03:00")));
        assert!(in_window(23 * 60 + 30, Some("23:00"), Some("01:00")));
        assert!(in_window(30, Some("23:00"), Some("01:00")));
        assert!(!in_window(120, Some("23:00"), Some("01:00")));
        assert!(in_window(5, Some("bad"), Some("01:00")));
    }

    #[test]
    fn sqlite_paths() {
        assert_eq!(
            sqlite_file("sqlite:///x/drivehub.db?mode=rwc"),
            Some(PathBuf::from("/x/drivehub.db"))
        );
        assert_eq!(sqlite_file("sqlite::memory:"), None);
        assert_eq!(sqlite_file("postgres://x"), None);
    }

    #[test]
    fn resolve_relative_urls() {
        assert_eq!(
            resolve(
                "http://h/rel/v1/release-manifest.json",
                "drivehub-linux-amd64"
            )
            .unwrap(),
            "http://h/rel/v1/drivehub-linux-amd64"
        );
        assert_eq!(
            resolve("http://h/m.json", "https://cdn/x").unwrap(),
            "https://cdn/x"
        );
        assert_eq!(
            resolve("file:///srv/rel/m.json", "a.bin").unwrap(),
            "file:///srv/rel/a.bin"
        );
    }

    #[tokio::test]
    async fn swap_and_rollback_files() {
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("drivehub");
        std::fs::write(&exe, "old").unwrap();
        let new = d.path().join("staged");
        std::fs::write(&new, "new").unwrap();
        let bak = swap_binary(&new, &exe).unwrap();
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), "old");
        let db = d.path().join("db");
        std::fs::write(&db, "migrated").unwrap();
        std::fs::write(sibling(&db, "-wal"), "wal").unwrap();
        let dbb = d.path().join("db.backup");
        std::fs::write(&dbb, "snapshot").unwrap();
        let web = d.path().join("web");
        std::fs::create_dir(&web).unwrap();
        std::fs::write(web.join("index.html"), "old").unwrap();
        let web_new = d.path().join("web.new");
        std::fs::create_dir(&web_new).unwrap();
        std::fs::write(web_new.join("index.html"), "new").unwrap();
        let wbak = swap_dir(&web_new, &web).unwrap();
        assert_eq!(
            std::fs::read_to_string(web.join("index.html")).unwrap(),
            "new"
        );
        let p = Pending {
            state: "restarting".into(),
            exe_path: exe.clone(),
            exe_backup: bak,
            db_path: Some(db.clone()),
            db_backup: Some(dbb),
            web_dir: Some(web.clone()),
            web_backup: Some(wbak),
            ..Default::default()
        };
        p.save(d.path()).unwrap();
        assert_eq!(Pending::load(d.path()).unwrap(), p);
        p.rollback_files().unwrap();
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(&db).unwrap(), "snapshot");
        assert!(!sibling(&db, "-wal").exists());
        assert_eq!(
            std::fs::read_to_string(web.join("index.html")).unwrap(),
            "old"
        );
    }

    #[tokio::test]
    async fn download_checks_size_and_hash() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("a.bin");
        std::fs::write(&src, b"hello").unwrap();
        let url = url::Url::from_file_path(&src).unwrap().to_string();
        let http = reqwest::Client::new();
        let dst = d.path().join("out/a.bin");
        let good = crate::update::manifest::sha256_hex(b"hello");
        download_verified(&http, &url, &dst, &good, 5, |_| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"hello");
        let e = download_verified(&http, &url, &dst, &"0".repeat(64), 5, |_| {})
            .await
            .unwrap_err();
        assert!(e.to_string().contains("sha256 mismatch"));
        assert!(!dst.exists(), "corrupt download must be removed");
        let e = download_verified(&http, &url, &dst, &good, 3, |_| {})
            .await
            .unwrap_err();
        assert!(e.to_string().contains("larger than"), "{e}");
    }

    #[test]
    fn web_bundle_unpack() {
        let d = tempfile::tempdir().unwrap();
        let tgz = d.path().join("web.tar.gz");
        {
            let f = std::fs::File::create(&tgz).unwrap();
            let mut b = tar::Builder::new(flate2::write::GzEncoder::new(
                f,
                flate2::Compression::fast(),
            ));
            let mut h = tar::Header::new_gnu();
            h.set_size(2);
            h.set_mode(0o644);
            h.set_cksum();
            b.append_data(&mut h, "index.html", &b"hi"[..]).unwrap();
            b.into_inner().unwrap().finish().unwrap();
        }
        let out = d.path().join("w");
        unpack_tar_gz(&tgz, &out).unwrap();
        assert_eq!(
            std::fs::read_to_string(out.join("index.html")).unwrap(),
            "hi"
        );
    }
}
