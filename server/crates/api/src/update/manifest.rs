//! Signed release manifest (`release-manifest.json` + detached `release-manifest.json.sig`).
//!
//! Signature format (minisign-like text, Ed25519 over the exact manifest bytes):
//! ```text
//! untrusted comment: drivehub release signature
//! key: <key id = first 8 bytes of SHA-256(public key), hex>
//! sig: <base64 64-byte Ed25519 signature>
//! ```
//! The release public key is compiled in ([`RELEASE_PUBKEY`]); deployments may trust extra
//! keys (`DRIVEHUB_UPDATE_TRUSTED_KEYS`). A manifest is only parsed after its signature
//! verifies, and every downloadable artifact carries a SHA-256 + size that is checked
//! before anything is installed.
use anyhow::{anyhow, bail, Context};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

/// Built-in DriveHub release signing key (public half; the secret never enters the repo).
pub const RELEASE_PUBKEY: &str = "0nzoK5DKnhwumseb1AyF3pPFDUgt43vcC0gaZvjLTsM=";

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
pub struct Manifest {
    pub version: String,
    /// stable | beta
    #[serde(default = "stable")]
    pub channel: String,
    pub api_version: u32,
    /// Oldest web / Android client the new server still accepts.
    pub min_client_version: String,
    #[serde(default)]
    pub released_at: String,
    /// Release notes (Markdown).
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
}

fn stable() -> String {
    "stable".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Default)]
pub struct Artifact {
    /// server | web | docker | android
    pub kind: String,
    /// linux-amd64 | linux-arm64 (server), android, "" (web / docker)
    #[serde(default)]
    pub platform: String,
    /// Absolute URL or relative to the manifest URL (server / web / android).
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    /// Docker runtime image reference, e.g. `ghcr.io/lthero-big/drivehub:0.2.0`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub image: String,
    /// Android versionCode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_code: Option<u64>,
}

impl Manifest {
    pub fn artifact(&self, kind: &str, platform: &str) -> Option<&Artifact> {
        self.artifacts
            .iter()
            .find(|a| a.kind == kind && (platform.is_empty() || a.platform == platform))
    }

    /// Structural validation (run after the signature check).
    pub fn validate(&self) -> anyhow::Result<()> {
        semver::Version::parse(&self.version).context("manifest version is not semver")?;
        semver::Version::parse(&self.min_client_version)
            .context("min_client_version is not semver")?;
        if !matches!(self.channel.as_str(), "stable" | "beta") {
            bail!("unknown channel {}", self.channel);
        }
        for a in &self.artifacts {
            match a.kind.as_str() {
                "server" | "web" | "android" => {
                    if a.url.is_empty() {
                        bail!("{} artifact without url", a.kind);
                    }
                    if a.sha256.len() != 64 || !a.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                        bail!("{} artifact has a bad sha256", a.kind);
                    }
                }
                "docker" => {
                    if a.image.is_empty() {
                        bail!("docker artifact without image");
                    }
                }
                k => bail!("unknown artifact kind {k}"),
            }
        }
        Ok(())
    }

    /// The manifest applies to `channel` (beta subscribers also take stable releases).
    pub fn matches_channel(&self, channel: &str) -> bool {
        self.channel == "stable" || channel == "beta"
    }
}

/// Server platform key of this build (`linux-amd64`, `linux-arm64`, …).
pub fn platform() -> String {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        a => a,
    };
    format!("{}-{arch}", std::env::consts::OS)
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn key_id(vk: &VerifyingKey) -> String {
    hex(&Sha256::digest(vk.as_bytes())[..8])
}

pub fn parse_pubkey(s: &str) -> anyhow::Result<VerifyingKey> {
    let raw = B64
        .decode(s.trim().trim_start_matches("drivehub-public-key:").trim())
        .context("public key is not base64")?;
    let arr: [u8; 32] = raw
        .try_into()
        .map_err(|_| anyhow!("public key must be 32 bytes"))?;
    VerifyingKey::from_bytes(&arr).map_err(|e| anyhow!("bad public key: {e}"))
}

/// Built-in key + configured extras (bad extras are reported, not silently ignored).
pub fn trusted_keys(extra: &[String]) -> anyhow::Result<Vec<VerifyingKey>> {
    let mut v = vec![];
    if let Ok(k) = parse_pubkey(RELEASE_PUBKEY) {
        v.push(k);
    }
    for e in extra {
        v.push(parse_pubkey(e).with_context(|| format!("trusted key {e}"))?);
    }
    Ok(v)
}

/// Secret key file: `drivehub-secret-key: <base64 32-byte seed>`.
pub fn parse_secret(s: &str) -> anyhow::Result<SigningKey> {
    let line = s
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .ok_or_else(|| anyhow!("empty key file"))?;
    let raw = B64
        .decode(line.trim_start_matches("drivehub-secret-key:").trim())
        .context("secret key is not base64")?;
    let arr: [u8; 32] = raw
        .try_into()
        .map_err(|_| anyhow!("secret key must be 32 bytes"))?;
    Ok(SigningKey::from_bytes(&arr))
}

pub fn keygen() -> (String, String) {
    let sk = SigningKey::generate(&mut rand::rngs::OsRng);
    (
        format!("drivehub-secret-key: {}\n", B64.encode(sk.to_bytes())),
        B64.encode(sk.verifying_key().as_bytes()),
    )
}

pub fn encode_pubkey(vk: &VerifyingKey) -> String {
    B64.encode(vk.as_bytes())
}

/// Detached signature text for `manifest` bytes.
pub fn sign(manifest: &[u8], sk: &SigningKey) -> String {
    let sig = sk.sign(manifest);
    format!(
        "untrusted comment: drivehub release signature\nkey: {}\nsig: {}\n",
        key_id(&sk.verifying_key()),
        B64.encode(sig.to_bytes())
    )
}

/// Verifies `sig_text` over `manifest` with any of `keys`; returns the matching key id.
pub fn verify(manifest: &[u8], sig_text: &str, keys: &[VerifyingKey]) -> anyhow::Result<String> {
    let mut sig_b64 = None;
    let mut kid = None;
    for l in sig_text.lines().map(str::trim) {
        if let Some(v) = l.strip_prefix("sig:") {
            sig_b64 = Some(v.trim());
        } else if let Some(v) = l.strip_prefix("key:") {
            kid = Some(v.trim());
        } else if !l.is_empty() && !l.contains(':') && sig_b64.is_none() {
            sig_b64 = Some(l); // bare base64 signature
        }
    }
    let raw = B64
        .decode(sig_b64.ok_or_else(|| anyhow!("signature file has no sig line"))?)
        .context("signature is not base64")?;
    let sig = Signature::from_slice(&raw).map_err(|e| anyhow!("malformed signature: {e}"))?;
    if keys.is_empty() {
        bail!("no trusted update keys configured");
    }
    for k in keys {
        if kid.is_some_and(|id| id != key_id(k)) {
            continue;
        }
        if k.verify(manifest, &sig).is_ok() {
            return Ok(key_id(k));
        }
    }
    bail!("manifest signature verification failed (untrusted key or tampered manifest)")
}

/// Signature check, then JSON parse, then structural validation.
pub fn parse_verified(
    manifest: &[u8],
    sig_text: &str,
    keys: &[VerifyingKey],
) -> anyhow::Result<Manifest> {
    verify(manifest, sig_text, keys)?;
    let m: Manifest = serde_json::from_slice(manifest).context("manifest is not valid JSON")?;
    m.validate()?;
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn manifest() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": "0.2.0", "channel": "stable", "api_version": 1, "min_client_version": "0.1.0",
            "notes": "hi",
            "artifacts": [{"kind": "server", "platform": "linux-amd64", "url": "drivehub", "sha256": "a".repeat(64), "size": 3},
                          {"kind": "docker", "image": "drivehub:0.2.0"}]
        }))
        .unwrap()
    }

    #[test]
    fn sign_verify_roundtrip_and_rejections() {
        let sk = test_key(7);
        let m = manifest();
        let sig = sign(&m, &sk);
        let keys = vec![sk.verifying_key()];
        let parsed = parse_verified(&m, &sig, &keys).unwrap();
        assert_eq!(parsed.version, "0.2.0");
        assert!(parsed.artifact("server", "linux-amd64").is_some());
        // tampered manifest
        let mut bad = m.clone();
        bad[5] ^= 1;
        assert!(parse_verified(&bad, &sig, &keys).is_err());
        // signed by an untrusted key
        let other = sign(&m, &test_key(9));
        let e = parse_verified(&m, &other, &keys).unwrap_err().to_string();
        assert!(e.contains("verification failed"), "{e}");
        // garbage signature
        assert!(verify(&m, "sig: !!!", &keys).is_err());
        assert!(verify(&m, "", &keys).is_err());
        // bare base64 signature line also accepted
        let bare = sig.lines().find_map(|l| l.strip_prefix("sig: ")).unwrap();
        assert!(verify(&m, bare, &keys).is_ok());
        // a second trusted key works
        assert!(verify(
            &m,
            &other,
            &[sk.verifying_key(), test_key(9).verifying_key()]
        )
        .is_ok());
    }

    #[test]
    fn secret_and_public_key_encoding() {
        let (sec, public) = keygen();
        let sk = parse_secret(&sec).unwrap();
        assert_eq!(encode_pubkey(&sk.verifying_key()), public);
        assert!(parse_pubkey(&public).is_ok());
        assert!(parse_pubkey("abc").is_err());
        assert!(trusted_keys(&["nope".into()]).is_err());
        assert!(
            !trusted_keys(&[]).unwrap().is_empty(),
            "built-in key must parse"
        );
    }

    #[test]
    fn validation() {
        let mut m: Manifest = serde_json::from_slice(&manifest()).unwrap();
        assert!(m.validate().is_ok());
        m.artifacts[0].sha256 = "xyz".into();
        assert!(m.validate().is_err());
        m.artifacts[0].sha256 = "a".repeat(64);
        m.version = "v2".into();
        assert!(m.validate().is_err());
        m.version = "0.2.0".into();
        m.channel = "nightly".into();
        assert!(m.validate().is_err());
        m.channel = "beta".into();
        assert!(!m.matches_channel("stable"));
        assert!(m.matches_channel("beta"));
    }
}
