use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Server configuration. Loaded from an optional TOML file, then overridden by
/// DRIVEHUB_* environment variables (env wins).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default)]
pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    pub web_dir: Option<PathBuf>,
    /// sqlx database URL. Defaults to SQLite under data_dir.
    pub database_url: Option<String>,
    /// Auto-update (DEPTAI-484), `[update]` table.
    pub update: UpdateConfig,
}

/// Default update source: the signed manifest attached to the latest GitHub release.
pub const DEFAULT_UPDATE_URL: &str =
    "https://github.com/lthero-big/drivehub/releases/latest/download/release-manifest.json";

/// Static auto-update configuration (`[update]` in the TOML file, `DRIVEHUB_UPDATE_*` env).
/// Runtime choices (mode, maintenance window, notifications, source override) are admin
/// settings stored in the database; these values are their defaults / hard limits.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default)]
pub struct UpdateConfig {
    /// Master switch for any network check (false = offline / intranet installs).
    pub check: bool,
    /// Manifest URL (`http(s)://…/release-manifest.json` or `file:///…`); signature is
    /// fetched from `<url>.sig`.
    pub source_url: String,
    /// stable | beta
    pub channel: String,
    pub interval_secs: u64,
    /// Extra trusted Ed25519 public keys (base64, 32 bytes) besides the built-in release key.
    pub trusted_keys: Vec<String>,
    /// File replaced by a binary update (default: the running executable).
    pub exe_path: Option<PathBuf>,
    /// How the new binary is started: `exec` (replace the process in place, same PID — works
    /// under pm2, systemd and plain shells) or `exit` (exit with code 75 and let the
    /// supervisor restart us).
    pub restart: String,
    /// Docker Engine socket; only when set may the server recreate its own container.
    pub docker_socket: Option<PathBuf>,
    /// Post-restart health check budget before rolling back.
    pub health_timeout_secs: u64,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            check: true,
            source_url: DEFAULT_UPDATE_URL.into(),
            channel: "stable".into(),
            interval_secs: 6 * 3600,
            trusted_keys: vec![],
            exe_path: None,
            restart: "exec".into(),
            docker_socket: None,
            health_timeout_secs: 30,
        }
    }
}

impl UpdateConfig {
    pub fn apply_env(&mut self, get: &impl Fn(&str) -> Option<String>) {
        if let Some(v) = get("DRIVEHUB_UPDATE_CHECK") {
            self.check = !matches!(v.trim(), "0" | "false" | "off" | "no");
        }
        if let Some(v) = get("DRIVEHUB_UPDATE_URL") {
            self.source_url = v;
        }
        if let Some(v) = get("DRIVEHUB_UPDATE_CHANNEL") {
            self.channel = v;
        }
        if let Some(v) = get("DRIVEHUB_UPDATE_INTERVAL_SECS").and_then(|v| v.parse().ok()) {
            self.interval_secs = v;
        }
        if let Some(v) = get("DRIVEHUB_UPDATE_TRUSTED_KEYS") {
            self.trusted_keys.extend(
                v.split([',', ' ', '\n'])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from),
            );
        }
        if let Some(v) = get("DRIVEHUB_UPDATE_EXE") {
            self.exe_path = Some(v.into());
        }
        if let Some(v) = get("DRIVEHUB_UPDATE_RESTART") {
            self.restart = v;
        }
        if let Some(v) = get("DRIVEHUB_UPDATE_DOCKER_SOCKET") {
            self.docker_socket = (!v.is_empty()).then(|| v.into());
        }
        if let Some(v) = get("DRIVEHUB_UPDATE_HEALTH_TIMEOUT_SECS").and_then(|v| v.parse().ok()) {
            self.health_timeout_secs = v;
        }
    }

    /// Defaults overridden by the process environment.
    pub fn from_env() -> Self {
        let mut c = Self::default();
        c.apply_env(&|k| std::env::var(k).ok());
        c
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "0.0.0.0:8470".into(),
            data_dir: PathBuf::from("./data"),
            web_dir: None,
            database_url: None,
            update: UpdateConfig::default(),
        }
    }
}

impl Config {
    pub fn load(file: Option<&Path>) -> anyhow::Result<Self> {
        let mut cfg = match file {
            Some(p) if p.exists() => toml::from_str(&std::fs::read_to_string(p)?)?,
            _ => Config::default(),
        };
        cfg.apply_env(|k| std::env::var(k).ok());
        Ok(cfg)
    }

    pub fn apply_env(&mut self, get: impl Fn(&str) -> Option<String>) {
        if let Some(v) = get("DRIVEHUB_BIND") {
            self.bind = v;
        }
        if let Some(v) = get("DRIVEHUB_DATA_DIR") {
            self.data_dir = v.into();
        }
        if let Some(v) = get("DRIVEHUB_WEB_DIR") {
            self.web_dir = Some(v.into());
        }
        if let Some(v) = get("DRIVEHUB_DATABASE_URL") {
            self.database_url = Some(v);
        }
        self.update.apply_env(&get);
    }

    pub fn database_url(&self) -> String {
        self.database_url.clone().unwrap_or_else(|| {
            format!(
                "sqlite://{}?mode=rwc",
                self.data_dir.join("drivehub.db").display()
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_overrides_file_values() {
        let mut cfg: Config = toml::from_str("bind = \"127.0.0.1:1\"\ndata_dir = \"/x\"").unwrap();
        cfg.apply_env(|k| (k == "DRIVEHUB_BIND").then(|| "0.0.0.0:2".to_string()));
        assert_eq!(cfg.bind, "0.0.0.0:2");
        assert_eq!(cfg.data_dir, PathBuf::from("/x"));
        assert_eq!(cfg.database_url(), "sqlite:///x/drivehub.db?mode=rwc");
    }

    #[test]
    fn update_section_and_env() {
        let mut cfg: Config =
            toml::from_str("[update]\ncheck = false\ninterval_secs = 60\nchannel = \"beta\"")
                .unwrap();
        assert!(!cfg.update.check);
        assert_eq!(cfg.update.interval_secs, 60);
        assert_eq!(cfg.update.source_url, DEFAULT_UPDATE_URL);
        cfg.apply_env(|k| match k {
            "DRIVEHUB_UPDATE_CHECK" => Some("true".into()),
            "DRIVEHUB_UPDATE_TRUSTED_KEYS" => Some("a, b".into()),
            _ => None,
        });
        assert!(cfg.update.check);
        assert_eq!(cfg.update.trusted_keys, vec!["a", "b"]);
        assert_eq!(cfg.update.channel, "beta");
    }
}
