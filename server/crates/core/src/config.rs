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
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "0.0.0.0:8470".into(),
            data_dir: PathBuf::from("./data"),
            web_dir: None,
            database_url: None,
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
}
