//! Background transfer tasks (cross-storage copy/move), persisted in SQLite.
//! On start, `running` tasks are reset to `pending` and resumed (restarted from scratch).
use crate::vfs::Vfs;
use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema, sqlx::FromRow)]
pub struct TaskInfo {
    pub id: i64,
    /// copy | move
    pub kind: String,
    pub src: String,
    pub dst: String,
    /// pending | running | done | failed
    pub status: String,
    pub done_bytes: i64,
    pub total_bytes: i64,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

pub struct Tasks {
    db: SqlitePool,
    notify: Notify,
}

impl Tasks {
    pub fn new(db: SqlitePool) -> Arc<Self> {
        Arc::new(Self {
            db,
            notify: Notify::new(),
        })
    }

    pub async fn enqueue(&self, kind: &str, src: &str, dst: &str) -> sqlx::Result<i64> {
        let t = now();
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO tasks (kind, src, dst, status, created_at, updated_at) VALUES (?,?,?,'pending',?,?) RETURNING id",
        )
        .bind(kind)
        .bind(src)
        .bind(dst)
        .bind(t)
        .bind(t)
        .fetch_one(&self.db)
        .await?;
        self.notify.notify_one();
        Ok(id)
    }

    pub async fn list(&self, status: Option<&str>, limit: i64) -> sqlx::Result<Vec<TaskInfo>> {
        sqlx::query_as(
            "SELECT * FROM tasks WHERE (?1 IS NULL OR status = ?1) ORDER BY id DESC LIMIT ?2",
        )
        .bind(status)
        .bind(limit)
        .fetch_all(&self.db)
        .await
    }

    pub async fn get(&self, id: i64) -> sqlx::Result<Option<TaskInfo>> {
        sqlx::query_as("SELECT * FROM tasks WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.db)
            .await
    }

    /// Resets interrupted tasks and starts the worker loop.
    pub async fn start(
        self: &Arc<Self>,
        vfs: Arc<Vfs>,
        on_done: Arc<dyn Fn(String) + Send + Sync>,
    ) -> sqlx::Result<u64> {
        let r =
            sqlx::query("UPDATE tasks SET status='pending', updated_at=? WHERE status='running'")
                .bind(now())
                .execute(&self.db)
                .await?;
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                match me.claim().await {
                    Ok(Some(t)) => {
                        let res = me.run(&vfs, &t).await;
                        let (status, err) = match res {
                            Ok(()) => ("done", None),
                            Err(e) => ("failed", Some(e.to_string())),
                        };
                        let _ = sqlx::query(
                            "UPDATE tasks SET status=?, error=?, updated_at=? WHERE id=?",
                        )
                        .bind(status)
                        .bind(err)
                        .bind(now())
                        .bind(t.id)
                        .execute(&me.db)
                        .await;
                        for p in [&t.src, &t.dst] {
                            if let Some(m) = p.trim_start_matches('/').split('/').next() {
                                vfs.invalidate(m);
                                on_done(m.to_string());
                            }
                        }
                    }
                    Ok(None) => {
                        let _ = tokio::time::timeout(Duration::from_secs(2), me.notify.notified())
                            .await;
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "task claim failed");
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }
            }
        });
        Ok(r.rows_affected())
    }

    async fn claim(&self) -> sqlx::Result<Option<TaskInfo>> {
        sqlx::query_as(
            "UPDATE tasks SET status='running', done_bytes=0, updated_at=?
             WHERE id = (SELECT id FROM tasks WHERE status='pending' ORDER BY id LIMIT 1) RETURNING *",
        )
        .bind(now())
        .fetch_optional(&self.db)
        .await
    }

    async fn run(&self, vfs: &Vfs, t: &TaskInfo) -> anyhow::Result<()> {
        let (sm, srel) = vfs
            .resolve_in(&t.src, t.kind == "move")
            .map_err(|e| anyhow::anyhow!(e.1))?;
        let (dm, drel) = vfs
            .resolve_in(&t.dst, true)
            .map_err(|e| anyhow::anyhow!(e.1))?;
        let st = sm.driver.stat(&srel).await?;
        let items: Vec<(String, String, bool)> = if st.is_dir {
            let mut v = vec![(srel.clone(), drel.clone(), true)];
            for e in sm.driver.list_recursive(&srel).await? {
                let rel = e
                    .path
                    .strip_prefix(&srel)
                    .unwrap_or(&e.path)
                    .trim_start_matches('/')
                    .to_string();
                v.push((e.path.clone(), format!("{drel}/{rel}"), e.is_dir));
            }
            v
        } else {
            vec![(srel.clone(), drel.clone(), false)]
        };
        let mut total = 0u64;
        for (s, _, d) in &items {
            if !d {
                total += sm.driver.stat(s).await?.size;
            }
        }
        sqlx::query("UPDATE tasks SET total_bytes=? WHERE id=?")
            .bind(total as i64)
            .bind(t.id)
            .execute(&self.db)
            .await?;
        let done = Arc::new(AtomicU64::new(0));
        // progress flusher
        let (db, id, d2) = (self.db.clone(), t.id, done.clone());
        let flusher = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let _ = sqlx::query("UPDATE tasks SET done_bytes=?, updated_at=? WHERE id=?")
                    .bind(d2.load(Ordering::Relaxed) as i64)
                    .bind(now())
                    .bind(id)
                    .execute(&db)
                    .await;
            }
        });
        let result: anyhow::Result<()> = async {
            for (s, d, is_dir) in &items {
                if *is_dir {
                    dm.driver.mkdir(d).await?;
                    continue;
                }
                let base = done.load(Ordering::Relaxed);
                let stream = sm.driver.read(s, None).await?;
                let dd = done.clone();
                dm.driver
                    .write_stream(d, stream, &move |n| dd.store(base + n, Ordering::Relaxed))
                    .await?;
            }
            if t.kind == "move" {
                sm.driver.delete(&srel).await?;
            }
            Ok(())
        }
        .await;
        flusher.abort();
        sqlx::query("UPDATE tasks SET done_bytes=? WHERE id=?")
            .bind(done.load(Ordering::Relaxed) as i64)
            .bind(t.id)
            .execute(&self.db)
            .await?;
        result
    }
}
