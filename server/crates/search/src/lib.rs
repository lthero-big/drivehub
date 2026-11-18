//! Search (DEPTAI-470).
//!
//! Phase 1: tantivy keyword index over file names/paths, Chinese segmentation via jieba
//! (`tantivy-jieba`), filter syntax `ext:pdf,docx size:>10m size:<1g mount:name`.
//! Phase 2 placeholders: `Embedder` / `VectorStore` with Noop impls; `semantic`/`hybrid`
//! modes report "not enabled" until a model is configured.
//! ACL: `AclFilter` hook (AllowAll in M1; M2 plugs real users/ACL in).
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::ops::Bound;
use std::path::Path;
use std::sync::Mutex;
use tantivy::collector::{Count, TopDocs};
use tantivy::query::{BooleanQuery, Occur, Query, QueryParser, RangeQuery, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, FAST, INDEXED, STORED,
    STRING,
};
use tantivy::tokenizer::{LowerCaser, TextAnalyzer};
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};

#[async_trait]
pub trait Embedder: Send + Sync {
    /// Returns None when no model is configured.
    async fn embed(&self, text: &str) -> Option<Vec<f32>>;
    fn enabled(&self) -> bool {
        false
    }
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

/// Visibility hook applied to every hit. M2 replaces AllowAll with user/ACL checks.
pub trait AclFilter: Send + Sync {
    fn allow(&self, mount: &str, path: &str) -> bool;
}
pub struct AllowAll;
impl AclFilter for AllowAll {
    fn allow(&self, _: &str, _: &str) -> bool {
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    #[default]
    Keyword,
    Semantic,
    Hybrid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileDoc {
    pub mount: String,
    /// Path inside the mount, no leading slash.
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified_unix: Option<i64>,
}

impl FileDoc {
    pub fn ext_of(name: &str) -> String {
        match name.rsplit_once('.') {
            Some((stem, e)) if !stem.is_empty() => e.to_lowercase(),
            _ => String::new(),
        }
    }
}

/// Parsed query: free text + structured filters.
#[derive(Debug, Default, PartialEq)]
pub struct ParsedQuery {
    pub text: String,
    pub exts: Vec<String>,
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
    pub mount: Option<String>,
}

pub fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim().to_lowercase();
    let s = s.strip_suffix('b').unwrap_or(&s);
    let (num, mul) = match s.chars().last()? {
        'k' => (&s[..s.len() - 1], 1u64 << 10),
        'm' => (&s[..s.len() - 1], 1 << 20),
        'g' => (&s[..s.len() - 1], 1 << 30),
        't' => (&s[..s.len() - 1], 1 << 40),
        _ => (s, 1),
    };
    let n: f64 = num.parse().ok()?;
    Some((n * mul as f64) as u64)
}

pub fn parse_query(q: &str) -> ParsedQuery {
    let mut p = ParsedQuery::default();
    let mut text = Vec::new();
    for tok in q.split_whitespace() {
        if let Some(v) = tok.strip_prefix("ext:") {
            p.exts.extend(
                v.split(',')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.trim_start_matches('.').to_lowercase()),
            );
        } else if let Some(v) = tok.strip_prefix("mount:") {
            p.mount = Some(v.to_string());
        } else if let Some(v) = tok.strip_prefix("size:") {
            if let Some(r) = v.strip_prefix(">=") {
                p.size_min = parse_size(r);
            } else if let Some(r) = v.strip_prefix('>') {
                p.size_min = parse_size(r).map(|n| n + 1);
            } else if let Some(r) = v.strip_prefix("<=") {
                p.size_max = parse_size(r);
            } else if let Some(r) = v.strip_prefix('<') {
                p.size_max = parse_size(r).map(|n| n.saturating_sub(1));
            } else if let Some((a, b)) = v.split_once("..") {
                p.size_min = parse_size(a);
                p.size_max = parse_size(b);
            } else {
                text.push(tok);
            }
        } else {
            text.push(tok);
        }
    }
    p.text = text.join(" ");
    p
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SearchHit {
    pub score: f32,
    #[serde(flatten)]
    pub doc: FileDoc,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub total: usize,
    pub hits: Vec<SearchHit>,
    pub took_ms: f64,
}

#[derive(Clone, Copy)]
struct Fields {
    key: Field,
    mount: Field,
    path: Field,
    name: Field,
    name_text: Field,
    ext: Field,
    size: Field,
    is_dir: Field,
    modified: Field,
}

pub struct SearchIndex {
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    f: Fields,
}

const TOKENIZER: &str = "jieba_lc";

fn schema() -> (Schema, Fields) {
    let mut b = Schema::builder();
    let text = TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer(TOKENIZER)
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    );
    let f = Fields {
        key: b.add_text_field("key", STRING),
        mount: b.add_text_field("mount", STRING | STORED),
        path: b.add_text_field("path", STRING | STORED),
        name: b.add_text_field("name", STORED),
        name_text: b.add_text_field("name_text", text),
        ext: b.add_text_field("ext", STRING | STORED),
        size: b.add_u64_field("size", INDEXED | FAST | STORED),
        is_dir: b.add_u64_field("is_dir", STORED),
        modified: b.add_i64_field("modified", STORED),
    };
    (b.build(), f)
}

fn err(e: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("{e}")
}

impl SearchIndex {
    /// Opens (or creates) an on-disk index; `None` = in-RAM (tests).
    pub fn open(dir: Option<&Path>) -> anyhow::Result<Self> {
        let (schema, f) = schema();
        let index = match dir {
            Some(d) => {
                std::fs::create_dir_all(d)?;
                let mmap = tantivy::directory::MmapDirectory::open(d).map_err(err)?;
                Index::open_or_create(mmap, schema).map_err(err)?
            }
            None => Index::create_in_ram(schema),
        };
        let analyzer = TextAnalyzer::builder(tantivy_jieba::JiebaTokenizer::new())
            .filter(LowerCaser)
            .build();
        index.tokenizers().register(TOKENIZER, analyzer);
        let writer = index.writer(64 * 1024 * 1024).map_err(err)?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(err)?;
        Ok(Self {
            index,
            reader,
            writer: Mutex::new(writer),
            f,
        })
    }

    fn key(mount: &str, path: &str) -> String {
        format!("{mount}\u{1}{path}")
    }

    fn to_doc(&self, d: &FileDoc) -> TantivyDocument {
        let f = self.f;
        let mut doc = TantivyDocument::default();
        doc.add_text(f.key, Self::key(&d.mount, &d.path));
        doc.add_text(f.mount, &d.mount);
        doc.add_text(f.path, &d.path);
        doc.add_text(f.name, &d.name);
        // index name plus parent path so folder names are searchable too
        doc.add_text(f.name_text, d.path.replace(['/', '_', '-', '.'], " "));
        doc.add_text(f.ext, &d.ext);
        doc.add_u64(f.size, d.size);
        doc.add_u64(f.is_dir, d.is_dir as u64);
        doc.add_i64(f.modified, d.modified_unix.unwrap_or(0));
        doc
    }

    /// Replaces every doc of `mount` with `docs` and commits.
    pub fn replace_mount(&self, mount: &str, docs: &[FileDoc]) -> anyhow::Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.delete_term(Term::from_field_text(self.f.mount, mount));
        for d in docs {
            w.add_document(self.to_doc(d)).map_err(err)?;
        }
        w.commit().map_err(err)?;
        drop(w);
        self.reader.reload().map_err(err)?;
        Ok(())
    }

    pub fn upsert(&self, docs: &[FileDoc]) -> anyhow::Result<()> {
        let mut w = self.writer.lock().unwrap();
        for d in docs {
            w.delete_term(Term::from_field_text(
                self.f.key,
                &Self::key(&d.mount, &d.path),
            ));
            w.add_document(self.to_doc(d)).map_err(err)?;
        }
        w.commit().map_err(err)?;
        drop(w);
        self.reader.reload().map_err(err)?;
        Ok(())
    }

    pub fn remove_mount(&self, mount: &str) -> anyhow::Result<()> {
        self.replace_mount(mount, &[])
    }

    pub fn num_docs(&self) -> u64 {
        self.reader.searcher().num_docs()
    }

    pub fn build_query(&self, p: &ParsedQuery) -> Box<dyn Query> {
        let f = self.f;
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        if !p.text.trim().is_empty() {
            let mut qp = QueryParser::for_index(&self.index, vec![f.name_text]);
            qp.set_conjunction_by_default();
            let (q, _errs) = qp.parse_query_lenient(&p.text.replace(['/', '_', '-', '.'], " "));
            clauses.push((Occur::Must, q));
        }
        if !p.exts.is_empty() {
            let any: Vec<(Occur, Box<dyn Query>)> = p
                .exts
                .iter()
                .map(|e| {
                    (
                        Occur::Should,
                        Box::new(TermQuery::new(
                            Term::from_field_text(f.ext, e),
                            IndexRecordOption::Basic,
                        )) as Box<dyn Query>,
                    )
                })
                .collect();
            clauses.push((Occur::Must, Box::new(BooleanQuery::new(any))));
        }
        if let Some(m) = &p.mount {
            clauses.push((
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_text(f.mount, m),
                    IndexRecordOption::Basic,
                )),
            ));
        }
        if p.size_min.is_some() || p.size_max.is_some() {
            let lo = p.size_min.map_or(Bound::Unbounded, |v| {
                Bound::Included(Term::from_field_u64(f.size, v))
            });
            let hi = p.size_max.map_or(Bound::Unbounded, |v| {
                Bound::Included(Term::from_field_u64(f.size, v))
            });
            clauses.push((Occur::Must, Box::new(RangeQuery::new(lo, hi))));
        }
        if clauses.is_empty() {
            return Box::new(tantivy::query::AllQuery);
        }
        Box::new(BooleanQuery::new(clauses))
    }

    pub fn search(
        &self,
        q: &str,
        limit: usize,
        offset: usize,
        acl: &dyn AclFilter,
    ) -> anyhow::Result<SearchResult> {
        let t0 = std::time::Instant::now();
        let parsed = parse_query(q);
        let query = self.build_query(&parsed);
        let searcher = self.reader.searcher();
        let (total, top) = searcher
            .search(
                &query,
                &(
                    Count,
                    TopDocs::with_limit(limit.max(1))
                        .and_offset(offset)
                        .order_by_score(),
                ),
            )
            .map_err(err)?;
        let f = self.f;
        let mut hits = Vec::with_capacity(top.len());
        for (score, addr) in top {
            let d: TantivyDocument = searcher.doc(addr).map_err(err)?;
            let s = |fl: Field| {
                d.get_first(fl)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let u = |fl: Field| d.get_first(fl).and_then(|v| v.as_u64()).unwrap_or(0);
            let m = d
                .get_first(f.modified)
                .and_then(|v| v.as_i64())
                .filter(|v| *v != 0);
            let doc = FileDoc {
                mount: s(f.mount),
                path: s(f.path),
                name: s(f.name),
                ext: s(f.ext),
                size: u(f.size),
                is_dir: u(f.is_dir) == 1,
                modified_unix: m,
            };
            if acl.allow(&doc.mount, &doc.path) {
                hits.push(SearchHit { score, doc });
            }
        }
        Ok(SearchResult {
            total,
            hits,
            took_ms: t0.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(mount: &str, path: &str, size: u64) -> FileDoc {
        let name = path.rsplit('/').next().unwrap().to_string();
        FileDoc {
            mount: mount.into(),
            path: path.into(),
            ext: FileDoc::ext_of(&name),
            name,
            size,
            is_dir: false,
            modified_unix: Some(1),
        }
    }

    #[test]
    fn parses_filters() {
        let p = parse_query("年度 报告 ext:pdf,.DOCX size:>10m mount:nas");
        assert_eq!(p.text, "年度 报告");
        assert_eq!(p.exts, vec!["pdf", "docx"]);
        assert_eq!(p.size_min, Some(10 * 1024 * 1024 + 1));
        assert_eq!(p.mount.as_deref(), Some("nas"));
        assert_eq!(parse_size("1.5k"), Some(1536));
        assert_eq!(parse_size("2GB"), Some(2 << 30));
        let r = parse_query("size:1m..2m");
        assert_eq!((r.size_min, r.size_max), (Some(1 << 20), Some(2 << 20)));
    }

    #[test]
    fn keyword_chinese_and_filters() {
        let idx = SearchIndex::open(None).unwrap();
        idx.replace_mount(
            "nas",
            &[
                doc("nas", "工作/2024年度财务报告.pdf", 20 << 20),
                doc("nas", "工作/会议纪要.docx", 1 << 10),
                doc("nas", "photos/Holiday_Beach.JPG", 5 << 20),
            ],
        )
        .unwrap();
        idx.replace_mount("s3", &[doc("s3", "backup/财务报告-副本.pdf", 1 << 10)])
            .unwrap();
        let r = idx.search("财务", 10, 0, &AllowAll).unwrap();
        assert_eq!(r.total, 2);
        let r = idx.search("财务 size:>10m", 10, 0, &AllowAll).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.hits[0].doc.path, "工作/2024年度财务报告.pdf");
        assert_eq!(
            idx.search("报告 mount:s3", 10, 0, &AllowAll).unwrap().total,
            1
        );
        assert_eq!(idx.search("ext:jpg", 10, 0, &AllowAll).unwrap().total, 1);
        assert_eq!(idx.search("beach", 10, 0, &AllowAll).unwrap().total, 1);
        assert_eq!(idx.search("工作", 10, 0, &AllowAll).unwrap().total, 2);
        // replace drops old docs of that mount only
        idx.replace_mount("nas", &[doc("nas", "x.txt", 1)]).unwrap();
        assert_eq!(idx.num_docs(), 2);
        struct DenyS3;
        impl AclFilter for DenyS3 {
            fn allow(&self, m: &str, _: &str) -> bool {
                m != "s3"
            }
        }
        assert_eq!(idx.search("", 10, 0, &DenyS3).unwrap().hits.len(), 1);
    }

    #[test]
    fn on_disk_reopen() {
        let dir = tempfile::tempdir().unwrap();
        {
            let idx = SearchIndex::open(Some(dir.path())).unwrap();
            idx.upsert(&[doc("m", "a/测试文件.txt", 3)]).unwrap();
            idx.upsert(&[doc("m", "a/测试文件.txt", 4)]).unwrap();
        }
        let idx = SearchIndex::open(Some(dir.path())).unwrap();
        let r = idx.search("测试", 10, 0, &AllowAll).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.hits[0].doc.size, 4);
    }

    #[tokio::test]
    async fn noop_semantic() {
        assert!(NoopEmbedder.embed("x").await.is_none());
        assert!(!NoopEmbedder.enabled());
        assert!(NoopVectorStore.query(&[0.0], 3).await.is_empty());
    }
}
