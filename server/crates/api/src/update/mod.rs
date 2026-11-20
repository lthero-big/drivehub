//! Auto-update (DEPTAI-484): signed release manifest, background / manual checks, update
//! modes (notify / download / install within a maintenance window), binary self-update with
//! DB snapshot + `.bak` + post-restart health check + automatic rollback, Docker handling,
//! notifications (via the audit alert sinks) and audit records for every step.
pub mod cli;
pub mod docker;
pub mod install;
pub mod manifest;

use crate::audit::{AlertRule, AuditEvent, AuditLog};
use crate::auth::{now, Auth};
use crate::settings::{get_meta, set_meta};
use anyhow::{anyhow, bail, Context};
use drivehub_core::config::UpdateConfig;
use drivehub_core::version::{is_newer, server_version, VersionInfo};
use install::Pending;
use manifest::Manifest;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::watch;
use utoipa::ToSchema;

const META_SETTINGS: &str = "update.settings";
const META_LAST_CHECK: &str = "update.last_check";
const KEEP_DB_BACKUPS: usize = 3;

/// Admin-editable update settings (stored in `meta`); empty / 0 = use the server config.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(default)]
pub struct UpdateSettings {
    /// Periodic background checks (manual checks still work when off).
    pub auto_check: bool,
    /// notify | download | install
    pub mode: String,
    /// Manifest URL override ("" = config / GitHub Releases default).
    pub source_url: String,
    /// stable | beta ("" = config default).
    pub channel: String,
    /// Check interval override in seconds (0 = config default, minimum 60).
    pub interval_secs: u64,
    /// Maintenance window for automatic installs, "HH:MM" UTC (both empty = any time).
    pub window_start: String,
    pub window_end: String,
    /// Notify this webhook URL about available / installed / rolled back updates.
    pub notify_webhook: String,
    /// Notify this e-mail address (uses the server mailer).
    pub notify_email: String,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_check: true,
            mode: "notify".into(),
            source_url: String::new(),
            channel: String::new(),
            interval_secs: 0,
            window_start: String::new(),
            window_end: String::new(),
            notify_webhook: String::new(),
            notify_email: String::new(),
        }
    }
}

impl UpdateSettings {
    pub fn validate(&self) -> anyhow::Result<()> {
        if !matches!(self.mode.as_str(), "notify" | "download" | "install") {
            bail!("mode must be notify, download or install");
        }
        if !matches!(self.channel.as_str(), "" | "stable" | "beta") {
            bail!("channel must be stable or beta");
        }
        if !self.source_url.is_empty() {
            let u = url::Url::parse(&self.source_url).context("source_url is not a URL")?;
            if !matches!(u.scheme(), "http" | "https" | "file") {
                bail!("source_url must be http(s):// or file://");
            }
        }
        if self.interval_secs != 0 && self.interval_secs < 60 {
            bail!("interval_secs must be at least 60");
        }
        let hhmm = |s: &str| {
            s.is_empty()
                || s.split_once(':').is_some_and(|(h, m)| {
                    h.parse::<u32>().is_ok_and(|h| h < 24) && m.parse::<u32>().is_ok_and(|m| m < 60)
                })
        };
        if !hhmm(&self.window_start) || !hhmm(&self.window_end) {
            bail!("maintenance window must be HH:MM");
        }
        if self.window_start.is_empty() != self.window_end.is_empty() {
            bail!("set both window_start and window_end (or neither)");
        }
        if !self.notify_webhook.is_empty() {
            let u = url::Url::parse(&self.notify_webhook).context("notify_webhook is not a URL")?;
            if !matches!(u.scheme(), "http" | "https") {
                bail!("notify_webhook must be http(s)");
            }
        }
        if !self.notify_email.is_empty() && !self.notify_email.contains('@') {
            bail!("notify_email is not an e-mail address");
        }
        Ok(())
    }
}

/// Result of the most recent check (stored in `meta`).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct LastCheck {
    pub checked_at: i64,
    pub source_url: String,
    pub channel: String,
    /// Verified manifest (only ever set after its signature checked out).
    pub latest: Option<Manifest>,
    pub update_available: bool,
    /// Key id that signed the manifest.
    pub key_id: Option<String>,
    pub error: Option<String>,
}

/// Progress of the current / last update operation.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct UpdateStatus {
    /// idle | checking | downloading | verifying | ready | backing_up | installing |
    /// restarting | health_check | rolling_back | succeeded | failed | rolled_back | manual
    pub state: String,
    pub from_version: Option<String>,
    pub target_version: Option<String>,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub message: String,
    pub error: Option<String>,
    pub actor: String,
    pub started_at: i64,
    pub updated_at: i64,
    /// Operator commands (Docker without socket access).
    pub commands: Vec<String>,
    /// Step log of the operation ("<unix ts> <text>").
    pub log: Vec<String>,
}

/// Effective configuration (config file / env merged with admin settings).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Effective {
    /// `DRIVEHUB_UPDATE_CHECK`: false disables every network check.
    pub check_enabled: bool,
    pub source_url: String,
    pub channel: String,
    pub interval_secs: u64,
    /// binary | docker
    pub deployment: String,
    pub platform: String,
    pub exe_path: Option<String>,
    /// exec | exit
    pub restart: String,
    pub docker_socket: Option<String>,
    /// The server can install updates itself (binary with data dir, or Docker with socket).
    pub can_auto_install: bool,
    pub trusted_key_ids: Vec<String>,
    pub db_backups: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Restart {
    Upgrade,
    Rollback(String),
}

/// Who triggered an operation (for audit / notifications).
#[derive(Debug, Clone, Default)]
pub struct Actor {
    pub name: String,
    pub uid: Option<i64>,
    pub ip: String,
}

impl Actor {
    pub fn system() -> Self {
        Self {
            name: "system".into(),
            uid: None,
            ip: String::new(),
        }
    }
}

pub struct Updater {
    db: SqlitePool,
    data_dir: Option<PathBuf>,
    cfg: RwLock<UpdateConfig>,
    web_dir: RwLock<Option<PathBuf>>,
    bind: RwLock<Option<String>>,
    db_url: RwLock<Option<String>>,
    status: RwLock<UpdateStatus>,
    last: RwLock<Option<LastCheck>>,
    http: reqwest::Client,
    busy: Arc<tokio::sync::Mutex<()>>,
    restart_tx: watch::Sender<Option<Restart>>,
    audit: Arc<AuditLog>,
    auth: Arc<Auth>,
    notified: Mutex<Option<String>>,
}

impl Updater {
    pub async fn new(
        db: SqlitePool,
        data_dir: Option<&Path>,
        audit: Arc<AuditLog>,
        auth: Arc<Auth>,
    ) -> Arc<Self> {
        let status = data_dir
            .and_then(|d| std::fs::read(d.join("update/status.json")).ok())
            .and_then(|b| serde_json::from_slice::<UpdateStatus>(&b).ok())
            .map(|mut s| {
                // A process that died mid-operation leaves a stale transient state behind.
                if !matches!(
                    s.state.as_str(),
                    "idle"
                        | "ready"
                        | "succeeded"
                        | "failed"
                        | "rolled_back"
                        | "manual"
                        | "restarting"
                ) {
                    s.error = Some(format!("interrupted while {}", s.state));
                    s.state = "failed".into();
                }
                s
            })
            .unwrap_or_else(|| UpdateStatus {
                state: "idle".into(),
                ..Default::default()
            });
        let last = get_meta(&db, META_LAST_CHECK)
            .await
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok());
        let (restart_tx, _) = watch::channel(None);
        Arc::new(Self {
            db,
            data_dir: data_dir.map(Path::to_path_buf),
            cfg: RwLock::new(UpdateConfig::from_env()),
            web_dir: RwLock::new(None),
            bind: RwLock::new(None),
            db_url: RwLock::new(None),
            status: RwLock::new(status),
            last: RwLock::new(last),
            http: reqwest::Client::builder()
                .user_agent(format!("drivehub/{}", server_version()))
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
            busy: Arc::new(tokio::sync::Mutex::new(())),
            restart_tx,
            audit,
            auth,
            notified: Mutex::new(None),
        })
    }

    /// Runtime wiring from `main` (config file, listen address, web dir, database URL).
    pub fn configure(&self, cfg: UpdateConfig, bind: &str, db_url: &str) {
        *self.cfg.write().unwrap() = cfg;
        *self.bind.write().unwrap() = Some(bind.to_string());
        *self.db_url.write().unwrap() = Some(db_url.to_string());
    }
    pub fn set_config(&self, cfg: UpdateConfig) {
        *self.cfg.write().unwrap() = cfg;
    }
    pub fn set_web_dir(&self, d: Option<PathBuf>) {
        *self.web_dir.write().unwrap() = d;
    }
    pub fn config(&self) -> UpdateConfig {
        self.cfg.read().unwrap().clone()
    }
    pub fn restart_rx(&self) -> watch::Receiver<Option<Restart>> {
        self.restart_tx.subscribe()
    }
    pub fn restart_request(&self) -> Option<Restart> {
        self.restart_tx.borrow().clone()
    }
    /// Last check result; `update_available` is re-evaluated against the running version
    /// (a check made by the previous binary must not keep offering the installed release).
    pub fn last_check(&self) -> Option<LastCheck> {
        self.last.read().unwrap().clone().map(|mut l| {
            l.update_available = l.update_available
                && l.latest
                    .as_ref()
                    .is_some_and(|m| is_newer(&m.version, server_version()));
            l
        })
    }
    pub fn status(&self) -> UpdateStatus {
        self.status.read().unwrap().clone()
    }

    pub async fn settings(&self) -> UpdateSettings {
        get_meta(&self.db, META_SETTINGS)
            .await
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub async fn save_settings(&self, s: &UpdateSettings) -> anyhow::Result<()> {
        s.validate()?;
        set_meta(&self.db, META_SETTINGS, &serde_json::to_string(s)?).await?;
        Ok(())
    }

    fn exe_path(&self) -> Option<PathBuf> {
        self.config()
            .exe_path
            .or_else(|| std::env::current_exe().ok())
    }

    pub async fn effective(&self) -> Effective {
        let cfg = self.config();
        let s = self.settings().await;
        let in_docker = docker::in_container();
        let backups = self
            .data_dir
            .as_ref()
            .map(|d| list_backups(&d.join("update/backups")))
            .unwrap_or_default();
        Effective {
            check_enabled: cfg.check,
            source_url: if s.source_url.is_empty() {
                cfg.source_url.clone()
            } else {
                s.source_url.clone()
            },
            channel: if s.channel.is_empty() {
                cfg.channel.clone()
            } else {
                s.channel.clone()
            },
            interval_secs: if s.interval_secs == 0 {
                cfg.interval_secs.max(60)
            } else {
                s.interval_secs
            },
            deployment: if in_docker { "docker" } else { "binary" }.into(),
            platform: manifest::platform(),
            exe_path: self.exe_path().map(|p| p.display().to_string()),
            restart: cfg.restart.clone(),
            docker_socket: cfg.docker_socket.as_ref().map(|p| p.display().to_string()),
            can_auto_install: if in_docker {
                cfg.docker_socket.is_some()
            } else {
                self.data_dir.is_some()
            },
            trusted_key_ids: manifest::trusted_keys(&cfg.trusted_keys)
                .map(|ks| ks.iter().map(manifest::key_id).collect())
                .unwrap_or_default(),
            db_backups: backups,
        }
    }

    /// GET /api/version payload.
    pub fn version_info(&self) -> VersionInfo {
        let mut v = VersionInfo::current();
        if let Some(lc) = self.last_check() {
            if let Some(m) = &lc.latest {
                v.latest = Some(m.version.clone());
                v.update_available = lc.update_available && is_newer(&m.version, server_version());
                v.min_client_version = m.min_client_version.clone();
            }
        }
        v.web_build = self.web_dir.read().unwrap().as_ref().and_then(|d| {
            let b = std::fs::read(d.join("version.json")).ok()?;
            let j: serde_json::Value = serde_json::from_slice(&b).ok()?;
            j["build"].as_str().map(String::from)
        });
        v
    }

    // ------------------------------------------------------------ status helpers

    fn set_status(&self, f: impl FnOnce(&mut UpdateStatus)) {
        let snapshot = {
            let mut s = self.status.write().unwrap();
            f(&mut s);
            s.updated_at = now();
            if s.log.len() > 200 {
                let n = s.log.len() - 200;
                s.log.drain(..n);
            }
            s.clone()
        };
        if let Some(d) = &self.data_dir {
            let p = d.join("update/status.json");
            let _ = std::fs::create_dir_all(p.parent().unwrap());
            let tmp = d.join("update/status.json.tmp");
            if std::fs::write(
                &tmp,
                serde_json::to_vec_pretty(&snapshot).unwrap_or_default(),
            )
            .is_ok()
            {
                let _ = std::fs::rename(tmp, p);
            }
        }
    }

    fn step(&self, state: &str, msg: impl Into<String>) {
        let msg = msg.into();
        tracing::info!(%state, %msg, "update");
        self.set_status(|s| {
            s.state = state.into();
            s.log.push(format!("{} [{state}] {msg}", now()));
            s.message = msg;
        });
    }

    fn begin(&self, actor: &Actor, target: Option<&str>) {
        self.set_status(|s| {
            *s = UpdateStatus {
                state: "checking".into(),
                from_version: Some(server_version().into()),
                target_version: target.map(String::from),
                actor: actor.name.clone(),
                started_at: now(),
                ..Default::default()
            }
        });
    }

    fn fail(&self, e: &anyhow::Error) {
        let msg = format!("{e:#}");
        self.set_status(|s| {
            s.state = "failed".into();
            s.log.push(format!("{} [failed] {msg}", now()));
            s.message = "update failed".into();
            s.error = Some(msg);
        });
    }

    fn audit_ev(&self, actor: &Actor, action: &str, allowed: bool, detail: &str) {
        self.audit.log(AuditEvent {
            user_id: actor.uid,
            username: actor.name.clone(),
            ip: actor.ip.clone(),
            client: "api".into(),
            channel: crate::auth::CH_ADMIN.into(),
            action: action.into(),
            path: "/".into(),
            allowed,
            detail: detail.into(),
            ..Default::default()
        });
    }

    /// Webhook / e-mail notification through the audit alert sinks (recorded in alert events).
    pub async fn notify(&self, event: &str, msg: &str) {
        let s = self.settings().await;
        for (sink, target) in [("webhook", &s.notify_webhook), ("email", &s.notify_email)] {
            if target.is_empty() {
                continue;
            }
            let rule = AlertRule {
                id: 0,
                name: format!("system update: {event}"),
                kind: "update".into(),
                actions: event.into(),
                threshold: 0,
                window_secs: 0,
                sink: sink.into(),
                target: target.clone(),
                enabled: true,
                created_at: 0,
            };
            self.audit
                .alerts
                .fire(&self.db, &self.auth, &rule, "system", "", msg, None)
                .await;
        }
    }

    // ------------------------------------------------------------ check

    /// Fetches + verifies the manifest. Errors are recorded in the returned [`LastCheck`].
    pub async fn check(&self, actor: &Actor) -> anyhow::Result<LastCheck> {
        let cfg = self.config();
        if !cfg.check {
            bail!("update checks are disabled on this server (DRIVEHUB_UPDATE_CHECK=false)");
        }
        let eff = self.effective().await;
        let url = eff.source_url.clone();
        let res: anyhow::Result<(Manifest, String)> = async {
            let keys = manifest::trusted_keys(&cfg.trusted_keys)?;
            let body = install::fetch_small(&self.http, &url).await?;
            let sig = install::fetch_small(&self.http, &format!("{url}.sig"))
                .await
                .context("fetching manifest signature")?;
            let kid = manifest::verify(&body, &String::from_utf8_lossy(&sig), &keys)?;
            let m = manifest::parse_verified(&body, &String::from_utf8_lossy(&sig), &keys)?;
            Ok((m, kid))
        }
        .await;
        let lc = match res {
            Ok((m, kid)) => LastCheck {
                checked_at: now(),
                source_url: url,
                channel: eff.channel.clone(),
                update_available: m.matches_channel(&eff.channel)
                    && is_newer(&m.version, server_version()),
                latest: Some(m),
                key_id: Some(kid),
                error: None,
            },
            Err(e) => LastCheck {
                checked_at: now(),
                source_url: url,
                channel: eff.channel.clone(),
                error: Some(format!("{e:#}")),
                ..Default::default()
            },
        };
        let _ = set_meta(&self.db, META_LAST_CHECK, &serde_json::to_string(&lc)?).await;
        *self.last.write().unwrap() = Some(lc.clone());
        let detail = match (&lc.error, &lc.latest) {
            (Some(e), _) => format!("check failed: {e}"),
            (None, Some(m)) => format!(
                "latest {} ({}), current {}, available={}",
                m.version,
                m.channel,
                server_version(),
                lc.update_available
            ),
            _ => String::new(),
        };
        self.audit_ev(actor, "update_check", lc.error.is_none(), &detail);
        if lc.update_available {
            let v = lc.latest.as_ref().unwrap().version.clone();
            let first = {
                let mut n = self.notified.lock().unwrap();
                let first = n.as_deref() != Some(v.as_str());
                *n = Some(v.clone());
                first
            };
            if first {
                self.notify(
                    "available",
                    &format!("DriveHub {v} is available (running {}).", server_version()),
                )
                .await;
            }
        }
        Ok(lc)
    }

    // ------------------------------------------------------------ apply

    /// Starts an update in the background. `install=false` only downloads + verifies
    /// (state `ready`). Docker deployments without socket access get operator commands.
    pub async fn start(
        self: &Arc<Self>,
        actor: Actor,
        install: bool,
    ) -> anyhow::Result<UpdateStatus> {
        let guard = self
            .busy
            .clone()
            .try_lock_owned()
            .map_err(|_| anyhow!("an update operation is already running"))?;
        let cfg = self.config();
        if !cfg.check {
            bail!("updates are disabled on this server (DRIVEHUB_UPDATE_CHECK=false)");
        }
        if docker::in_container() {
            return self.start_docker(actor, cfg, install, guard).await;
        }
        if self.data_dir.is_none() {
            bail!("self-update needs a persistent data directory");
        }
        self.begin(&actor, None);
        self.audit_ev(
            &actor,
            if install {
                "update_apply"
            } else {
                "update_download"
            },
            true,
            "started",
        );
        let me = self.clone();
        tokio::spawn(async move {
            let _g = guard;
            if let Err(e) = me.run_binary(&actor, install).await {
                me.fail(&e);
                me.audit_ev(&actor, "update_failed", false, &format!("{e:#}"));
                me.notify("failed", &format!("DriveHub update failed: {e:#}"))
                    .await;
            }
        });
        Ok(self.status())
    }

    async fn start_docker(
        self: &Arc<Self>,
        actor: Actor,
        cfg: UpdateConfig,
        install: bool,
        guard: tokio::sync::OwnedMutexGuard<()>,
    ) -> anyhow::Result<UpdateStatus> {
        self.begin(&actor, None);
        let lc = self.check(&actor).await?;
        if let Some(e) = lc.error {
            self.fail(&anyhow!(e.clone()));
            bail!(e);
        }
        let m = lc.latest.unwrap();
        let image = m
            .artifact("docker", "")
            .map(|a| a.image.clone())
            .ok_or_else(|| anyhow!("release {} has no docker image", m.version))?;
        self.set_status(|s| s.target_version = Some(m.version.clone()));
        if !lc.update_available {
            self.step("idle", format!("already up to date ({})", server_version()));
            return Ok(self.status());
        }
        let Some(sock) = cfg.docker_socket.clone().filter(|_| install) else {
            let cmds = docker::manual_commands(&image, &docker::self_container());
            self.set_status(|s| s.commands = cmds);
            self.step(
                "manual",
                format!("running in Docker without socket access: pull {image} and recreate the container"),
            );
            self.audit_ev(
                &actor,
                "update_apply",
                true,
                &format!("docker manual {image}"),
            );
            return Ok(self.status());
        };
        self.step(
            "installing",
            format!("pulling {image} and starting the updater container"),
        );
        let me = self.clone();
        tokio::spawn(async move {
            let _g = guard;
            let api = docker::SocketApi(sock.clone());
            match docker::start_update(&api, &sock, &image, cfg.health_timeout_secs.max(30)).await {
                Ok(id) => {
                    me.step(
                        "restarting",
                        format!("updater container {id} is swapping containers"),
                    );
                    me.audit_ev(&actor, "update_install", true, &format!("docker {image}"));
                }
                Err(e) => {
                    me.fail(&e);
                    me.audit_ev(&actor, "update_failed", false, &format!("{e:#}"));
                }
            }
        });
        Ok(self.status())
    }

    async fn run_binary(&self, actor: &Actor, install: bool) -> anyhow::Result<()> {
        let data_dir = self.data_dir.clone().unwrap();
        self.step("checking", "fetching and verifying the release manifest");
        let lc = self.check(actor).await?;
        if let Some(e) = lc.error {
            bail!(e);
        }
        let m = lc.latest.unwrap();
        self.set_status(|s| s.target_version = Some(m.version.clone()));
        if !lc.update_available {
            bail!(
                "no update available (latest {} on {}, running {})",
                m.version,
                m.channel,
                server_version()
            );
        }
        let plat = manifest::platform();
        let art = m
            .artifact("server", &plat)
            .ok_or_else(|| anyhow!("release {} has no server build for {plat}", m.version))?
            .clone();
        let base = lc.source_url.clone();
        let staging = data_dir.join("update/staging").join(&m.version);
        let bin = staging.join("drivehub");
        let total = art.size + m.artifact("web", "").map_or(0, |a| a.size);
        self.set_status(|s| {
            s.total_bytes = total;
            s.progress_bytes = 0;
        });
        if bin.exists() && install::file_sha256(&bin).ok().as_deref() == Some(art.sha256.as_str()) {
            self.step(
                "downloading",
                "server binary already downloaded and verified",
            );
        } else {
            let url = install::resolve(&base, &art.url)?;
            self.step("downloading", format!("downloading {url}"));
            install::download_verified(&self.http, &url, &bin, &art.sha256, art.size, |n| {
                self.set_status(|s| s.progress_bytes = n)
            })
            .await
            .context("server binary")?;
        }
        let web_art = m.artifact("web", "").cloned();
        let web_dir = self.web_dir.read().unwrap().clone();
        let web_tgz = staging.join("web.tar.gz");
        if let (Some(w), Some(_)) = (&web_art, &web_dir) {
            if !(web_tgz.exists()
                && install::file_sha256(&web_tgz).ok().as_deref() == Some(w.sha256.as_str()))
            {
                let url = install::resolve(&base, &w.url)?;
                self.step("downloading", format!("downloading {url}"));
                let off = art.size;
                install::download_verified(&self.http, &url, &web_tgz, &w.sha256, w.size, |n| {
                    self.set_status(|s| s.progress_bytes = off + n)
                })
                .await
                .context("web bundle")?;
            }
        }
        self.set_status(|s| s.progress_bytes = s.total_bytes);
        self.step("verifying", "SHA-256 verified; probing the new binary");
        install::chmod_x(&bin)?;
        let reported = install::probe_version(&bin).await?;
        if reported != m.version {
            bail!(
                "new binary reports version {reported}, manifest says {}",
                m.version
            );
        }
        if !install {
            self.step(
                "ready",
                format!("{} downloaded and verified; apply to install", m.version),
            );
            self.audit_ev(actor, "update_download", true, &m.version);
            return Ok(());
        }

        // ---- point of no return is the restart; everything before is undoable
        self.step("backing_up", "snapshotting the database");
        let db_url = self.db_url.read().unwrap().clone();
        let db_path = db_url.as_deref().and_then(install::sqlite_file);
        let db_backup = match &db_path {
            Some(_) => {
                let dir = data_dir.join("update/backups");
                std::fs::create_dir_all(&dir)?;
                let p = dir.join(format!(
                    "drivehub-{}-to-{}-{}.db",
                    server_version(),
                    m.version,
                    now()
                ));
                sqlx::query("VACUUM INTO ?")
                    .bind(p.display().to_string())
                    .execute(&self.db)
                    .await
                    .context("database backup (VACUUM INTO)")?;
                prune_backups(&dir, KEEP_DB_BACKUPS);
                Some(p)
            }
            None => None,
        };
        self.step(
            "installing",
            "replacing files (previous version kept as .bak)",
        );
        let exe = self
            .exe_path()
            .ok_or_else(|| anyhow!("cannot locate the running executable"))?;
        let mut web_backup = None;
        if let (Some(_), Some(wd)) = (&web_art, &web_dir) {
            let mut new_dir = wd.as_os_str().to_os_string();
            new_dir.push(".new");
            let new_dir = PathBuf::from(new_dir);
            install::unpack_tar_gz(&web_tgz, &new_dir).context("unpack web bundle")?;
            web_backup = Some(install::swap_dir(&new_dir, wd)?);
        }
        let exe_backup = match install::swap_binary(&bin, &exe) {
            Ok(b) => b,
            Err(e) => {
                if let (Some(b), Some(wd)) = (&web_backup, &web_dir) {
                    let _ = std::fs::remove_dir_all(wd);
                    let _ = std::fs::rename(b, wd);
                }
                return Err(e);
            }
        };
        let cfg = self.config();
        let mut pending = Pending {
            state: "restarting".into(),
            from_version: server_version().into(),
            to_version: m.version.clone(),
            exe_path: exe.clone(),
            exe_backup,
            db_path,
            db_backup,
            web_dir: web_dir.clone(),
            web_backup,
            boot_attempts: 0,
            started_at: now(),
            actor: actor.name.clone(),
            restart: cfg.restart.clone(),
            error: None,
            journal: vec![],
        };
        let install_detail = format!("{} -> {} ({})", server_version(), m.version, exe.display());
        pending.note("update_install", true, &install_detail);
        if let Err(e) = pending.save(&data_dir) {
            let _ = pending.rollback_files();
            return Err(e).context("writing update marker");
        }
        self.audit_ev(actor, "update_install", true, &install_detail);
        self.audit.flush().await;
        self.step(
            "restarting",
            format!("restarting into {} ({})", m.version, cfg.restart),
        );
        self.restart_tx.send_replace(Some(Restart::Upgrade));
        Ok(())
    }

    // ------------------------------------------------------------ after restart

    /// Called by the freshly started process: finishes a pending upgrade (health check →
    /// commit or rollback) or records a rollback performed by the previous process.
    pub async fn resume(self: &Arc<Self>, health_url: Option<String>) {
        let Some(dd) = self.data_dir.clone() else {
            return;
        };
        let Some(p) = Pending::load(&dd) else { return };
        let actor = Actor {
            name: if p.actor.is_empty() {
                "system".into()
            } else {
                p.actor.clone()
            },
            ..Default::default()
        };
        match p.state.as_str() {
            "restarting" => {
                self.set_status(|s| {
                    s.target_version = Some(p.to_version.clone());
                    s.from_version = Some(p.from_version.clone());
                });
                self.step(
                    "health_check",
                    format!("{} started; checking health", server_version()),
                );
                let me = self.clone();
                tokio::spawn(async move {
                    let budget = me.config().health_timeout_secs.max(5);
                    let res = match &health_url {
                        Some(u) => health_check(&me.http, u, &p.to_version, budget).await,
                        None => Err(anyhow!("no listen address to health-check")),
                    };
                    match res {
                        Ok(()) => {
                            Pending::clear(&dd);
                            me.step(
                                "succeeded",
                                format!("updated {} -> {}", p.from_version, p.to_version),
                            );
                            me.audit_ev(
                                &actor,
                                "update_applied",
                                true,
                                &format!("{} -> {}", p.from_version, p.to_version),
                            );
                            me.notify(
                                "installed",
                                &format!(
                                    "DriveHub updated {} -> {}.",
                                    p.from_version, p.to_version
                                ),
                            )
                            .await;
                            let _ = std::fs::remove_dir_all(dd.join("update/staging"));
                        }
                        Err(e) => {
                            let reason = format!("health check failed: {e:#}");
                            me.step("rolling_back", reason.clone());
                            me.audit_ev(&actor, "update_health_failed", false, &reason);
                            me.audit.flush().await;
                            if let Some(mut p) = Pending::load(&dd) {
                                p.note("update_health_failed", false, &reason);
                                let _ = p.save(&dd);
                            }
                            me.restart_tx.send_replace(Some(Restart::Rollback(reason)));
                        }
                    }
                });
            }
            "rolled_back" => {
                let err = p.error.clone().unwrap_or_default();
                Pending::clear(&dd);
                self.set_status(|s| {
                    s.state = "rolled_back".into();
                    s.target_version = Some(p.to_version.clone());
                    s.from_version = Some(p.from_version.clone());
                    s.error = Some(err.clone());
                    s.message = format!("rolled back to {}", server_version());
                    s.log.push(format!(
                        "{} [rolled_back] {err}; running {} again",
                        now(),
                        server_version()
                    ));
                });
                for j in &p.journal {
                    if j.action == "update_rollback" {
                        continue;
                    }
                    self.audit_ev(
                        &actor,
                        &j.action,
                        j.allowed,
                        &format!(
                            "{} [at {}, replayed after database restore]",
                            j.detail,
                            crate::audit::iso(j.ts)
                        ),
                    );
                }
                self.audit_ev(
                    &actor,
                    "update_rolled_back",
                    false,
                    &format!("{} -> {} rolled back: {err}", p.from_version, p.to_version),
                );
                self.notify(
                    "rolled_back",
                    &format!(
                        "DriveHub update {} -> {} was rolled back: {err}",
                        p.from_version, p.to_version
                    ),
                )
                .await;
            }
            _ => Pending::clear(&dd),
        }
    }

    // ------------------------------------------------------------ background

    /// Periodic checks + download / install according to the configured mode.
    pub fn spawn_background(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
            loop {
                me.tick().await;
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            }
        });
    }

    async fn tick(self: &Arc<Self>) {
        let cfg = self.config();
        let s = self.settings().await;
        if !cfg.check || !s.auto_check {
            return;
        }
        let eff = self.effective().await;
        let due = self
            .last_check()
            .is_none_or(|l| now() - l.checked_at >= eff.interval_secs as i64);
        if !due {
            return;
        }
        let Ok(lc) = self.check(&Actor::system()).await else {
            return;
        };
        if !lc.update_available || docker::in_container() && s.mode != "install" {
            return;
        }
        let st = self.status();
        let target = lc.latest.as_ref().map(|m| m.version.clone());
        match s.mode.as_str() {
            "download" if !(st.state == "ready" && st.target_version == target) => {
                let _ = self.start(Actor::system(), false).await;
            }
            "install" => {
                let utc = (now().rem_euclid(86400) / 60) as u32;
                let ws = (!s.window_start.is_empty()).then_some(s.window_start.as_str());
                let we = (!s.window_end.is_empty()).then_some(s.window_end.as_str());
                // never retry a version that just failed / rolled back automatically
                let failed_before = matches!(st.state.as_str(), "failed" | "rolled_back")
                    && st.target_version == target;
                if install::in_window(utc, ws, we) && !failed_before {
                    let _ = self.start(Actor::system(), true).await;
                }
            }
            _ => {}
        }
    }
}

/// GET health + version of the freshly started server until it answers or `budget` expires.
pub async fn health_check(
    http: &reqwest::Client,
    base: &str,
    expect_version: &str,
    budget_secs: u64,
) -> anyhow::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(budget_secs);
    loop {
        let r: anyhow::Result<()> = async {
            let h = http
                .get(format!("{base}/api/v1/health"))
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await?;
            if !h.status().is_success() {
                bail!("/api/v1/health returned HTTP {}", h.status());
            }
            let j: serde_json::Value = h.json().await?;
            if j["db"] != true {
                bail!("/api/v1/health reports the database down");
            }
            let v: serde_json::Value = http
                .get(format!("{base}/api/version"))
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await?
                .json()
                .await?;
            if v["server_version"] != expect_version {
                bail!(
                    "server reports version {}, expected {expect_version}",
                    v["server_version"]
                );
            }
            Ok(())
        }
        .await;
        let e = match r {
            Ok(()) => return Ok(()),
            Err(e) => e,
        };
        if std::time::Instant::now() >= deadline {
            return Err(e);
        }
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    }
}

/// `http://127.0.0.1:<port>` for a bind address like `0.0.0.0:8470`.
pub fn local_base(bind: &str) -> Option<String> {
    let addr: std::net::SocketAddr = bind.parse().ok()?;
    let host = match addr.ip() {
        std::net::IpAddr::V4(ip) if ip.is_unspecified() => "127.0.0.1".to_string(),
        std::net::IpAddr::V6(ip) if ip.is_unspecified() => "[::1]".to_string(),
        std::net::IpAddr::V6(ip) => format!("[{ip}]"),
        ip => ip.to_string(),
    };
    Some(format!("http://{host}:{}", addr.port()))
}

fn list_backups(dir: &Path) -> Vec<String> {
    let mut v: Vec<(std::time::SystemTime, String)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".db"))
                .map(|e| {
                    (
                        e.metadata()
                            .and_then(|m| m.modified())
                            .unwrap_or(std::time::UNIX_EPOCH),
                        e.path().display().to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v.into_iter().rev().map(|x| x.1).collect()
}

fn prune_backups(dir: &Path, keep: usize) {
    for p in list_backups(dir).into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_validation() {
        let mut s = UpdateSettings::default();
        assert!(s.validate().is_ok());
        s.mode = "yolo".into();
        assert!(s.validate().is_err());
        s.mode = "install".into();
        s.window_start = "02:00".into();
        assert!(s.validate().is_err(), "half a window");
        s.window_end = "04:30".into();
        assert!(s.validate().is_ok());
        s.window_end = "25:00".into();
        assert!(s.validate().is_err());
        s.window_end = "04:30".into();
        s.source_url = "ftp://x".into();
        assert!(s.validate().is_err());
        s.source_url = "file:///srv/rel/release-manifest.json".into();
        assert!(s.validate().is_ok());
        s.interval_secs = 5;
        assert!(s.validate().is_err());
    }

    #[test]
    fn local_base_addresses() {
        assert_eq!(local_base("0.0.0.0:8484").unwrap(), "http://127.0.0.1:8484");
        assert_eq!(local_base("127.0.0.1:1").unwrap(), "http://127.0.0.1:1");
        assert_eq!(local_base("[::]:9").unwrap(), "http://[::1]:9");
        assert!(local_base("nope").is_none());
    }
}
