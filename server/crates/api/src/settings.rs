//! Runtime settings stored in the `meta` table (`setting.*` keys).
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use utoipa::ToSchema;

pub async fn get_meta(db: &SqlitePool, key: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT value FROM meta WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await
}

pub async fn set_meta(db: &SqlitePool, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(db)
        .await
        .map(|_| ())
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct Settings {
    /// Allow self-service registration (default off).
    pub open_registration: bool,
    /// Require e-mail verification before password login (default off).
    pub require_email_verification: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SettingsPatch {
    pub open_registration: Option<bool>,
    pub require_email_verification: Option<bool>,
}

async fn get_bool(db: &SqlitePool, k: &str) -> sqlx::Result<bool> {
    Ok(get_meta(db, &format!("setting.{k}")).await?.as_deref() == Some("true"))
}

impl Settings {
    pub async fn load(db: &SqlitePool) -> sqlx::Result<Self> {
        Ok(Self {
            open_registration: get_bool(db, "open_registration").await?,
            require_email_verification: get_bool(db, "require_email_verification").await?,
        })
    }
    pub async fn apply(db: &SqlitePool, p: &SettingsPatch) -> sqlx::Result<Self> {
        if let Some(v) = p.open_registration {
            set_meta(db, "setting.open_registration", &v.to_string()).await?;
        }
        if let Some(v) = p.require_email_verification {
            set_meta(db, "setting.require_email_verification", &v.to_string()).await?;
        }
        Self::load(db).await
    }
}
