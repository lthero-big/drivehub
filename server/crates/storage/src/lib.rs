//! Storage driver abstraction. M1 implements it with OpenDAL (local/S3/OSS/OneDrive/GDrive)
//! and a bridge to rclone rcd / OpenList for drives OpenDAL lacks.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_unix: Option<i64>,
}

/// How file bytes reach the client.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferMode {
    Direct,
    Proxy,
    Auto,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("not implemented yet")]
    Unimplemented,
}

#[async_trait]
pub trait Driver: Send + Sync {
    fn kind(&self) -> &'static str;
    async fn list(&self, path: &str) -> Result<Vec<Entry>, StorageError>;
}
