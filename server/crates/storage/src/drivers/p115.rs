//! Native 115 driver (DEPTAI-481), phase 1.
//!
//! Rust port of OpenList `drivers/115` (https://github.com/OpenListTeam/OpenList @ 7c26f10,
//! AGPL-3.0) and the protocol pieces of SheltonZhu/115driver v1.3.5 (MIT) it relies on:
//! cookie credential + `check/sso`, `webapi.115.com/files` listing, `files/add|move|copy|
//! batch_rename`, `rb/delete`, and `proapi.115.com/app/chrome/downurl` with the m115
//! (RSA + XOR) envelope. See NOTICE / THIRD_PARTY.md.
//!
//! Options: cookie ("UID=..; CID=..; SEID=..; KID=.."), root_id (default "0"), user_agent,
//! page_size; test overrides: webapi_endpoint, proapi_endpoint, passport_endpoint, m115_n.
//! Not yet ported: upload (initupload sig/token + ec115 + OSS), QR-code login.
use crate::{norm, ByteRange, ByteStream, Entry, Result, StorageDriver, StorageError};
use async_trait::async_trait;
use bytes::Bytes;
use futures::{StreamExt, TryStreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

pub const UA_115_BROWSER: &str = "Mozilla/5.0 115Browser/27.0.5.7";

/// m115 envelope used by the 115 download API (port of 115driver/pkg/crypto/m115).
pub mod m115 {
    use num_bigint::BigUint;

    pub const N_HEX: &str = "8686980c0f5a24c4b9d43020cd2c22703ff3f450756529058b1cf88f09b8602136477198a6e2683149659bd122c33592fdb5ad47944ad1ea4d36c6b172aad6338c3bb6ac6227502d010993ac967d1aef00f0c8e038de2e4d3bc2ec368af2e9f10a6f1eda4f7262f136420c07c331b871bf139f74f3010e3c4fe57df3afb71683";

    const XOR_KEY_SEED: [u8; 144] = [
        0xf0, 0xe5, 0x69, 0xae, 0xbf, 0xdc, 0xbf, 0x8a, 0x1a, 0x45, 0xe8, 0xbe, 0x7d, 0xa6, 0x73,
        0xb8, 0xde, 0x8f, 0xe7, 0xc4, 0x45, 0xda, 0x86, 0xc4, 0x9b, 0x64, 0x8b, 0x14, 0x6a, 0xb4,
        0xf1, 0xaa, 0x38, 0x01, 0x35, 0x9e, 0x26, 0x69, 0x2c, 0x86, 0x00, 0x6b, 0x4f, 0xa5, 0x36,
        0x34, 0x62, 0xa6, 0x2a, 0x96, 0x68, 0x18, 0xf2, 0x4a, 0xfd, 0xbd, 0x6b, 0x97, 0x8f, 0x4d,
        0x8f, 0x89, 0x13, 0xb7, 0x6c, 0x8e, 0x93, 0xed, 0x0e, 0x0d, 0x48, 0x3e, 0xd7, 0x2f, 0x88,
        0xd8, 0xfe, 0xfe, 0x7e, 0x86, 0x50, 0x95, 0x4f, 0xd1, 0xeb, 0x83, 0x26, 0x34, 0xdb, 0x66,
        0x7b, 0x9c, 0x7e, 0x9d, 0x7a, 0x81, 0x32, 0xea, 0xb6, 0x33, 0xde, 0x3a, 0xa9, 0x59, 0x34,
        0x66, 0x3b, 0xaa, 0xba, 0x81, 0x60, 0x48, 0xb9, 0xd5, 0x81, 0x9c, 0xf8, 0x6c, 0x84, 0x77,
        0xff, 0x54, 0x78, 0x26, 0x5f, 0xbe, 0xe8, 0x1e, 0x36, 0x9f, 0x34, 0x80, 0x5c, 0x45, 0x2c,
        0x9b, 0x76, 0xd5, 0x1b, 0x8f, 0xcc, 0xc3, 0xb8, 0xf5,
    ];
    pub const XOR_CLIENT_KEY: [u8; 12] = [
        0x78, 0x06, 0xad, 0x4c, 0x33, 0x86, 0x5d, 0x18, 0x4c, 0x01, 0x3f, 0x46,
    ];

    pub fn derive_key(seed: &[u8], size: usize) -> Vec<u8> {
        (0..size)
            .map(|i| {
                seed[i].wrapping_add(XOR_KEY_SEED[size * i]) ^ XOR_KEY_SEED[size * (size - i - 1)]
            })
            .collect()
    }

    pub fn xor_transform(data: &mut [u8], key: &[u8]) {
        let m = data.len() % 4;
        for (i, b) in data.iter_mut().enumerate() {
            *b ^= if i < m {
                key[i % key.len()]
            } else {
                key[(i - m) % key.len()]
            };
        }
    }

    /// Non-cryptographic filler (padding / per-request key); the envelope is obfuscation, not secrecy.
    pub fn filler(n: usize) -> Vec<u8> {
        let mut x = SystemTime_now_nanos() ^ 0x9e37_79b9_7f4a_7c15;
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x >> 24) as u8
            })
            .collect()
    }

    #[allow(non_snake_case)]
    fn SystemTime_now_nanos() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static C: AtomicU64 = AtomicU64::new(0);
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        t.wrapping_add(C.fetch_add(0x5851_f42d, Ordering::Relaxed))
    }

    pub struct Rsa {
        pub n: BigUint,
        pub e: BigUint,
        pub klen: usize,
    }

    impl Rsa {
        pub fn new(n_hex: &str) -> Self {
            let n = BigUint::parse_bytes(n_hex.as_bytes(), 16).expect("m115 modulus");
            let klen = (n.bits() as usize) / 8;
            Self {
                n,
                e: BigUint::from(0x10001u32),
                klen,
            }
        }

        pub fn encrypt(&self, mut input: &[u8]) -> Vec<u8> {
            let mut out = Vec::new();
            while !input.is_empty() {
                let take = input.len().min(self.klen - 11);
                let (chunk, rest) = input.split_at(take);
                let pad = self.klen - chunk.len() - 3;
                let mut buf = vec![0u8, 2];
                buf.extend(filler(pad).into_iter().map(|b| b % 0xff + 1));
                buf.push(0);
                buf.extend_from_slice(chunk);
                let r = BigUint::from_bytes_be(&buf)
                    .modpow(&self.e, &self.n)
                    .to_bytes_be();
                out.extend(std::iter::repeat_n(0u8, self.klen.saturating_sub(r.len())));
                out.extend(r);
                input = rest;
            }
            out
        }

        pub fn decrypt(&self, input: &[u8]) -> Vec<u8> {
            let mut out = Vec::new();
            for chunk in input.chunks(self.klen) {
                let r = BigUint::from_bytes_be(chunk)
                    .modpow(&self.e, &self.n)
                    .to_bytes_be();
                if let Some(i) = r
                    .iter()
                    .enumerate()
                    .skip(1)
                    .find(|(_, b)| **b == 0)
                    .map(|(i, _)| i)
                {
                    out.extend_from_slice(&r[i + 1..]);
                }
            }
            out
        }
    }

    pub fn encode(rsa: &Rsa, input: &[u8], key: &[u8; 16]) -> String {
        let mut body = input.to_vec();
        xor_transform(&mut body, &derive_key(key, 4));
        body.reverse();
        xor_transform(&mut body, &XOR_CLIENT_KEY);
        let mut buf = key.to_vec();
        buf.extend(body);
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(rsa.encrypt(&buf))
    }

    pub fn decode(rsa: &Rsa, input: &str, key: &[u8; 16]) -> Option<Vec<u8>> {
        use base64::Engine;
        let data = rsa.decrypt(
            &base64::engine::general_purpose::STANDARD
                .decode(input)
                .ok()?,
        );
        if data.len() < 16 {
            return None;
        }
        let mut out = data[16..].to_vec();
        xor_transform(&mut out, &derive_key(&data[..16], 12));
        out.reverse();
        xor_transform(&mut out, &derive_key(key, 4));
        Some(out)
    }
}

#[derive(Clone, Debug)]
struct RFile {
    id: String,
    pick_code: String,
    name: String,
    is_dir: bool,
    size: u64,
    modified: Option<i64>,
}

fn be(e: impl std::fmt::Display) -> StorageError {
    StorageError::Backend(format!("115: {e}"))
}

fn sval(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

pub struct P115Driver {
    http: reqwest::Client,
    cookie: String,
    ua: String,
    root_id: String,
    page_size: u32,
    webapi: String,
    proapi: String,
    passport: String,
    rsa: m115::Rsa,
    checked: Mutex<bool>,
}

impl P115Driver {
    pub fn new(opts: &HashMap<String, String>) -> Result<Self> {
        let get = |k: &str| opts.get(k).cloned().filter(|s| !s.is_empty());
        let cookie = get("cookie").ok_or_else(|| {
            StorageError::Config(
                "115: missing 'cookie' (UID=..; CID=..; SEID=..; KID=..); QR login not ported yet"
                    .into(),
            )
        })?;
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .map_err(be)?,
            cookie,
            ua: get("user_agent").unwrap_or_else(|| UA_115_BROWSER.into()),
            root_id: get("root_id").unwrap_or_else(|| "0".into()),
            page_size: get("page_size")
                .and_then(|s| s.parse().ok())
                .unwrap_or(1000)
                .min(1150),
            webapi: get("webapi_endpoint").unwrap_or_else(|| "https://webapi.115.com".into()),
            proapi: get("proapi_endpoint").unwrap_or_else(|| "https://proapi.115.com".into()),
            passport: get("passport_endpoint")
                .unwrap_or_else(|| "https://passportapi.115.com".into()),
            rsa: m115::Rsa::new(get("m115_n").as_deref().unwrap_or(m115::N_HEX)),
            checked: Mutex::new(false),
        })
    }

    fn req(&self, m: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        self.http
            .request(m, url)
            .header("Cookie", &self.cookie)
            .header("User-Agent", &self.ua)
    }

    async fn login_check(&self) -> Result<()> {
        let mut g = self.checked.lock().await;
        if *g {
            return Ok(());
        }
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string();
        let v: Value = self
            .req(
                reqwest::Method::GET,
                &format!("{}/app/1.0/web/1.0/check/sso", self.passport),
            )
            .query(&[("_", ms)])
            .send()
            .await
            .map_err(be)?
            .json()
            .await
            .map_err(be)?;
        if v.get("state").and_then(|x| x.as_i64()).unwrap_or(1) != 0 {
            return Err(StorageError::Config(format!(
                "115: cookie login check failed: {v}"
            )));
        }
        *g = true;
        Ok(())
    }

    fn check_basic(v: &Value) -> Result<()> {
        if v.get("state").and_then(|x| x.as_bool()).unwrap_or(false) {
            return Ok(());
        }
        let msg = format!(
            "{} {} {}",
            sval(v, "errno"),
            sval(v, "error"),
            sval(v, "msg")
        );
        if msg.contains("20004") || msg.contains("990002") || msg.contains("不存在") {
            return Err(StorageError::NotFound(msg));
        }
        Err(be(msg))
    }

    async fn form(&self, path: &str, form: &[(String, String)]) -> Result<Value> {
        self.login_check().await?;
        let v: Value = self
            .req(reqwest::Method::POST, &format!("{}{}", self.webapi, path))
            .form(form)
            .send()
            .await
            .map_err(be)?
            .json()
            .await
            .map_err(be)?;
        Self::check_basic(&v)?;
        Ok(v)
    }

    async fn list_id(&self, cid: &str) -> Result<Vec<RFile>> {
        self.login_check().await?;
        let mut out = Vec::new();
        let mut offset = 0u64;
        loop {
            let v: Value = self
                .req(reqwest::Method::GET, &format!("{}/files", self.webapi))
                .query(&[
                    ("aid", "1"),
                    ("cid", cid),
                    ("o", "user_ptime"),
                    ("asc", "1"),
                    ("offset", &offset.to_string()),
                    ("show_dir", "1"),
                    ("limit", &self.page_size.to_string()),
                    ("snap", "0"),
                    ("natsort", "0"),
                    ("record_open_time", "1"),
                    ("format", "json"),
                    ("fc_mix", "0"),
                ])
                .send()
                .await
                .map_err(be)?
                .json()
                .await
                .map_err(be)?;
            Self::check_basic(&v)?;
            // 115 answers the root listing for unknown cids; upstream treats a cid mismatch as empty/missing.
            if sval(&v, "cid") != cid {
                return Err(StorageError::NotFound(format!("cid {cid}")));
            }
            for f in v
                .get("data")
                .and_then(|x| x.as_array())
                .into_iter()
                .flatten()
            {
                let fid = sval(f, "fid");
                let is_dir = fid.is_empty();
                out.push(RFile {
                    id: if is_dir { sval(f, "cid") } else { fid },
                    pick_code: sval(f, "pc"),
                    name: sval(f, "n"),
                    is_dir,
                    size: sval(f, "s").parse().unwrap_or(0),
                    modified: sval(f, "te")
                        .parse()
                        .ok()
                        .or_else(|| sval(f, "t").parse().ok()),
                });
            }
            let count = v.get("count").and_then(|x| x.as_u64()).unwrap_or(0);
            offset =
                v.get("offset").and_then(|x| x.as_u64()).unwrap_or(offset) + self.page_size as u64;
            if offset >= count {
                return Ok(out);
            }
        }
    }

    async fn resolve(&self, path: &str) -> Result<RFile> {
        let p = norm(path)?;
        let mut cur = RFile {
            id: self.root_id.clone(),
            pick_code: String::new(),
            name: String::new(),
            is_dir: true,
            size: 0,
            modified: None,
        };
        for part in p.split('/').filter(|s| !s.is_empty()) {
            if !cur.is_dir {
                return Err(StorageError::NotFound(p.clone()));
            }
            cur = self
                .list_id(&cur.id)
                .await?
                .into_iter()
                .find(|f| f.name == part)
                .ok_or_else(|| StorageError::NotFound(p.clone()))?;
        }
        Ok(cur)
    }

    fn split(path: &str) -> Result<(String, String)> {
        let p = norm(path)?;
        if p.is_empty() {
            return Err(StorageError::Config("115: root has no parent".into()));
        }
        Ok(match p.rsplit_once('/') {
            Some((a, b)) => (a.into(), b.into()),
            None => (String::new(), p),
        })
    }

    async fn mkdir_id(&self, path: &str) -> Result<String> {
        let mut id = self.root_id.clone();
        for part in norm(path)?.split('/').filter(|s| !s.is_empty()) {
            id = match self
                .list_id(&id)
                .await?
                .into_iter()
                .find(|f| f.name == part)
            {
                Some(f) if f.is_dir => f.id,
                Some(_) => return Err(StorageError::AlreadyExists(format!("{part} is a file"))),
                None => {
                    let v = self
                        .form(
                            "/files/add",
                            &[("pid".into(), id.clone()), ("cname".into(), part.into())],
                        )
                        .await?;
                    sval(&v, "cid")
                }
            };
        }
        Ok(id)
    }

    /// Direct URL for a pick code (m115-wrapped `app/chrome/downurl`).
    pub async fn download_url(&self, pick_code: &str) -> Result<String> {
        self.login_check().await?;
        let key: [u8; 16] = m115::filler(16).try_into().unwrap();
        let data = m115::encode(
            &self.rsa,
            serde_json::json!({"pickcode": pick_code})
                .to_string()
                .as_bytes(),
            &key,
        );
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string();
        let v: Value = self
            .req(
                reqwest::Method::POST,
                &format!("{}/app/chrome/downurl", self.proapi),
            )
            .query(&[("t", t)])
            .form(&[("data", data)])
            .send()
            .await
            .map_err(be)?
            .json()
            .await
            .map_err(be)?;
        Self::check_basic(&v)?;
        let enc = sval(&v, "data");
        let plain = m115::decode(&self.rsa, &enc, &key).ok_or_else(|| be("m115 decode failed"))?;
        let info: Value = serde_json::from_slice(&plain).map_err(be)?;
        info.as_object()
            .and_then(|m| m.values().next())
            .and_then(|i| i.pointer("/url/url"))
            .and_then(|u| u.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .ok_or_else(|| be("download url missing"))
    }
}

#[async_trait]
impl StorageDriver for P115Driver {
    fn kind(&self) -> &'static str {
        "p115"
    }

    async fn list(&self, path: &str) -> Result<Vec<Entry>> {
        let p = norm(path)?;
        let d = self.resolve(&p).await?;
        if !d.is_dir {
            return Err(StorageError::Config(format!("not a directory: {p}")));
        }
        Ok(self
            .list_id(&d.id)
            .await?
            .into_iter()
            .map(|f| Entry {
                path: if p.is_empty() {
                    f.name.clone()
                } else {
                    format!("{p}/{}", f.name)
                },
                name: f.name,
                is_dir: f.is_dir,
                size: if f.is_dir { 0 } else { f.size },
                modified_unix: f.modified,
            })
            .collect())
    }

    async fn list_recursive(&self, path: &str) -> Result<Vec<Entry>> {
        let mut out = Vec::new();
        let mut stack = vec![norm(path)?];
        while let Some(d) = stack.pop() {
            for e in self.list(&d).await? {
                if e.is_dir {
                    stack.push(e.path.clone());
                }
                out.push(e);
            }
        }
        Ok(out)
    }

    async fn stat(&self, path: &str) -> Result<Entry> {
        let p = norm(path)?;
        let f = self.resolve(&p).await?;
        Ok(Entry {
            name: p.rsplit('/').next().unwrap_or("").into(),
            path: p,
            is_dir: f.is_dir,
            size: if f.is_dir { 0 } else { f.size },
            modified_unix: f.modified,
        })
    }

    async fn read(&self, path: &str, range: Option<ByteRange>) -> Result<ByteStream> {
        let f = self.resolve(path).await?;
        if f.is_dir {
            return Err(StorageError::Config("cannot read a directory".into()));
        }
        let url = self.download_url(&f.pick_code).await?;
        // 115 CDN checks the UA (and cookie) used to obtain the link.
        let mut rb = self.req(reqwest::Method::GET, &url);
        if let Some(r) = range {
            rb = rb.header(
                "Range",
                match r.end {
                    Some(e) if e > r.start => format!("bytes={}-{}", r.start, e - 1),
                    _ => format!("bytes={}-", r.start),
                },
            );
        }
        let resp = rb.send().await.map_err(be)?;
        if !resp.status().is_success() {
            return Err(be(format!("download HTTP {}", resp.status())));
        }
        Ok(resp.bytes_stream().map_err(std::io::Error::other).boxed())
    }

    async fn write(&self, _path: &str, _data: Bytes) -> Result<()> {
        Err(StorageError::Unsupported(
            "115: upload not ported yet (DEPTAI-481 phase 2)".into(),
        ))
    }

    async fn write_stream(
        &self,
        path: &str,
        _data: ByteStream,
        _p: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<u64> {
        self.write(path, Bytes::new()).await.map(|_| 0)
    }

    async fn mkdir(&self, path: &str) -> Result<()> {
        self.mkdir_id(path).await.map(|_| ())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let (fp, _) = Self::split(from)?;
        let (tp, tname) = Self::split(to)?;
        let f = self.resolve(from).await?;
        if fp != tp {
            let pid = self.mkdir_id(&tp).await?;
            self.form(
                "/files/move",
                &[("pid".into(), pid), ("fid[0]".into(), f.id.clone())],
            )
            .await?;
        }
        if f.name != tname {
            self.form(
                "/files/batch_rename",
                &[
                    ("fid".into(), f.id.clone()),
                    ("file_name".into(), tname.clone()),
                    (format!("files_new_name[{}]", f.id), tname),
                ],
            )
            .await?;
        }
        Ok(())
    }

    async fn r#move(&self, from: &str, to: &str) -> Result<()> {
        self.rename(from, to).await
    }

    async fn copy(&self, from: &str, to: &str) -> Result<()> {
        let (_, fname) = Self::split(from)?;
        let (tp, tname) = Self::split(to)?;
        let f = self.resolve(from).await?;
        let pid = self.mkdir_id(&tp).await?;
        let before: Vec<String> = self
            .list_id(&pid)
            .await?
            .into_iter()
            .map(|x| x.id)
            .collect();
        self.form(
            "/files/copy",
            &[("pid".into(), pid.clone()), ("fid[0]".into(), f.id.clone())],
        )
        .await?;
        if fname != tname {
            let new = self
                .list_id(&pid)
                .await?
                .into_iter()
                .find(|x| !before.contains(&x.id) && x.id != f.id)
                .ok_or_else(|| be("copied object not found"))?;
            self.form(
                "/files/batch_rename",
                &[
                    ("fid".into(), new.id.clone()),
                    ("file_name".into(), tname.clone()),
                    (format!("files_new_name[{}]", new.id), tname),
                ],
            )
            .await?;
        }
        Ok(())
    }

    async fn delete(&self, path: &str) -> Result<()> {
        match self.resolve(path).await {
            Ok(f) if f.id != self.root_id => self
                .form("/rb/delete", &[("fid[0]".into(), f.id)])
                .await
                .map(|_| ()),
            Ok(_) => Err(StorageError::Config("115: refusing to delete root".into())),
            Err(StorageError::NotFound(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    async fn link(&self, path: &str, _expire: Duration) -> Result<Option<String>> {
        let f = self.resolve(path).await?;
        if f.is_dir {
            return Ok(None);
        }
        // 115 links are bound to the requesting UA/cookie, so a bare redirect usually fails;
        // return None to make Auto mode proxy through DriveHub.
        let _ = self.download_url(&f.pick_code).await?;
        Ok(None)
    }
}
