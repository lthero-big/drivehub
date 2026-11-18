//! Mount registry + unified virtual tree (`/<mount>/<path>`) + TTL directory cache.
use crate::error::{ApiError, ApiResult};
use drivehub_storage::{build_driver, norm, Entry, StorageDriver, TransferMode};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use utoipa::ToSchema;

/// Mount point definition (stored in SQLite `mounts`).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MountConfig {
    /// Top-level folder name in the virtual tree (no '/').
    pub name: String,
    /// Driver kind: fs | s3 | webdav (rclone / OpenList bridge via webdav).
    pub kind: String,
    /// Driver options, e.g. {"root": "/srv/files"} for fs.
    #[serde(default)]
    pub options: HashMap<String, String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub sort_order: i64,
    /// direct | proxy | auto
    #[serde(default = "default_mode")]
    pub transfer_mode: String,
}

fn default_mode() -> String {
    "auto".into()
}

impl MountConfig {
    pub fn mode(&self) -> TransferMode {
        TransferMode::parse(&self.transfer_mode).unwrap_or_default()
    }
}

pub struct Mount {
    pub cfg: MountConfig,
    pub driver: Arc<dyn StorageDriver>,
}

/// A resolved virtual path.
pub enum Resolved {
    Root,
    InMount { mount: Arc<Mount>, rel: String },
}

type ListCache = HashMap<(String, String), (Instant, Arc<Vec<Entry>>)>;

pub struct Vfs {
    db: SqlitePool,
    mounts: RwLock<HashMap<String, Arc<Mount>>>,
    cache: Mutex<ListCache>,
    pub ttl: Duration,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

impl Vfs {
    pub async fn load(db: SqlitePool, ttl: Duration) -> anyhow::Result<Self> {
        let vfs = Self {
            db,
            mounts: RwLock::new(HashMap::new()),
            cache: Mutex::new(HashMap::new()),
            ttl,
        };
        let rows: Vec<(String, String, String, i64, i64, i64, String)> = sqlx::query_as(
            "SELECT name, kind, options, read_only, hidden, sort_order, transfer_mode FROM mounts",
        )
        .fetch_all(&vfs.db)
        .await?;
        for (name, kind, options, ro, hidden, sort_order, mode) in rows {
            let cfg = MountConfig {
                name: name.clone(),
                kind,
                options: serde_json::from_str(&options).unwrap_or_default(),
                read_only: ro != 0,
                hidden: hidden != 0,
                sort_order,
                transfer_mode: mode,
            };
            match build_driver(&cfg.kind, &cfg.options) {
                Ok(d) => {
                    vfs.mounts.write().unwrap().insert(
                        name,
                        Arc::new(Mount {
                            cfg,
                            driver: Arc::from(d),
                        }),
                    );
                }
                Err(e) => tracing::warn!(mount = %name, error = %e, "mount failed to load"),
            }
        }
        Ok(vfs)
    }

    pub fn mounts(&self) -> Vec<Arc<Mount>> {
        let mut v: Vec<_> = self.mounts.read().unwrap().values().cloned().collect();
        v.sort_by(|a, b| (a.cfg.sort_order, &a.cfg.name).cmp(&(b.cfg.sort_order, &b.cfg.name)));
        v
    }

    pub fn get(&self, name: &str) -> Option<Arc<Mount>> {
        self.mounts.read().unwrap().get(name).cloned()
    }

    pub async fn add(&self, cfg: MountConfig) -> ApiResult<()> {
        if cfg.name.is_empty() || cfg.name.contains('/') || cfg.name.starts_with('.') {
            return Err(ApiError::bad("invalid mount name"));
        }
        if TransferMode::parse(&cfg.transfer_mode).is_none() {
            return Err(ApiError::bad("transfer_mode must be direct|proxy|auto"));
        }
        let driver = build_driver(&cfg.kind, &cfg.options)?;
        sqlx::query(
            "INSERT INTO mounts (name, kind, options, read_only, hidden, sort_order, transfer_mode, created_at)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, options=excluded.options, read_only=excluded.read_only,
               hidden=excluded.hidden, sort_order=excluded.sort_order, transfer_mode=excluded.transfer_mode",
        )
        .bind(&cfg.name)
        .bind(&cfg.kind)
        .bind(serde_json::to_string(&cfg.options).unwrap())
        .bind(cfg.read_only as i64)
        .bind(cfg.hidden as i64)
        .bind(cfg.sort_order)
        .bind(&cfg.transfer_mode)
        .bind(now())
        .execute(&self.db)
        .await?;
        self.invalidate(&cfg.name);
        self.mounts.write().unwrap().insert(
            cfg.name.clone(),
            Arc::new(Mount {
                cfg,
                driver: Arc::from(driver),
            }),
        );
        Ok(())
    }

    pub async fn remove(&self, name: &str) -> ApiResult<bool> {
        let r = sqlx::query("DELETE FROM mounts WHERE name = ?")
            .bind(name)
            .execute(&self.db)
            .await?;
        sqlx::query("DELETE FROM files WHERE mount = ?")
            .bind(name)
            .execute(&self.db)
            .await?;
        self.mounts.write().unwrap().remove(name);
        self.invalidate(name);
        Ok(r.rows_affected() > 0)
    }

    /// Resolves `/mount/rel/path` to a mount + driver-relative path.
    pub fn resolve(&self, vpath: &str) -> ApiResult<Resolved> {
        let p = norm(vpath)?;
        if p.is_empty() {
            return Ok(Resolved::Root);
        }
        let (name, rel) = p.split_once('/').unwrap_or((&p, ""));
        let mount = self
            .get(name)
            .ok_or_else(|| ApiError::not_found(format!("no such mount: {name}")))?;
        Ok(Resolved::InMount {
            mount,
            rel: rel.to_string(),
        })
    }

    /// Resolves and requires a path inside a mount (optionally writable, optionally non-root).
    pub fn resolve_in(&self, vpath: &str, write: bool) -> ApiResult<(Arc<Mount>, String)> {
        match self.resolve(vpath)? {
            Resolved::Root => Err(ApiError::bad("operation not allowed on virtual root")),
            Resolved::InMount { mount, rel } => {
                if write && mount.cfg.read_only {
                    return Err(ApiError::forbidden(format!(
                        "mount '{}' is read-only",
                        mount.cfg.name
                    )));
                }
                if write && rel.is_empty() {
                    return Err(ApiError::bad("operation not allowed on mount root"));
                }
                Ok((mount, rel))
            }
        }
    }

    /// Cached directory listing.
    pub async fn list(
        &self,
        mount: &Mount,
        rel: &str,
        refresh: bool,
    ) -> ApiResult<Arc<Vec<Entry>>> {
        let key = (mount.cfg.name.clone(), rel.to_string());
        if !refresh {
            if let Some((t, v)) = self.cache.lock().unwrap().get(&key) {
                if t.elapsed() < self.ttl {
                    return Ok(v.clone());
                }
            }
        }
        let v = Arc::new(mount.driver.list(rel).await?);
        self.cache
            .lock()
            .unwrap()
            .insert(key, (Instant::now(), v.clone()));
        Ok(v)
    }

    pub fn invalidate(&self, mount: &str) {
        self.cache.lock().unwrap().retain(|(m, _), _| m != mount);
    }
}
