//! `drivehub version | release … | update docker-swap …` sub-commands.
//!
//! ```text
//! drivehub version                                   # JSON {server_version, api_version, platform}
//! drivehub release keygen --out <secret.key>         # prints the public key (base64)
//! drivehub release manifest --version 0.2.0 [--channel stable] [--min-client 0.1.0]
//!          [--notes-file notes.md] [--base-url https://…/download/v0.2.0/]
//!          [--server linux-amd64=path] [--web path.tar.gz] [--docker image:tag]
//!          [--android path.apk[=versionCode]] [--out release-manifest.json]
//! drivehub release sign --key <secret.key> <release-manifest.json>   # writes <file>.sig
//! drivehub release verify [--pubkey <b64>] <release-manifest.json>
//! ```
use super::manifest::{self, Artifact, Manifest};
use anyhow::{anyhow, bail, Context};
use drivehub_core::version::{fault, server_version, API_VERSION, MIN_APP_VERSION};
use std::path::{Path, PathBuf};

/// Returns Some(exit code) when argv named a sub-command handled here.
pub async fn dispatch(args: &[String]) -> Option<anyhow::Result<()>> {
    match args.first().map(String::as_str) {
        Some("version") => Some(print_version()),
        Some("release") => Some(release(&args[1..])),
        Some("update") if args.get(1).map(String::as_str) == Some("docker-swap") => {
            Some(docker_swap(args.get(2).map(String::as_str)).await)
        }
        _ => None,
    }
}

fn print_version() -> anyhow::Result<()> {
    println!(
        "{}",
        serde_json::json!({
            "server_version": server_version(),
            "api_version": API_VERSION,
            "platform": manifest::platform(),
            "fault": fault(),
        })
    );
    Ok(())
}

fn flag(args: &[String], name: &str) -> Vec<String> {
    let mut out = vec![];
    let mut i = 0;
    while i < args.len() {
        if args[i] == name {
            if let Some(v) = args.get(i + 1) {
                out.push(v.clone());
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    out
}

fn positional(args: &[String]) -> Option<&String> {
    let mut i = 0;
    while i < args.len() {
        if args[i].starts_with("--") {
            i += 2;
        } else {
            return Some(&args[i]);
        }
    }
    None
}

fn file_artifact(kind: &str, platform: &str, path: &Path, base: &str) -> anyhow::Result<Artifact> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("bad path"))?
        .to_string_lossy()
        .to_string();
    Ok(Artifact {
        kind: kind.into(),
        platform: platform.into(),
        url: format!("{base}{name}"),
        sha256: manifest::sha256_hex(&bytes),
        size: bytes.len() as u64,
        ..Default::default()
    })
}

fn release(args: &[String]) -> anyhow::Result<()> {
    let sub = args.first().map(String::as_str).unwrap_or("");
    let rest = &args[1.min(args.len())..];
    match sub {
        "keygen" => {
            let out = flag(rest, "--out")
                .pop()
                .ok_or_else(|| anyhow!("--out <secret key file> required"))?;
            if Path::new(&out).exists() {
                bail!("{out} exists; refusing to overwrite a signing key");
            }
            let (secret, public) = manifest::keygen();
            write_private(Path::new(&out), &secret)?;
            println!("{public}");
            eprintln!("secret key written to {out} (keep it out of the repository)");
            Ok(())
        }
        "manifest" => {
            let version = flag(rest, "--version")
                .pop()
                .unwrap_or_else(|| server_version().to_string());
            let base = flag(rest, "--base-url").pop().unwrap_or_default();
            let mut m = Manifest {
                version,
                channel: flag(rest, "--channel")
                    .pop()
                    .unwrap_or_else(|| "stable".into()),
                api_version: API_VERSION,
                min_client_version: flag(rest, "--min-client")
                    .pop()
                    .unwrap_or_else(|| MIN_APP_VERSION.into()),
                released_at: crate::audit::iso(crate::auth::now()),
                notes: match flag(rest, "--notes-file").pop() {
                    Some(f) => std::fs::read_to_string(&f).with_context(|| format!("read {f}"))?,
                    None => flag(rest, "--notes").pop().unwrap_or_default(),
                },
                artifacts: vec![],
            };
            for s in flag(rest, "--server") {
                let (plat, path) = s
                    .split_once('=')
                    .ok_or_else(|| anyhow!("--server expects <platform>=<path>"))?;
                m.artifacts
                    .push(file_artifact("server", plat, Path::new(path), &base)?);
            }
            for w in flag(rest, "--web") {
                m.artifacts
                    .push(file_artifact("web", "", Path::new(&w), &base)?);
            }
            for d in flag(rest, "--docker") {
                m.artifacts.push(Artifact {
                    kind: "docker".into(),
                    image: d,
                    ..Default::default()
                });
            }
            for a in flag(rest, "--android") {
                let (path, code) = match a.split_once('=') {
                    Some((p, c)) => (p.to_string(), c.parse().ok()),
                    None => (a.clone(), None),
                };
                let mut art = file_artifact("android", "android", Path::new(&path), &base)?;
                art.version_code = code;
                m.artifacts.push(art);
            }
            m.validate()?;
            let json = serde_json::to_string_pretty(&m)? + "\n";
            match flag(rest, "--out").pop() {
                Some(o) => std::fs::write(&o, json)?,
                None => print!("{json}"),
            }
            Ok(())
        }
        "sign" => {
            let key = flag(rest, "--key")
                .pop()
                .or_else(|| std::env::var("DRIVEHUB_RELEASE_KEY").ok())
                .ok_or_else(|| {
                    anyhow!("--key <secret key file> (or DRIVEHUB_RELEASE_KEY) required")
                })?;
            let file = positional(rest).ok_or_else(|| anyhow!("manifest path required"))?;
            let sk = manifest::parse_secret(&std::fs::read_to_string(&key)?)?;
            let body = std::fs::read(file)?;
            let m: Manifest = serde_json::from_slice(&body).context("manifest JSON")?;
            m.validate()?;
            let sig = manifest::sign(&body, &sk);
            let out = PathBuf::from(format!("{file}.sig"));
            std::fs::write(&out, sig)?;
            eprintln!(
                "signed {file} with key {} -> {}",
                manifest::key_id(&sk.verifying_key()),
                out.display()
            );
            Ok(())
        }
        "verify" => {
            let file = positional(rest).ok_or_else(|| anyhow!("manifest path required"))?;
            let mut extra = flag(rest, "--pubkey");
            if let Ok(v) = std::env::var("DRIVEHUB_UPDATE_TRUSTED_KEYS") {
                extra.extend(
                    v.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                );
            }
            let keys = manifest::trusted_keys(&extra)?;
            let body = std::fs::read(file)?;
            let sig = std::fs::read_to_string(format!("{file}.sig"))?;
            let kid = manifest::verify(&body, &sig, &keys)?;
            let m = manifest::parse_verified(&body, &sig, &keys)?;
            println!("OK {} ({}) signed by {kid}", m.version, m.channel);
            Ok(())
        }
        _ => bail!("usage: drivehub release keygen|manifest|sign|verify …"),
    }
}

fn write_private(p: &Path, s: &str) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(p)?;
        f.write_all(s.as_bytes())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(p, s)?;
        Ok(())
    }
}

async fn docker_swap(plan: Option<&str>) -> anyhow::Result<()> {
    let plan = super::docker::SwapPlan::decode(plan.ok_or_else(|| anyhow!("plan required"))?)?;
    let sock = std::env::var("DRIVEHUB_UPDATE_DOCKER_SOCKET")
        .unwrap_or_else(|_| "/var/run/docker.sock".into());
    let api = super::docker::SocketApi(sock.into());
    let id = super::docker::run_swap(&api, &plan, std::time::Duration::from_secs(2)).await?;
    eprintln!("container {} now runs {} ({id})", plan.name, plan.image);
    Ok(())
}
