//! Native PikPak driver (DEPTAI-481).
//!
//! Rust port of OpenList `drivers/pikpak` (driver.go / util.go / types.go,
//! https://github.com/OpenListTeam/OpenList @ 7c26f10, AGPL-3.0; see NOTICE).
//! Protocol constants (client ids, captcha-sign algorithms, endpoints) follow upstream.
//!
//! Options: username, password, platform (web|android|pc, default web), refresh_token,
//! captcha_token, device_id, root_id (default ""), skip_verification (true = ignore the
//! human-verification URL like upstream; may trigger risk control), and for tests / proxies
//! user_endpoint, api_endpoint, oss_endpoint (override `https://{bucket}.{endpoint}`),
//! upload_part_size (bytes, default 16 MiB: single PUT up to it, OSS multipart above).
//! A rotated refresh_token is reported through `set_option_sink` for persistence.
use super::Src;
use crate::{norm, ByteRange, ByteStream, Entry, Result, StorageDriver, StorageError};
use async_trait::async_trait;
use bytes::Bytes;
use futures::{StreamExt, TryStreamExt};
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use serde_json::{json, Value};
use sha1::Sha1;
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const WEB_ALGORITHMS: &[&str] = &[
    "C9qPpZLN8ucRTaTiUMWYS9cQvWOE",
    "+r6CQVxjzJV6LCV",
    "F",
    "pFJRC",
    "9WXYIDGrwTCz2OiVlgZa90qpECPD6olt",
    "/750aCr4lm/Sly/c",
    "RB+DT/gZCrbV",
    "",
    "CyLsf7hdkIRxRm215hl",
    "7xHvLi2tOYP0Y92b",
    "ZGTXXxu8E/MIWaEDB+Sm/",
    "1UI3",
    "E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO",
    "ihtqpG6FMt65+Xk+tWUH2",
    "NhXXU9rg4XXdzo7u5o",
];
const ANDROID_ALGORITHMS: &[&str] = &[
    "SOP04dGzk0TNO7t7t9ekDbAmx+eq0OI1ovEx",
    "nVBjhYiND4hZ2NCGyV5beamIr7k6ifAsAbl",
    "Ddjpt5B/Cit6EDq2a6cXgxY9lkEIOw4yC1GDF28KrA",
    "VVCogcmSNIVvgV6U+AochorydiSymi68YVNGiz",
    "u5ujk5sM62gpJOsB/1Gu/zsfgfZO",
    "dXYIiBOAHZgzSruaQ2Nhrqc2im",
    "z5jUTBSIpBN9g4qSJGlidNAutX6",
    "KJE2oveZ34du/g1tiimm",
];
const PC_ALGORITHMS: &[&str] = &[
    "KHBJ07an7ROXDoK7Db",
    "G6n399rSWkl7WcQmw5rpQInurc1DkLmLJqE",
    "JZD1A3M4x+jBFN62hkr7VDhkkZxb9g3rWqRZqFAAb",
    "fQnw/AmSlbbI91Ik15gpddGgyU7U",
    "/Dv9JdPYSj3sHiWjouR95NTQff",
    "yGx2zuTjbWENZqecNI+edrQgqmZKP",
    "ljrbSzdHLwbqcRn",
    "lSHAsqCkGDGxQqqwrVu",
    "TsWXI81fD1",
    "vk7hBjawK/rOSrSWajtbMk95nfgf3",
];

/// Default OSS part size (also the single-PUT threshold).
const DEFAULT_PART: u64 = 16 << 20;

struct Platform {
    client_id: &'static str,
    client_secret: &'static str,
    client_version: &'static str,
    package_name: &'static str,
    algorithms: &'static [&'static str],
    user_agent: &'static str,
}

fn platform(name: &str) -> Result<Platform> {
    Ok(match name {
        "" | "web" => Platform {
            client_id: "YUMx5nI8ZU8Ap8pm",
            client_secret: "dbw2OtmVEeuUvIptb1Coyg",
            client_version: "2.0.0",
            package_name: "mypikpak.com",
            algorithms: WEB_ALGORITHMS,
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
        },
        "android" => Platform {
            client_id: "YNxT9w7GMdWvEOKa",
            client_secret: "dbw2OtmVEeuUvIptb1Coyg",
            client_version: "1.53.2",
            package_name: "com.pikcloud.pikpak",
            algorithms: ANDROID_ALGORITHMS,
            user_agent: "ANDROID-com.pikcloud.pikpak/1.53.2 protocolVersion/200 clientid/YNxT9w7GMdWvEOKa networktype/WIFI devicename/Xiaomi_M2004j7ac osversion/13",
        },
        "pc" => Platform {
            client_id: "YvtoWO6GNHiuCl7x",
            client_secret: "1NIH5R1IEe2pAxZE3hv3uA",
            client_version: "undefined",
            package_name: "mypikpak.com",
            algorithms: PC_ALGORITHMS,
            user_agent: "MainWindow Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) PikPak/2.6.11.4955 Chrome/100.0.4896.160 Electron/18.3.15 Safari/537.36",
        },
        o => return Err(StorageError::Config(format!("pikpak: unknown platform '{o}'"))),
    })
}

pub fn md5_hex(s: &str) -> String {
    hex(&Md5::digest(s.as_bytes()))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `captcha_sign` = "1." + md5 chain over client_id+version+package+device+ts and each algorithm.
pub fn captcha_sign(
    client_id: &str,
    version: &str,
    package: &str,
    device_id: &str,
    ts: &str,
    algs: &[&str],
) -> String {
    let mut s = format!("{client_id}{version}{package}{device_id}{ts}");
    for a in algs {
        s = md5_hex(&format!("{s}{a}"));
    }
    format!("1.{s}")
}

/// Thunder/PikPak GCID (upper-case hex), port of OpenList pkg/utils/hash/gcid.go.
pub fn gcid(data: &[u8]) -> String {
    let psize = gcid_block(data.len() as u64) as usize;
    let mut outer = Sha1::new();
    for chunk in data.chunks(psize) {
        outer.update(Sha1::digest(chunk));
    }
    hex(&outer.finalize()).to_uppercase()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// `GET:/drive/v1/files` style action from a URL.
fn action(method: &str, url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let path = rest.find('/').map(|i| &rest[i..]).unwrap_or("");
    let path = path.split(['?', '#']).next().unwrap_or("");
    format!("{method}:{path}")
}

#[derive(Default)]
struct Tokens {
    access: String,
    refresh: String,
    captcha: String,
    user_id: String,
}

pub struct PikPakDriver {
    http: reqwest::Client,
    p: Platform,
    username: String,
    password: String,
    device_id: String,
    root_id: String,
    user_ep: String,
    api_ep: String,
    oss_ep: Option<String>,
    skip_verification: bool,
    tok: Mutex<Tokens>,
    inited: Mutex<bool>,
    part_size: u64,
    sink: std::sync::Mutex<Option<crate::OptionSink>>,
}

async fn gcid_src(src: &Src) -> Result<String> {
    let n = src.len();
    let psize = gcid_block(n);
    let mut outer = Sha1::new();
    let mut off = 0;
    while off < n {
        let len = psize.min(n - off);
        outer.update(Sha1::digest(&src.slice(off, len).await?));
        off += len;
    }
    Ok(hex(&outer.finalize()).to_uppercase())
}

/// GCID block size for a payload of `n` bytes (256 KiB doubling up to 2 MiB, <= 512 blocks).
fn gcid_block(n: u64) -> u64 {
    let mut psize: u64 = 0x40000;
    while n as f64 / psize as f64 > 512.0 && psize < 0x200000 {
        psize <<= 1;
    }
    psize
}

/// Minimal XML text extraction (`<tag>value</tag>`), enough for OSS multipart replies.
fn xml_tag(body: &str, tag: &str) -> Option<String> {
    let a = body.find(&format!("<{tag}>"))? + tag.len() + 2;
    let b = body[a..].find(&format!("</{tag}>"))? + a;
    Some(body[a..b].to_string())
}

fn be(e: impl std::fmt::Display) -> StorageError {
    StorageError::Backend(format!("pikpak: {e}"))
}

#[derive(Clone, Debug)]
struct RFile {
    id: String,
    name: String,
    is_dir: bool,
    size: u64,
    modified: Option<i64>,
}

fn rfile(v: &Value) -> RFile {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    RFile {
        id: s("id"),
        name: s("name"),
        is_dir: s("kind") == "drive#folder",
        size: s("size").parse().unwrap_or(0),
        modified: parse_rfc3339(&s("modified_time")),
    }
}

/// Minimal RFC3339 → unix seconds (UTC offsets honoured).
fn parse_rfc3339(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let n = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (
        n(0, 4)?,
        n(5, 7)?,
        n(8, 10)?,
        n(11, 13)?,
        n(14, 16)?,
        n(17, 19)?,
    );
    let (yy, mm) = if mo <= 2 {
        (y - 1, mo + 9)
    } else {
        (y, mo - 3)
    };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut t = days * 86400 + h * 3600 + mi * 60 + se;
    let tz = &s[19..];
    let tz = tz.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if let Some(sign) = tz.chars().next().filter(|c| *c == '+' || *c == '-') {
        let oh: i64 = tz.get(1..3)?.parse().ok()?;
        let om: i64 = tz.get(4..6).and_then(|x| x.parse().ok()).unwrap_or(0);
        let off = oh * 3600 + om * 60;
        t -= if sign == '+' { off } else { -off };
    }
    Some(t)
}

impl PikPakDriver {
    pub fn new(opts: &HashMap<String, String>) -> Result<Self> {
        let get = |k: &str| opts.get(k).cloned().filter(|s| !s.is_empty());
        let username = get("username").unwrap_or_default();
        let password = get("password").unwrap_or_default();
        let refresh = get("refresh_token").unwrap_or_default();
        if refresh.is_empty() && (username.is_empty() || password.is_empty()) {
            return Err(StorageError::Config(
                "pikpak: need username+password or refresh_token".into(),
            ));
        }
        let p = platform(get("platform").as_deref().unwrap_or("web"))?;
        let device_id =
            get("device_id").unwrap_or_else(|| md5_hex(&format!("{username}{password}")));
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(be)?;
        let captcha = if refresh.is_empty() {
            get("captcha_token").unwrap_or_default()
        } else {
            String::new()
        };
        Ok(Self {
            http,
            p,
            username,
            password,
            device_id,
            root_id: get("root_id").unwrap_or_default(),
            user_ep: get("user_endpoint").unwrap_or_else(|| "https://user.mypikpak.net".into()),
            api_ep: get("api_endpoint").unwrap_or_else(|| "https://api-drive.mypikpak.net".into()),
            oss_ep: get("oss_endpoint"),
            skip_verification: get("skip_verification").is_some_and(|v| v == "true" || v == "1"),
            tok: Mutex::new(Tokens {
                refresh,
                captcha,
                ..Default::default()
            }),
            inited: Mutex::new(false),
            part_size: get("upload_part_size")
                .and_then(|v| v.parse().ok())
                .filter(|v| *v > 0)
                .unwrap_or(DEFAULT_PART),
            sink: std::sync::Mutex::new(None),
        })
    }

    /// Lazy init (login or refresh + post-login captcha), mirrors upstream Init().
    async fn ensure_init(&self) -> Result<()> {
        let mut g = self.inited.lock().await;
        if *g {
            return Ok(());
        }
        let refresh = self.tok.lock().await.refresh.clone();
        if refresh.is_empty() {
            self.login().await?;
        } else {
            self.refresh_token().await?;
        }
        let uid = self.tok.lock().await.user_id.clone();
        self.captcha_at_login(
            &action("GET", &format!("{}/drive/v1/files", self.api_ep)),
            &uid,
        )
        .await?;
        *g = true;
        Ok(())
    }

    async fn post_auth(&self, url: &str, body: Value) -> Result<Value> {
        let r = self
            .http
            .post(url)
            .query(&[("client_id", self.p.client_id)])
            .header("User-Agent", self.p.user_agent)
            .header("X-Device-ID", &self.device_id)
            .json(&body)
            .send()
            .await
            .map_err(be)?;
        let v: Value = r.json().await.map_err(be)?;
        Ok(v)
    }

    fn err_code(v: &Value) -> i64 {
        v.get("error_code").and_then(|x| x.as_i64()).unwrap_or(0)
    }

    fn err_msg(v: &Value) -> String {
        format!(
            "error_code={} {} {}",
            Self::err_code(v),
            v.get("error").and_then(|x| x.as_str()).unwrap_or(""),
            v.get("error_description")
                .and_then(|x| x.as_str())
                .unwrap_or("")
        )
    }

    async fn login(&self) -> Result<()> {
        if self.username.is_empty() || self.password.is_empty() {
            return Err(StorageError::Config(
                "pikpak: refresh_token invalid and no username/password".into(),
            ));
        }
        self.tok.lock().await.access.clear();
        let url = format!("{}/v1/auth/signin", self.user_ep);
        self.captcha_in_login(&action("POST", &url)).await?;
        let captcha = self.tok.lock().await.captcha.clone();
        let v = self
            .post_auth(&url, json!({"captcha_token": captcha, "client_id": self.p.client_id,
                "client_secret": self.p.client_secret, "username": self.username, "password": self.password}))
            .await?;
        self.take_tokens(&v).await
    }

    async fn take_tokens(&self, v: &Value) -> Result<()> {
        if Self::err_code(v) != 0 {
            return Err(be(Self::err_msg(v)));
        }
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        if s("access_token").is_empty() || s("refresh_token").is_empty() {
            return Err(be("server returned empty tokens"));
        }
        let mut t = self.tok.lock().await;
        t.access = s("access_token");
        let changed = t.refresh != s("refresh_token");
        t.refresh = s("refresh_token");
        t.user_id = s("sub");
        if changed {
            // Persist the rotated refresh_token so a restart does not need the password again.
            if let Some(f) = self.sink.lock().unwrap().as_ref() {
                f("refresh_token", &t.refresh);
            }
        }
        Ok(())
    }

    async fn refresh_token(&self) -> Result<()> {
        let refresh = self.tok.lock().await.refresh.clone();
        let v = self
            .post_auth(&format!("{}/v1/auth/token", self.user_ep), json!({"client_id": self.p.client_id,
                "client_secret": self.p.client_secret, "grant_type": "refresh_token", "refresh_token": refresh}))
            .await?;
        if Self::err_code(&v) == 4126 {
            return self.login().await;
        }
        self.take_tokens(&v).await
    }

    fn sign(&self) -> (String, String) {
        let ts = now_ms().to_string();
        let s = captcha_sign(
            self.p.client_id,
            self.p.client_version,
            self.p.package_name,
            &self.device_id,
            &ts,
            self.p.algorithms,
        );
        (ts, s)
    }

    async fn captcha_in_login(&self, act: &str) -> Result<()> {
        let mut meta = serde_json::Map::new();
        let u = &self.username;
        let key = if u.contains('@') && u.contains('.') {
            "email"
        } else if (11..=18).contains(&u.len()) {
            "phone_number"
        } else {
            "username"
        };
        meta.insert(key.into(), json!(u));
        self.captcha_init(act, meta).await
    }

    async fn captcha_at_login(&self, act: &str, user_id: &str) -> Result<()> {
        let mut meta = serde_json::Map::new();
        meta.insert("user_id".into(), json!(user_id));
        self.captcha_init(act, meta).await
    }

    async fn captcha_init(
        &self,
        act: &str,
        mut meta: serde_json::Map<String, Value>,
    ) -> Result<()> {
        let (ts, sign) = self.sign();
        meta.insert("client_version".into(), json!(self.p.client_version));
        meta.insert("package_name".into(), json!(self.p.package_name));
        meta.insert("timestamp".into(), json!(ts));
        meta.insert("captcha_sign".into(), json!(sign));
        let captcha = self.tok.lock().await.captcha.clone();
        let v = self
            .post_auth(&format!("{}/v1/shield/captcha/init", self.user_ep), json!({"action": act,
                "captcha_token": captcha, "client_id": self.p.client_id, "device_id": self.device_id,
                "meta": meta, "redirect_uri": "xlaccsdk01://xbase.cloud/callback?state=harbor"}))
            .await?;
        if Self::err_code(&v) != 0 {
            return Err(be(Self::err_msg(&v)));
        }
        if let Some(u) = v
            .get("url")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty() && !self.skip_verification)
        {
            return Err(be(format!(
                "need human verification: {u} (set captcha_token)"
            )));
        }
        self.tok.lock().await.captcha = v
            .get("captcha_token")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        Ok(())
    }

    /// Authenticated drive API call with token / captcha refresh + one retry (upstream request()).
    async fn api(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value> {
        self.ensure_init().await?;
        let url = format!("{}{}", self.api_ep, path);
        for attempt in 0..3 {
            let (access, captcha) = {
                let t = self.tok.lock().await;
                (t.access.clone(), t.captcha.clone())
            };
            let mut rb = self
                .http
                .request(method.clone(), &url)
                .query(query)
                .header("User-Agent", self.p.user_agent)
                .header("X-Device-ID", &self.device_id)
                .header("X-Captcha-Token", captcha)
                .bearer_auth(access);
            if let Some(b) = &body {
                rb = rb.json(b);
            }
            let r = rb.send().await.map_err(be)?;
            let status = r.status();
            let text = r.text().await.map_err(be)?;
            let v: Value = if text.is_empty() {
                json!({})
            } else {
                serde_json::from_str(&text).unwrap_or(json!({"raw": text}))
            };
            match Self::err_code(&v) {
                0 if status.is_success() || status.as_u16() == 0 => return Ok(v),
                0 => return Err(be(format!("HTTP {status}: {text}"))),
                4122 | 4121 | 16 if attempt < 2 => self.refresh_token().await?,
                9 if attempt < 2 => {
                    let uid = self.tok.lock().await.user_id.clone();
                    self.captcha_at_login(&action(method.as_str(), &url), &uid)
                        .await?
                }
                _ => {
                    let msg = Self::err_msg(&v);
                    if msg.contains("not_found") || status.as_u16() == 404 {
                        return Err(StorageError::NotFound(msg));
                    }
                    return Err(be(msg));
                }
            }
        }
        Err(be("retries exhausted"))
    }

    async fn list_id(&self, id: &str) -> Result<Vec<RFile>> {
        let mut out = Vec::new();
        let mut page = String::new();
        loop {
            let v = self
                .api(
                    reqwest::Method::GET,
                    "/drive/v1/files",
                    &[
                        ("parent_id", id),
                        ("thumbnail_size", "SIZE_LARGE"),
                        ("with_audit", "true"),
                        ("limit", "100"),
                        (
                            "filters",
                            r#"{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}"#,
                        ),
                        ("page_token", &page),
                    ],
                    None,
                )
                .await?;
            if let Some(a) = v.get("files").and_then(|x| x.as_array()) {
                out.extend(a.iter().map(rfile));
            }
            page = v
                .get("next_page_token")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if page.is_empty() {
                return Ok(out);
            }
        }
    }

    /// Resolves a mount-relative path to its remote object (root → synthetic dir).
    async fn resolve(&self, path: &str) -> Result<RFile> {
        let p = norm(path)?;
        let mut cur = RFile {
            id: self.root_id.clone(),
            name: String::new(),
            is_dir: true,
            size: 0,
            modified: None,
        };
        if p.is_empty() {
            return Ok(cur);
        }
        for part in p.split('/') {
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
            return Err(StorageError::Config("pikpak: root has no parent".into()));
        }
        Ok(match p.rsplit_once('/') {
            Some((a, b)) => (a.to_string(), b.to_string()),
            None => (String::new(), p),
        })
    }

    async fn mkdir_id(&self, path: &str) -> Result<String> {
        let p = norm(path)?;
        let mut id = self.root_id.clone();
        for part in p.split('/').filter(|s| !s.is_empty()) {
            let kids = self.list_id(&id).await?;
            id = match kids.into_iter().find(|f| f.name == part) {
                Some(f) if f.is_dir => f.id,
                Some(_) => return Err(StorageError::AlreadyExists(format!("{part} is a file"))),
                None => {
                    let v = self
                        .api(
                            reqwest::Method::POST,
                            "/drive/v1/files",
                            &[],
                            Some(json!({"kind": "drive#folder", "parent_id": id, "name": part})),
                        )
                        .await?;
                    v.pointer("/file/id")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string()
                }
            };
        }
        Ok(id)
    }

    async fn download_url(&self, id: &str) -> Result<String> {
        let v = self
            .api(
                reqwest::Method::GET,
                &format!("/drive/v1/files/{id}"),
                &[
                    ("_magic", "2021"),
                    ("usage", "FETCH"),
                    ("thumbnail_size", "SIZE_LARGE"),
                ],
                None,
            )
            .await?;
        v.get("web_content_link")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .ok_or_else(|| be("no web_content_link"))
    }

    /// Signed Aliyun OSS request with STS credentials (V1 signature, like the upstream SDK).
    /// `sub` is the sub-resource query (e.g. `uploads`, `partNumber=1&uploadId=x`).
    async fn oss(
        &self,
        method: reqwest::Method,
        params: &Value,
        sub: &str,
        ctype: &str,
        data: Bytes,
    ) -> Result<reqwest::Response> {
        let s = |k: &str| {
            params
                .get(k)
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string()
        };
        let (bucket, key, ak, sk, token) = (
            s("bucket"),
            s("key"),
            s("access_key_id"),
            s("access_key_secret"),
            s("security_token"),
        );
        let q = if sub.is_empty() {
            String::new()
        } else {
            format!("?{sub}")
        };
        let url = match &self.oss_ep {
            Some(ep) => format!("{}/{bucket}/{key}{q}", ep.trim_end_matches('/')),
            None => format!("https://{bucket}.{}/{key}{q}", s("endpoint")),
        };
        let date = httpdate::fmt_http_date(SystemTime::now());
        let to_sign = format!(
            "{method}\n\n{ctype}\n{date}\nx-oss-security-token:{token}\n/{bucket}/{key}{q}"
        );
        let mut mac = Hmac::<Sha1>::new_from_slice(sk.as_bytes()).map_err(be)?;
        mac.update(to_sign.as_bytes());
        use base64::Engine;
        let sig = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        let r = self
            .http
            .request(method, url)
            .header("Date", date)
            .header("Content-Type", ctype)
            .header("X-OSS-Security-Token", token)
            .header("Authorization", format!("OSS {ak}:{sig}"))
            .header(
                "User-Agent",
                "aliyun-sdk-android/2.9.13(Linux/Android 14/M2004j7ac;UKQ1.231108.001)",
            )
            .body(data)
            .send()
            .await
            .map_err(be)?;
        if !r.status().is_success() {
            let st = r.status();
            return Err(be(format!(
                "oss {sub} HTTP {st}: {}",
                r.text().await.unwrap_or_default()
            )));
        }
        Ok(r)
    }

    /// Single PUT for small files, OSS multipart (Initiate / UploadPart / Complete) above
    /// one part; no 5 GB single-PUT ceiling. Parts are read lazily from `src`.
    async fn oss_upload(
        &self,
        params: &Value,
        src: &Src,
        on_progress: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<()> {
        const OCT: &str = "application/octet-stream";
        let n = src.len();
        if n <= self.part_size {
            let data = src.slice(0, n).await?;
            self.oss(reqwest::Method::PUT, params, "", OCT, data)
                .await?;
            on_progress(n);
            return Ok(());
        }
        // OSS allows at most 10000 parts.
        let part = self.part_size.max(n.div_ceil(10_000));
        let r = self
            .oss(reqwest::Method::POST, params, "uploads", OCT, Bytes::new())
            .await?;
        let body = r.text().await.map_err(be)?;
        let upload_id = xml_tag(&body, "UploadId").ok_or_else(|| be("oss: no UploadId"))?;
        let mut xml = String::from("<CompleteMultipartUpload>");
        let (mut off, mut no) = (0u64, 1u32);
        while off < n {
            let len = part.min(n - off);
            let data = src.slice(off, len).await?;
            let mut tries = 0;
            let r = loop {
                match self
                    .oss(
                        reqwest::Method::PUT,
                        params,
                        &format!("partNumber={no}&uploadId={upload_id}"),
                        OCT,
                        data.clone(),
                    )
                    .await
                {
                    Ok(r) => break r,
                    Err(e) if tries >= 2 => return Err(e),
                    Err(_) => tries += 1,
                }
            };
            let etag = r
                .headers()
                .get("etag")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            xml.push_str(&format!(
                "<Part><PartNumber>{no}</PartNumber><ETag>{etag}</ETag></Part>"
            ));
            off += len;
            no += 1;
            on_progress(off);
        }
        xml.push_str("</CompleteMultipartUpload>");
        self.oss(
            reqwest::Method::POST,
            params,
            &format!("uploadId={upload_id}"),
            "application/xml",
            Bytes::from(xml),
        )
        .await?;
        Ok(())
    }

    async fn upload(
        &self,
        path: &str,
        src: Src,
        on_progress: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<()> {
        let (parent, name) = Self::split(path)?;
        let pid = self.mkdir_id(&parent).await?;
        // Overwrite semantics: trash an existing file of the same name first.
        if let Some(old) = self
            .list_id(&pid)
            .await?
            .into_iter()
            .find(|f| f.name == name)
        {
            if old.is_dir {
                return Err(StorageError::AlreadyExists(path.into()));
            }
            self.trash(&old.id).await?;
        }
        let hash = gcid_src(&src).await?;
        let v = self
            .api(
                reqwest::Method::POST,
                "/drive/v1/files",
                &[],
                Some(json!({
                    "kind": "drive#file", "name": name, "size": src.len().to_string(), "hash": hash,
                    "upload_type": "UPLOAD_TYPE_RESUMABLE",
                    "objProvider": {"provider": "UPLOAD_TYPE_UNKNOWN"},
                    "parent_id": pid, "folder_type": "NORMAL"})),
            )
            .await?;
        match v.pointer("/resumable/params") {
            // No resumable section = instant (hash-matched) upload.
            None | Some(Value::Null) => {
                on_progress(src.len());
                Ok(())
            }
            Some(params) => self.oss_upload(params, &src, on_progress).await,
        }
    }

    async fn trash(&self, id: &str) -> Result<()> {
        self.api(
            reqwest::Method::POST,
            "/drive/v1/files:batchTrash",
            &[],
            Some(json!({"ids": [id]})),
        )
        .await?;
        Ok(())
    }
}

#[async_trait]
impl StorageDriver for PikPakDriver {
    fn kind(&self) -> &'static str {
        "pikpak"
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
            name: p.rsplit('/').next().unwrap_or("").to_string(),
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
        let url = self.download_url(&f.id).await?;
        let mut rb = self.http.get(url);
        if let Some(r) = range {
            let h = match r.end {
                Some(e) if e > r.start => format!("bytes={}-{}", r.start, e - 1),
                _ => format!("bytes={}-", r.start),
            };
            rb = rb.header("Range", h);
        }
        let resp = rb.send().await.map_err(be)?;
        if !resp.status().is_success() {
            return Err(be(format!("download HTTP {}", resp.status())));
        }
        let partial = resp.status().as_u16() == 206;
        let s = resp.bytes_stream().map_err(std::io::Error::other);
        if let (Some(r), false) = (range, partial) {
            // Server ignored Range: slice locally.
            let all: Vec<Bytes> = s.try_collect().await.map_err(be)?;
            let buf: Vec<u8> = all.concat();
            let st = (r.start as usize).min(buf.len());
            let en = r
                .end
                .map(|e| e as usize)
                .unwrap_or(buf.len())
                .min(buf.len());
            return Ok(futures::stream::iter(vec![Ok(Bytes::copy_from_slice(
                &buf[st..en.max(st)],
            ))])
            .boxed());
        }
        Ok(s.boxed())
    }

    async fn write(&self, path: &str, data: Bytes) -> Result<()> {
        self.upload(path, Src::Mem(data), &|_| {}).await
    }

    async fn write_stream(
        &self,
        path: &str,
        mut data: ByteStream,
        on_progress: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<u64> {
        // GCID needs the whole content before the upload task is created, so spool to a
        // temp file (not memory); parts are then read back one at a time.
        let src = Src::spool(&mut data, "pikpak").await?;
        let n = src.len();
        self.upload(path, src, on_progress).await?;
        Ok(n)
    }

    fn set_option_sink(&self, sink: crate::OptionSink) {
        *self.sink.lock().unwrap() = Some(sink);
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
            self.api(
                reqwest::Method::POST,
                "/drive/v1/files:batchMove",
                &[],
                Some(json!({"ids": [f.id], "to": {"parent_id": pid}})),
            )
            .await?;
        }
        if f.name != tname {
            self.api(
                reqwest::Method::PATCH,
                &format!("/drive/v1/files/{}", f.id),
                &[],
                Some(json!({"name": tname})),
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
        self.api(
            reqwest::Method::POST,
            "/drive/v1/files:batchCopy",
            &[],
            Some(json!({"ids": [f.id], "to": {"parent_id": pid}})),
        )
        .await?;
        if fname != tname {
            let new = self
                .list_id(&pid)
                .await?
                .into_iter()
                .find(|x| !before.contains(&x.id) && x.id != f.id)
                .ok_or_else(|| be("copied object not found"))?;
            self.api(
                reqwest::Method::PATCH,
                &format!("/drive/v1/files/{}", new.id),
                &[],
                Some(json!({"name": tname})),
            )
            .await?;
        }
        Ok(())
    }

    async fn delete(&self, path: &str) -> Result<()> {
        match self.resolve(path).await {
            Ok(f) if !f.id.is_empty() && f.id != self.root_id => self.trash(&f.id).await,
            Ok(_) => Err(StorageError::Config(
                "pikpak: refusing to delete root".into(),
            )),
            Err(StorageError::NotFound(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    async fn link(&self, path: &str, _expire: Duration) -> Result<Option<String>> {
        let f = self.resolve(path).await?;
        if f.is_dir {
            return Ok(None);
        }
        Ok(Some(self.download_url(&f.id).await?))
    }
}
