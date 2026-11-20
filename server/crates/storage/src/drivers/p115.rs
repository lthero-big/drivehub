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
//! Upload: rapid upload (sha1 + 128 KiB pre-hash, sign_check retry) via ec115-encrypted
//! `initupload.php`, else STS OSS PUT / multipart with the 115 callback (options uplb_endpoint,
//! oss_endpoint, ec_remote_pubkey, upload_part_size for tests). Not yet ported: QR-code login.
use super::Src;
use crate::{norm, ByteRange, ByteStream, Entry, Result, StorageDriver, StorageError};
use async_trait::async_trait;
use bytes::Bytes;
use futures::{StreamExt, TryStreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

pub const UA_115_BROWSER: &str = "Mozilla/5.0 115Browser/27.0.5.7";

/// Default UA for API + CDN. 115 CDN returns 403 "no cookie value" when the
/// download request uses the 115Browser UA (OpenList #2349 / #2502); a regular
/// browser UA must be used both to mint the downurl and to fetch it.
pub const UA_DEFAULT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

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

/// ec115 envelope for `uplb.115.com/4.0/initupload.php` (port of 115driver/pkg/crypto/ec115):
/// P-224 ECDH with 115's static key, AES-128-CBC request body, LZ4-block reply, `k_ec` token.
pub mod ec115 {
    use aes::cipher::{
        block_padding::NoPadding, block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit,
    };
    use p224::elliptic_curve::sec1::ToEncodedPoint;

    type Enc = cbc::Encryptor<aes::Aes128>;
    type Dec = cbc::Decryptor<aes::Aes128>;

    /// 115's static P-224 public key (uncompressed X || Y).
    pub const REMOTE_PUB: [u8; 56] = [
        0x57, 0xA2, 0x92, 0x57, 0xCD, 0x23, 0x20, 0xE5, 0xD6, 0xD1, 0x43, 0x32, 0x2F, 0xA4, 0xBB,
        0x8A, 0x3C, 0xF9, 0xD3, 0xCC, 0x62, 0x3E, 0xF5, 0xED, 0xAC, 0x62, 0xB7, 0x67, 0x8A, 0x89,
        0xC9, 0x1A, 0x83, 0xBA, 0x80, 0x0D, 0x61, 0x29, 0xF5, 0x22, 0xD0, 0x34, 0xC8, 0x95, 0xDD,
        0x24, 0x65, 0x24, 0x3A, 0xDD, 0xC2, 0x50, 0x95, 0x3B, 0xEE, 0xBA,
    ];
    const CRC_SALT: &[u8] = b"^j>WD3Kr?J2gLFjD4W2y@";

    pub struct Cipher {
        key: [u8; 16],
        iv: [u8; 16],
        /// `[29, 02|03, X(28)]` — length-prefixed compressed local public key.
        pub pubkey: Vec<u8>,
    }

    impl Cipher {
        /// Fresh ephemeral key agreed with `remote` (uncompressed X||Y, 56 bytes).
        pub fn new(remote: &[u8]) -> Result<Self, String> {
            let mut sec1 = vec![4u8];
            sec1.extend_from_slice(remote);
            let rp = p224::PublicKey::from_sec1_bytes(&sec1).map_err(|e| e.to_string())?;
            let sk = p224::ecdh::EphemeralSecret::random(&mut rand_core::OsRng);
            let mut pubkey = vec![29u8];
            pubkey.extend_from_slice(sk.public_key().to_encoded_point(true).as_bytes());
            let shared = sk.diffie_hellman(&rp);
            Ok(Self::from_secret(shared.raw_secret_bytes(), pubkey))
        }

        /// key = secret[..16], iv = secret[len-16..] (28-byte X coordinate).
        pub fn from_secret(secret: &[u8], pubkey: Vec<u8>) -> Self {
            let mut key = [0u8; 16];
            let mut iv = [0u8; 16];
            key.copy_from_slice(&secret[..16]);
            iv.copy_from_slice(&secret[secret.len() - 16..]);
            Self { key, iv, pubkey }
        }

        /// Server side (mocks): agree with a client pubkey taken from a `k_ec` token.
        pub fn server(secret_key: &[u8], client_pub: &[u8]) -> Result<Self, String> {
            let sk = p224::SecretKey::from_slice(secret_key).map_err(|e| e.to_string())?;
            let pk =
                p224::PublicKey::from_sec1_bytes(&client_pub[1..]).map_err(|e| e.to_string())?;
            let shared = p224::ecdh::diffie_hellman(sk.to_nonzero_scalar(), pk.as_affine());
            Ok(Self::from_secret(
                shared.raw_secret_bytes(),
                client_pub.to_vec(),
            ))
        }

        /// PKCS#7 + AES-CBC (upstream hand-rolls the same chaining over ECB).
        pub fn encrypt(&self, plain: &[u8]) -> Vec<u8> {
            Enc::new(&self.key.into(), &self.iv.into()).encrypt_padded_vec_mut::<Pkcs7>(plain)
        }

        /// Inverse of [`Cipher::encrypt`] (mocks).
        pub fn decrypt_request(&self, ct: &[u8]) -> Option<Vec<u8>> {
            Dec::new(&self.key.into(), &self.iv.into())
                .decrypt_padded_vec_mut::<Pkcs7>(ct)
                .ok()
        }

        /// Reply: AES-CBC (no padding) over `[len lo, len hi, lz4 block...]`.
        pub fn decrypt(&self, ct: &[u8]) -> Option<Vec<u8>> {
            let ct = &ct[..ct.len() - ct.len() % 16];
            let b = Dec::new(&self.key.into(), &self.iv.into())
                .decrypt_padded_vec_mut::<NoPadding>(ct)
                .ok()?;
            let len = *b.first()? as usize | (*b.get(1)? as usize) << 8;
            lz4_flex::block::decompress(b.get(2..2 + len)?, 0x2000).ok()
        }

        /// Inverse of [`Cipher::decrypt`] (mocks).
        pub fn encrypt_reply(&self, plain: &[u8]) -> Vec<u8> {
            let z = lz4_flex::block::compress(plain);
            let mut b = vec![(z.len() & 0xff) as u8, (z.len() >> 8) as u8];
            b.extend_from_slice(&z);
            b.resize(b.len().div_ceil(16) * 16, 0);
            Enc::new(&self.key.into(), &self.iv.into()).encrypt_padded_vec_mut::<NoPadding>(&b)
        }

        /// `k_ec` query token: obfuscated pubkey + timestamp + CRC32 (salted).
        pub fn encode_token(&self, ts: i64, r1: u8, r2: u8) -> String {
            let t = (ts as u32).to_be_bytes();
            let mut tmp = Vec::with_capacity(48);
            tmp.extend(self.pubkey[..15].iter().map(|b| b ^ r1));
            tmp.extend_from_slice(&[r1, 0x73 ^ r1, r1, r1, r1]);
            tmp.extend((0..4).map(|i| r1 ^ t[3 - i]));
            tmp.extend(self.pubkey[15..].iter().map(|b| b ^ r2));
            tmp.extend_from_slice(&[r2, 0x01 ^ r2, r2, r2, r2]);
            let mut h = crc32fast::Hasher::new();
            h.update(CRC_SALT);
            h.update(&tmp);
            tmp.extend(h.finalize().to_le_bytes());
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(tmp)
        }

        /// Inverse of [`Cipher::encode_token`] (mocks): `(client pubkey, timestamp)`.
        pub fn decode_token(tok: &str) -> Option<(Vec<u8>, u32)> {
            use base64::Engine;
            let b = base64::engine::general_purpose::STANDARD.decode(tok).ok()?;
            if b.len() != 48 {
                return None;
            }
            let (r1, r2) = (b[15], b[39]);
            let mut pk: Vec<u8> = b[..15].iter().map(|x| x ^ r1).collect();
            pk.extend(b[24..39].iter().map(|x| x ^ r2));
            let t = [b[23] ^ r1, b[22] ^ r1, b[21] ^ r1, b[20] ^ r1];
            Some((pk, u32::from_be_bytes(t)))
        }
    }
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

/// Look up a string field under any of `keys` (exact, then case-insensitive).
/// 115's gettoken.php returns Aliyun STS casing `AccessKeyId`; older samples used `AccessKeyID`.
fn sval_keys(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        let s = sval(v, k);
        if !s.is_empty() {
            return s;
        }
    }
    if let Some(obj) = v.as_object() {
        for k in keys {
            if let Some(val) = obj
                .iter()
                .find(|(ok, _)| ok.eq_ignore_ascii_case(k))
                .map(|(_, val)| val)
            {
                return match val {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => String::new(),
                };
            }
        }
    }
    String::new()
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
    uplb: String,
    oss_ep: Option<String>,
    ec_remote: Vec<u8>,
    part_size: u64,
    /// (user_id, userkey) from `app/uploadinfo`.
    upinfo: Mutex<Option<(String, String)>>,
}

const MD5_SALT: &str = "Qclm8MGWUv59TnrR0XPg";
const APP_VER: &str = "27.0.5.7";
const OSS_UA: &str = "aliyun-sdk-android/2.9.1";
const OSS_ENDPOINT: &str = "cn-shenzhen.oss.aliyuncs.com";

fn sha1_upper(b: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    hexu(&Sha1::digest(b))
}

fn hexu(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect()
}

/// Go `url.Values.Encode`: keys sorted, QueryEscape (space -> '+').
fn form_encode(kv: &std::collections::BTreeMap<&str, String>) -> String {
    let esc = |s: &str| {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                b' ' => "+".into(),
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    kv.iter()
        .map(|(k, v)| format!("{}={}", esc(k), esc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// initupload `sig` (115driver GenerateSignature).
pub fn upload_sig(user_id: &str, userkey: &str, file_id: &str, target: &str) -> String {
    let inner = sha1_upper(format!("{user_id}{file_id}{target}0").as_bytes()).to_lowercase();
    sha1_upper(format!("{userkey}{inner}000000").as_bytes())
}

/// initupload `token` (115driver GenerateToken).
pub fn upload_token(
    user_id: &str,
    file_id: &str,
    t: &str,
    size: &str,
    sign_key: &str,
    sign_val: &str,
) -> String {
    use md5::{Digest, Md5};
    let uid_md5 = format!("{:x}", Md5::digest(user_id.as_bytes()));
    format!(
        "{:x}",
        Md5::digest(
            format!("{MD5_SALT}{file_id}{size}{sign_key}{sign_val}{user_id}{t}{uid_md5}{APP_VER}")
                .as_bytes()
        )
    )
}


/// Build the 115 Cookie header from a full `cookie` option, or from split
/// `uid` / `cid` / `seid` / `kid` fields (any case). A non-empty `cookie`
/// wins if both are present.
pub fn cookie_from_options(opts: &HashMap<String, String>) -> Result<String> {
    let get = |k: &str| {
        opts.iter()
            .find(|(ok, v)| ok.eq_ignore_ascii_case(k) && !v.is_empty())
            .map(|(_, v)| v.clone())
    };
    if let Some(c) = get("cookie") {
        return Ok(c);
    }
    let mut parts = Vec::new();
    for k in ["UID", "CID", "SEID", "KID"] {
        match get(k) {
            Some(v) => parts.push(format!("{}={}", k, v)),
            None => {
                return Err(StorageError::Config(
                    "115: missing 'cookie' or UID/CID/SEID/KID; QR login not ported yet".into(),
                ));
            }
        }
    }
    Ok(parts.join("; "))
}

impl P115Driver {
    pub fn new(opts: &HashMap<String, String>) -> Result<Self> {
        let get = |k: &str| opts.get(k).cloned().filter(|s| !s.is_empty());
        let cookie = cookie_from_options(opts)?;
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
            uplb: get("uplb_endpoint").unwrap_or_else(|| "https://uplb.115.com".into()),
            oss_ep: get("oss_endpoint"),
            ec_remote: get("ec_remote_pubkey")
                .and_then(|h| {
                    (0..h.len())
                        .step_by(2)
                        .map(|i| u8::from_str_radix(h.get(i..i + 2)?, 16).ok())
                        .collect()
                })
                .unwrap_or_else(|| ec115::REMOTE_PUB.to_vec()),
            part_size: get("upload_part_size")
                .and_then(|v| v.parse().ok())
                .filter(|v| *v > 0)
                .unwrap_or(16 << 20),
            upinfo: Mutex::new(None),
        })
    }

    fn req(&self, m: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        self.http
            .request(m, url)
            .header("Cookie", &self.cookie)
            .header("User-Agent", &self.ua)
    }

    /// downurl + CDN must share a regular browser UA. The 115Browser API UA
    /// triggers CDN 403 no-cookie-value (OpenList issues 2349 and 2502).
    fn download_req(&self, m: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        self.http
            .request(m, url)
            .header("Cookie", &self.cookie)
            .header("User-Agent", UA_DEFAULT)
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

    async fn upload_info(&self) -> Result<(String, String)> {
        let mut g = self.upinfo.lock().await;
        if let Some(i) = g.as_ref() {
            return Ok(i.clone());
        }
        self.login_check().await?;
        let v: Value = self
            .req(
                reqwest::Method::POST,
                &format!("{}/app/uploadinfo", self.proapi),
            )
            .send()
            .await
            .map_err(be)?
            .json()
            .await
            .map_err(be)?;
        let (uid, key) = (sval(&v, "user_id"), sval(&v, "userkey"));
        if uid.is_empty() || uid == "0" || key.is_empty() {
            return Err(be(format!("uploadinfo: {v}")));
        }
        *g = Some((uid.clone(), key.clone()));
        Ok((uid, key))
    }

    /// `initupload.php` with sign_key/sign_val retry (status 7). Returns the decrypted reply.
    async fn init_upload(
        &self,
        dir_id: &str,
        name: &str,
        src: &Src,
        file_id: &str,
    ) -> Result<Value> {
        let (uid, ukey) = self.upload_info().await?;
        let target = format!("U_1_{dir_id}");
        let size = src.len().to_string();
        let mut form = std::collections::BTreeMap::new();
        form.insert("appid", "0".to_string());
        form.insert("appversion", APP_VER.to_string());
        form.insert("userid", uid.clone());
        form.insert("filename", name.to_string());
        form.insert("filesize", size.clone());
        form.insert("fileid", file_id.to_string());
        form.insert("target", target.clone());
        form.insert("sig", upload_sig(&uid, &ukey, file_id, &target));
        form.insert("topupload", "true".to_string());
        let ec = ec115::Cipher::new(&self.ec_remote).map_err(be)?;
        let (mut sign_key, mut sign_val) = (String::new(), String::new());
        for _ in 0..4 {
            let t = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            let rnd: [u8; 2] = {
                use rand_core::RngCore;
                let mut b = [0u8; 2];
                rand_core::OsRng.fill_bytes(&mut b);
                b
            };
            form.insert("t", t.to_string());
            form.insert(
                "token",
                upload_token(&uid, file_id, &t.to_string(), &size, &sign_key, &sign_val),
            );
            if !sign_key.is_empty() && !sign_val.is_empty() {
                form.insert("sign_key", sign_key.clone());
                form.insert("sign_val", sign_val.clone());
            }
            let body = ec.encrypt(form_encode(&form).as_bytes());
            let raw = self
                .req(
                    reqwest::Method::POST,
                    &format!("{}/4.0/initupload.php", self.uplb),
                )
                .query(&[("k_ec", ec.encode_token(t, rnd[0], rnd[1]))])
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(body)
                .send()
                .await
                .map_err(be)?
                .bytes()
                .await
                .map_err(be)?;
            let plain = ec
                .decrypt(&raw)
                .ok_or_else(|| be("initupload: bad ec115 reply"))?;
            let v: Value = serde_json::from_slice(&plain).map_err(be)?;
            let code = v.get("statuscode").and_then(|x| x.as_i64()).unwrap_or(0);
            if code != 0 && code != 701 {
                return Err(be(format!("initupload: {code} {}", sval(&v, "statusmsg"))));
            }
            if v.get("status").and_then(|x| x.as_i64()) != Some(7) {
                return Ok(v);
            }
            // Server asks for the SHA1 of an inclusive byte range "start-end".
            sign_key = sval(&v, "sign_key");
            let chk = sval(&v, "sign_check");
            let (a, b) = chk
                .split_once('-')
                .and_then(|(a, b)| Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok()?)))
                .filter(|(a, b)| a <= b && *b < src.len())
                .ok_or_else(|| be(format!("initupload: bad sign_check {chk}")))?;
            sign_val = sha1_upper(&src.slice(a, b - a + 1).await?);
        }
        Err(be("initupload: sign check loop"))
    }

    /// Signed OSS request (V1, STS) carrying the 115 callback headers.
    #[allow(clippy::too_many_arguments)]
    async fn oss(
        &self,
        method: reqwest::Method,
        tok: &Value,
        bucket: &str,
        object: &str,
        sub: &str,
        ctype: &str,
        extra: &[(&str, String)],
        data: Bytes,
    ) -> Result<reqwest::Response> {
        use base64::Engine;
        use hmac::{Hmac, Mac};
        let (ak, sk, sts) = (
            sval_keys(tok, &["AccessKeyId", "AccessKeyID"]),
            sval_keys(tok, &["AccessKeySecret"]),
            sval_keys(tok, &["SecurityToken"]),
        );
        if ak.is_empty() || sk.is_empty() {
            let names = tok
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>().join(","))
                .unwrap_or_default();
            return Err(be(format!(
                "oss: missing AccessKeyId/Secret in gettoken (fields: {names})"
            )));
        }
        let q = if sub.is_empty() {
            String::new()
        } else {
            format!("?{sub}")
        };
        let url = match &self.oss_ep {
            Some(ep) => format!("{}/{bucket}/{object}{q}", ep.trim_end_matches('/')),
            None => format!("https://{bucket}.{OSS_ENDPOINT}/{object}{q}"),
        };
        let date = httpdate::fmt_http_date(SystemTime::now());
        let mut hs: Vec<(String, String)> = extra
            .iter()
            .map(|(k, v)| (k.to_lowercase(), v.clone()))
            .collect();
        hs.push(("x-oss-security-token".into(), sts));
        hs.sort();
        let canon: String = hs.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
        let to_sign = format!("{method}\n\n{ctype}\n{date}\n{canon}/{bucket}/{object}{q}");
        let mut mac = Hmac::<sha1::Sha1>::new_from_slice(sk.as_bytes()).map_err(be)?;
        mac.update(to_sign.as_bytes());
        let sig = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        let mut rb = self
            .http
            .request(method, url)
            .header("Date", date)
            .header("Content-Type", ctype)
            .header("Authorization", format!("OSS {ak}:{sig}"))
            .header("User-Agent", OSS_UA);
        for (k, v) in &hs {
            rb = rb.header(k.as_str(), v.as_str());
        }
        let r = rb.body(data).send().await.map_err(be)?;
        if !r.status().is_success() {
            let st = r.status();
            return Err(be(format!(
                "oss {sub} HTTP {st}: {}",
                r.text().await.unwrap_or_default()
            )));
        }
        Ok(r)
    }

    /// OSS upload with 115's callback: single PUT up to `part_size`, multipart above
    /// (callback is attached to CompleteMultipartUpload, like the SDK's multipart path).
    async fn oss_upload(&self, init: &Value, src: &Src) -> Result<()> {
        let tok: Value = self
            .req(
                reqwest::Method::GET,
                &format!("{}/3.0/gettoken.php", self.uplb),
            )
            .send()
            .await
            .map_err(be)?
            .json()
            .await
            .map_err(be)?;
        if sval(&tok, "StatusCode") != "200" {
            return Err(be(format!("gettoken: {tok}")));
        }
        use base64::Engine;
        let b64 = |s: String| base64::engine::general_purpose::STANDARD.encode(s);
        let (bucket, object) = (sval(init, "bucket"), sval(init, "object"));
        let cb = init.get("callback").cloned().unwrap_or_default();
        let cbh = [
            ("x-oss-callback", b64(sval(&cb, "callback"))),
            ("x-oss-callback-var", b64(sval(&cb, "callback_var"))),
        ];
        const OCT: &str = "application/octet-stream";
        let n = src.len();
        if n <= self.part_size {
            let data = src.slice(0, n).await?;
            self.oss(
                reqwest::Method::PUT,
                &tok,
                &bucket,
                &object,
                "",
                OCT,
                &cbh,
                data,
            )
            .await?;
            return Ok(());
        }
        let part = self.part_size.max(n.div_ceil(10_000));
        let r = self
            .oss(
                reqwest::Method::POST,
                &tok,
                &bucket,
                &object,
                "uploads",
                OCT,
                &[],
                Bytes::new(),
            )
            .await?;
        let body = r.text().await.map_err(be)?;
        let uid = body
            .split_once("<UploadId>")
            .and_then(|(_, r)| r.split_once("</UploadId>"))
            .map(|(u, _)| u.to_string())
            .ok_or_else(|| be("oss: no UploadId"))?;
        let mut xml = String::from("<CompleteMultipartUpload>");
        let (mut off, mut no) = (0u64, 1u32);
        while off < n {
            let len = part.min(n - off);
            let data = src.slice(off, len).await?;
            let sub = format!("partNumber={no}&uploadId={uid}");
            let mut tries = 0;
            let r = loop {
                match self
                    .oss(
                        reqwest::Method::PUT,
                        &tok,
                        &bucket,
                        &object,
                        &sub,
                        OCT,
                        &[],
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
        }
        xml.push_str("</CompleteMultipartUpload>");
        self.oss(
            reqwest::Method::POST,
            &tok,
            &bucket,
            &object,
            &format!("uploadId={uid}"),
            "application/xml",
            &cbh,
            Bytes::from(xml),
        )
        .await?;
        Ok(())
    }

    /// Rapid upload (秒传, sha1 + 128 KiB pre-hash) or OSS upload, then verify by listing.
    async fn upload(&self, path: &str, src: Src) -> Result<()> {
        let (parent, name) = Self::split(path)?;
        let dir_id = self.mkdir_id(&parent).await?;
        if let Some(old) = self
            .list_id(&dir_id)
            .await?
            .into_iter()
            .find(|f| f.name == name)
        {
            if old.is_dir {
                return Err(StorageError::AlreadyExists(path.into()));
            }
            self.delete(path).await?;
        }
        let n = src.len();
        // 115driver also computes a 128 KiB pre-hash (PreID), but initupload 4.0 neither sends
        // it nor folds it into the token, so only the full sha1 (fileid) is needed.
        let file_id = {
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            let mut off = 0;
            while off < n {
                let len = (4u64 << 20).min(n - off);
                h.update(&src.slice(off, len).await?);
                off += len;
            }
            hexu(&h.finalize())
        };
        let init = self.init_upload(&dir_id, &name, &src, &file_id).await?;
        match init.get("status").and_then(|x| x.as_i64()) {
            Some(2) => {}
            Some(1) => self.oss_upload(&init, &src).await?,
            other => return Err(be(format!("initupload: unexpected status {other:?}"))),
        }
        if self
            .list_id(&dir_id)
            .await?
            .iter()
            .any(|f| f.name == name && !f.is_dir)
        {
            Ok(())
        } else {
            Err(be(format!("upload of {path} not visible after completion")))
        }
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
            .download_req(
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
        let mut rb = self.download_req(reqwest::Method::GET, &url);
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
            let st = resp.status();
            let host = resp.url().host_str().unwrap_or("").to_string();
            let body = resp.text().await.unwrap_or_default();
            let snippet: String = body.chars().take(200).collect();
            return Err(be(format!("download HTTP {st} host={host}: {snippet}")));
        }
        Ok(resp.bytes_stream().map_err(std::io::Error::other).boxed())
    }

    async fn write(&self, path: &str, data: Bytes) -> Result<()> {
        self.upload(path, Src::Mem(data)).await
    }

    async fn write_stream(
        &self,
        path: &str,
        mut data: ByteStream,
        on_progress: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<u64> {
        // sha1 must be known before initupload, so spool to disk rather than RAM.
        let src = Src::spool(&mut data, "115").await?;
        let n = src.len();
        self.upload(path, src).await?;
        on_progress(n);
        Ok(n)
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
        self.mkdir_id(&tp).await?;
        // Same-directory copy would create a second file named `fname` in `tp`.
        // 115 silently no-ops that, so always copy into a fresh staging folder first.
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let stage = if tp.is_empty() {
            format!("dh-copy-{stamp}")
        } else {
            format!("{tp}/dh-copy-{stamp}")
        };
        let stage_id = self.mkdir_id(&stage).await?;
        self.form(
            "/files/copy",
            &[
                ("pid".into(), stage_id.clone()),
                ("fid[0]".into(), f.id.clone()),
            ],
        )
        .await?;
        let mut copied = None;
        for i in 0..20 {
            if i > 0 {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            copied = self
                .list_id(&stage_id)
                .await?
                .into_iter()
                .find(|x| x.id != f.id && x.name == fname);
            if copied.is_some() {
                break;
            }
        }
        copied.ok_or_else(|| be("copied object not found"))?;
        let staged = format!("{stage}/{fname}");
        let dest = if tp.is_empty() {
            tname.clone()
        } else {
            format!("{tp}/{tname}")
        };
        // move + rename into place, then drop the empty staging dir.
        if staged != dest {
            self.rename(&staged, &dest).await?;
        }
        let _ = self.delete(&stage).await;
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

#[cfg(test)]
mod cookie_from_options_tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn passthrough_cookie() {
        let m = HashMap::from([("cookie".into(), "UID=u; CID=c; SEID=s; KID=k".into())]);
        assert_eq!(cookie_from_options(&m).unwrap(), "UID=u; CID=c; SEID=s; KID=k");
    }

    #[test]
    fn compose_split_fields() {
        let m = HashMap::from([
            ("uid".into(), "u1".into()),
            ("CID".into(), "c1".into()),
            ("seid".into(), "s1".into()),
            ("kid".into(), "k1".into()),
        ]);
        assert_eq!(
            cookie_from_options(&m).unwrap(),
            "UID=u1; CID=c1; SEID=s1; KID=k1"
        );
    }

    #[test]
    fn cookie_wins_over_split() {
        let m = HashMap::from([
            ("cookie".into(), "UID=keep".into()),
            ("uid".into(), "other".into()),
            ("cid".into(), "x".into()),
            ("seid".into(), "x".into()),
            ("kid".into(), "x".into()),
        ]);
        assert_eq!(cookie_from_options(&m).unwrap(), "UID=keep");
    }

    #[test]
    fn missing_rejected() {
        assert!(cookie_from_options(&HashMap::new()).is_err());
        let partial = HashMap::from([("uid".into(), "u".into()), ("cid".into(), "c".into())]);
        assert!(cookie_from_options(&partial).is_err());
    }
}

