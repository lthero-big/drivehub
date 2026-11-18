//! Keyword search benchmark: generates N synthetic file-metadata docs (default 100_000),
//! indexes them, then times keyword queries. Usage:
//!   cargo run --release -p drivehub-search --example bench -- [N]
use drivehub_search::{AllowAll, FileDoc, SearchIndex};
use std::time::Instant;

const ZH: &[&str] = &[
    "财务",
    "报告",
    "会议",
    "纪要",
    "合同",
    "发票",
    "项目",
    "计划",
    "设计",
    "照片",
    "旅行",
    "家庭",
    "备份",
    "数据库",
    "日志",
    "简历",
    "论文",
    "预算",
    "季度",
    "年度",
];
const EN: &[&str] = &[
    "report", "invoice", "photo", "holiday", "backup", "design", "draft", "final", "meeting",
    "budget", "resume", "paper", "video", "music", "archive", "notes", "slides", "contract",
    "plan", "data",
];
const EXT: &[&str] = &[
    "pdf", "docx", "xlsx", "jpg", "png", "mp4", "mp3", "zip", "txt", "md",
];
const MOUNTS: &[&str] = &["nas", "s3", "onedrive", "local"];

fn main() -> anyhow::Result<()> {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000);
    let mut seed: u64 = 0x9E3779B97F4A7C15;
    let mut rnd = move |m: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % m as u64) as usize
    };
    let mut per_mount: Vec<Vec<FileDoc>> = vec![Vec::new(); MOUNTS.len()];
    for i in 0..n {
        let mi = rnd(MOUNTS.len());
        let dir = format!("{}/{}{}", ZH[rnd(ZH.len())], EN[rnd(EN.len())], rnd(50));
        let name = format!(
            "{}{}_{}_{}.{}",
            ZH[rnd(ZH.len())],
            ZH[rnd(ZH.len())],
            EN[rnd(EN.len())],
            i,
            EXT[rnd(EXT.len())]
        );
        per_mount[mi].push(FileDoc {
            mount: MOUNTS[mi].into(),
            path: format!("{dir}/{name}"),
            ext: FileDoc::ext_of(&name),
            name,
            size: (rnd(1 << 20) as u64) * (1 + rnd(200) as u64),
            is_dir: false,
            modified_unix: Some(1_700_000_000 + i as i64),
        });
    }
    let dir = tempfile::tempdir()?;
    let idx = SearchIndex::open(Some(dir.path()))?;
    let t = Instant::now();
    for (mi, docs) in per_mount.iter().enumerate() {
        idx.replace_mount(MOUNTS[mi], docs)?;
    }
    println!(
        "indexed {} docs in {:.0} ms",
        idx.num_docs(),
        t.elapsed().as_secs_f64() * 1000.0
    );
    let queries = [
        "财务",
        "财务 报告",
        "invoice",
        "holiday photo",
        "合同 ext:pdf",
        "备份 size:>10m",
        "budget mount:s3",
        "年度 预算 ext:xlsx,docx",
        "report_12345",
        "会议纪要",
        "设计 final size:1m..50m",
        "不存在的词",
    ];
    // warm-up
    for q in &queries {
        idx.search(q, 50, 0, &AllowAll)?;
    }
    let mut all = Vec::new();
    for q in &queries {
        let mut v = Vec::new();
        let mut total = 0;
        for _ in 0..20 {
            let t = Instant::now();
            let r = idx.search(q, 50, 0, &AllowAll)?;
            v.push(t.elapsed().as_secs_f64() * 1000.0);
            total = r.total;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "{:<28} hits={:<6} p50={:.2}ms max={:.2}ms",
            q,
            total,
            v[v.len() / 2],
            v[v.len() - 1]
        );
        all.extend(v);
    }
    all.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "ALL {} runs: p50={:.2}ms p95={:.2}ms p99={:.2}ms max={:.2}ms",
        all.len(),
        all[all.len() / 2],
        all[all.len() * 95 / 100],
        all[all.len() * 99 / 100],
        all[all.len() - 1]
    );
    Ok(())
}
