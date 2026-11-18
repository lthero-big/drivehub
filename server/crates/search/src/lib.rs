//! Search. Phase 1: tantivy + jieba keyword index (M1). Phase 2 placeholders:
//! Embedder / VectorStore with Noop impls so callers can wire hybrid search (RRF) later.
use async_trait::async_trait;

#[async_trait]
pub trait Embedder: Send + Sync {
    /// Returns None when no model is configured.
    async fn embed(&self, text: &str) -> Option<Vec<f32>>;
}

#[async_trait]
pub trait VectorStore: Send + Sync {
    async fn upsert(&self, id: &str, vector: Vec<f32>);
    async fn query(&self, vector: &[f32], k: usize) -> Vec<(String, f32)>;
}

pub struct NoopEmbedder;
pub struct NoopVectorStore;

#[async_trait]
impl Embedder for NoopEmbedder {
    async fn embed(&self, _text: &str) -> Option<Vec<f32>> {
        None
    }
}

#[async_trait]
impl VectorStore for NoopVectorStore {
    async fn upsert(&self, _id: &str, _vector: Vec<f32>) {}
    async fn query(&self, _vector: &[f32], _k: usize) -> Vec<(String, f32)> {
        Vec::new()
    }
}
