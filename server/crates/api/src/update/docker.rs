//! Docker deployments. Inside a container the binary is not replaced; instead:
//! * without access to the Docker socket the API returns the exact commands to run;
//! * with `DRIVEHUB_UPDATE_DOCKER_SOCKET` explicitly set, the server pulls the new image and
//!   starts a short-lived *helper* container (new image, socket mounted) that runs
//!   `drivehub update docker-swap <plan>`: rename + stop the old container, create the new one
//!   with the same config/mounts/networks, wait for it to become healthy, then remove the old
//!   one — or, if the new container never becomes healthy, delete it and restart the old one.
//!   (A container cannot stop itself and keep orchestrating, hence the helper.)
use anyhow::{anyhow, bail, Context};
use async_trait::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Best-effort detection of running inside a container (`DRIVEHUB_IN_DOCKER=1/0` overrides).
pub fn in_container() -> bool {
    if let Ok(v) = std::env::var("DRIVEHUB_IN_DOCKER") {
        return matches!(v.as_str(), "1" | "true" | "yes");
    }
    if Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists() {
        return true;
    }
    std::fs::read_to_string("/proc/1/cgroup")
        .map(|s| cgroup_says_container(&s))
        .unwrap_or(false)
}

pub fn cgroup_says_container(s: &str) -> bool {
    ["docker", "containerd", "kubepods", "libpod"]
        .iter()
        .any(|k| s.contains(k))
}

/// Our own container id / name (Docker sets the hostname to the short id).
pub fn self_container() -> String {
    std::env::var("DRIVEHUB_CONTAINER")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "drivehub".into())
}

/// Commands for an operator when the server may not touch Docker itself.
pub fn manual_commands(image: &str, container: &str) -> Vec<String> {
    vec![
        "# docker compose (run in the directory holding docker-compose.yml; set the image tag there if pinned):".into(),
        "docker compose pull && docker compose up -d".into(),
        "# plain docker:".into(),
        format!("docker pull {image}"),
        format!("docker stop {container} && docker rename {container} {container}-old"),
        format!("docker run -d --name {container} <same -p/-v/--env options as before> {image}"),
        format!("docker rm {container}-old   # once the new container is healthy"),
    ]
}

/// `repo[:tag]` → (`repo`, `tag`) for `/images/create` (digests stay in the repo part).
pub fn split_image(image: &str) -> (String, String) {
    if image.contains('@') {
        return (image.to_string(), String::new());
    }
    match image.rsplit_once(':') {
        Some((r, t)) if !t.contains('/') => (r.to_string(), t.to_string()),
        _ => (image.to_string(), "latest".into()),
    }
}

/// Body for `POST /containers/create` that clones `inspect` (GET /containers/{id}/json)
/// onto `image`: same env, cmd, labels, mounts, ports, restart policy and networks.
pub fn create_body(inspect: &Value, image: &str) -> Value {
    let mut cfg = inspect["Config"].clone();
    if !cfg.is_object() {
        cfg = json!({});
    }
    cfg["Image"] = json!(image);
    // Docker defaults the hostname to the container id; let the new container get its own.
    let id = inspect["Id"].as_str().unwrap_or("");
    if cfg["Hostname"]
        .as_str()
        .is_some_and(|h| !h.is_empty() && id.starts_with(h))
    {
        cfg.as_object_mut().unwrap().remove("Hostname");
    }
    cfg["HostConfig"] = inspect["HostConfig"].clone();
    let mut endpoints = serde_json::Map::new();
    if let Some(nets) = inspect["NetworkSettings"]["Networks"].as_object() {
        for (name, n) in nets {
            let mut e = json!({});
            for k in ["Aliases", "IPAMConfig", "Links", "DriverOpts"] {
                if !n[k].is_null() {
                    e[k] = n[k].clone();
                }
            }
            endpoints.insert(name.clone(), e);
        }
    }
    cfg["NetworkingConfig"] = json!({ "EndpointsConfig": endpoints });
    cfg
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SwapPlan {
    pub old: String,
    pub name: String,
    pub image: String,
    pub create: Value,
    pub health_timeout_secs: u64,
}

impl SwapPlan {
    pub fn encode(&self) -> String {
        B64.encode(serde_json::to_vec(self).unwrap())
    }
    pub fn decode(s: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_slice(&B64.decode(s.trim())?)?)
    }
}

/// Minimal Docker Engine API surface (real: unix socket; tests: a fake).
#[async_trait]
pub trait DockerApi: Send + Sync {
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> anyhow::Result<(u16, Value)>;
}

async fn ok(
    api: &dyn DockerApi,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> anyhow::Result<Value> {
    let (s, v) = api.call(method, path, body).await?;
    if !(200..300).contains(&s) && s != 304 {
        bail!(
            "docker {method} {path}: HTTP {s} {}",
            v["message"].as_str().unwrap_or("")
        );
    }
    Ok(v)
}

/// Runs in the helper container: swap old → new, with rollback when the new container does
/// not become healthy. Returns the new container id.
pub async fn run_swap(
    api: &dyn DockerApi,
    plan: &SwapPlan,
    poll: std::time::Duration,
) -> anyhow::Result<String> {
    let parked = format!("{}-old-{}", plan.name, crate::auth::now());
    ok(
        api,
        "POST",
        &format!("/containers/{}/rename?name={parked}", plan.old),
        None,
    )
    .await?;
    ok(
        api,
        "POST",
        &format!("/containers/{}/stop?t=20", plan.old),
        None,
    )
    .await?;
    let restore = |why: String| async move {
        let _ = api
            .call(
                "POST",
                &format!("/containers/{}/rename?name={}", plan.old, plan.name),
                None,
            )
            .await;
        let _ = api
            .call("POST", &format!("/containers/{}/start", plan.old), None)
            .await;
        anyhow::anyhow!(why)
    };
    let created = match ok(
        api,
        "POST",
        &format!("/containers/create?name={}", plan.name),
        Some(&plan.create),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => return Err(restore(format!("create new container: {e}")).await),
    };
    let new_id = created["Id"].as_str().unwrap_or("").to_string();
    if let Err(e) = ok(api, "POST", &format!("/containers/{new_id}/start"), None).await {
        let _ = api
            .call("DELETE", &format!("/containers/{new_id}?force=true"), None)
            .await;
        return Err(restore(format!("start new container: {e}")).await);
    }
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(plan.health_timeout_secs);
    let mut healthy = false;
    loop {
        if let Ok(v) = ok(api, "GET", &format!("/containers/{new_id}/json"), None).await {
            let st = &v["State"];
            let running = st["Running"].as_bool().unwrap_or(false);
            match st["Health"]["Status"].as_str() {
                Some("healthy") => healthy = true,
                Some("unhealthy") => break,
                Some(_) => {}
                None => healthy = running, // image without HEALTHCHECK: running is the bar
            }
            if healthy || !running && st["Status"].as_str() == Some("exited") {
                break;
            }
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(poll).await;
    }
    if !healthy {
        let _ = api
            .call("DELETE", &format!("/containers/{new_id}?force=true"), None)
            .await;
        return Err(
            restore("new container did not become healthy; old container restored".into()).await,
        );
    }
    let _ = api
        .call(
            "DELETE",
            &format!("/containers/{}?force=true", plan.old),
            None,
        )
        .await;
    Ok(new_id)
}

/// Docker Engine API client over the unix socket (HTTP/1.1, `Connection: close`).
pub struct SocketApi(pub PathBuf);

#[async_trait]
impl DockerApi for SocketApi {
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> anyhow::Result<(u16, Value)> {
        #[cfg(unix)]
        {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut s = tokio::net::UnixStream::connect(&self.0)
                .await
                .with_context(|| format!("connect {}", self.0.display()))?;
            let b = body.map(|b| b.to_string()).unwrap_or_default();
            let req = format!(
                "{method} /v1.41{path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{b}",
                b.len()
            );
            s.write_all(req.as_bytes()).await?;
            let mut raw = vec![];
            s.read_to_end(&mut raw).await?;
            let (status, body) = parse_response(&raw)?;
            // /images/create streams JSON lines; surface the last one (errors land there).
            let text = String::from_utf8_lossy(&body);
            let v = serde_json::from_str(&text).unwrap_or_else(|_| {
                text.lines()
                    .rev()
                    .find_map(|l| serde_json::from_str(l).ok())
                    .unwrap_or(Value::Null)
            });
            Ok((status, v))
        }
        #[cfg(not(unix))]
        {
            let _ = (method, path, body);
            bail!("docker socket is only supported on unix")
        }
    }
}

/// Parses an HTTP/1.1 response (Content-Length, chunked, or read-to-close).
pub fn parse_response(raw: &[u8]) -> anyhow::Result<(u16, Vec<u8>)> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| anyhow!("truncated HTTP response"))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow!("bad status line"))?;
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let mut body = &raw[split + 4..];
    if !chunked {
        return Ok((status, body.to_vec()));
    }
    let mut out = vec![];
    loop {
        let nl = body
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| anyhow!("bad chunk"))?;
        let size_s = String::from_utf8_lossy(&body[..nl]);
        let size = usize::from_str_radix(size_s.split(';').next().unwrap().trim(), 16)
            .map_err(|_| anyhow!("bad chunk size"))?;
        body = &body[nl + 2..];
        if size == 0 {
            break;
        }
        if body.len() < size {
            bail!("truncated chunk");
        }
        out.extend_from_slice(&body[..size]);
        body = &body[(size + 2).min(body.len())..];
    }
    Ok((status, out))
}

/// Called by the running server: pull the image, build the plan, start the helper.
pub async fn start_update(
    api: &dyn DockerApi,
    socket: &Path,
    image: &str,
    health_timeout_secs: u64,
) -> anyhow::Result<String> {
    let me = self_container();
    let inspect = ok(api, "GET", &format!("/containers/{me}/json"), None)
        .await
        .context("inspect own container")?;
    let (repo, tag) = split_image(image);
    let pulled = ok(
        api,
        "POST",
        &format!("/images/create?fromImage={repo}&tag={tag}"),
        None,
    )
    .await
    .context("pull image")?;
    if let Some(e) = pulled["error"].as_str() {
        bail!("pull {image}: {e}");
    }
    let name = inspect["Name"]
        .as_str()
        .unwrap_or(&me)
        .trim_start_matches('/')
        .to_string();
    let plan = SwapPlan {
        old: inspect["Id"].as_str().unwrap_or(&me).to_string(),
        name: name.clone(),
        image: image.to_string(),
        create: create_body(&inspect, image),
        health_timeout_secs,
    };
    let sock = socket.display().to_string();
    let helper = json!({
        "Image": image,
        "User": "0",
        "Cmd": ["update", "docker-swap", plan.encode()],
        "Env": [format!("DRIVEHUB_UPDATE_DOCKER_SOCKET={sock}")],
        "HostConfig": {"Binds": [format!("{sock}:{sock}")], "AutoRemove": true},
        "Labels": {"drivehub.role": "updater"}
    });
    let c = ok(
        api,
        "POST",
        &format!(
            "/containers/create?name={name}-updater-{}",
            crate::auth::now()
        ),
        Some(&helper),
    )
    .await
    .context("create updater container")?;
    let id = c["Id"].as_str().unwrap_or("").to_string();
    ok(api, "POST", &format!("/containers/{id}/start"), None)
        .await
        .context("start updater container")?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn detection_and_commands() {
        assert!(cgroup_says_container("0::/system.slice/docker-abc.scope"));
        assert!(!cgroup_says_container("0::/user.slice"));
        let c = manual_commands("ghcr.io/x/drivehub:0.2.0", "dh");
        assert!(c
            .iter()
            .any(|l| l == "docker pull ghcr.io/x/drivehub:0.2.0"));
        assert!(c.iter().any(|l| l.contains("docker compose pull")));
        assert_eq!(
            split_image("ghcr.io/x/drivehub:0.2.0"),
            ("ghcr.io/x/drivehub".into(), "0.2.0".into())
        );
        assert_eq!(
            split_image("localhost:5000/dh"),
            ("localhost:5000/dh".into(), "latest".into())
        );
    }

    #[test]
    fn create_body_clones_container() {
        let inspect = json!({
            "Id": "abcdef123456789", "Name": "/drivehub",
            "Config": {"Hostname": "abcdef123456", "Image": "drivehub:0.1.0", "Env": ["A=1"], "Labels": {"x": "y"}},
            "HostConfig": {"Binds": ["/srv/data:/data"], "PortBindings": {"8470/tcp": [{"HostPort": "8470"}]}, "RestartPolicy": {"Name": "unless-stopped"}},
            "NetworkSettings": {"Networks": {"dh_net": {"Aliases": ["drivehub"], "IPAddress": "172.18.0.2"}}}
        });
        let b = create_body(&inspect, "drivehub:0.2.0");
        assert_eq!(b["Image"], "drivehub:0.2.0");
        assert!(b.get("Hostname").is_none());
        assert_eq!(b["Env"][0], "A=1");
        assert_eq!(b["HostConfig"]["Binds"][0], "/srv/data:/data");
        assert_eq!(
            b["NetworkingConfig"]["EndpointsConfig"]["dh_net"]["Aliases"][0],
            "drivehub"
        );
        assert!(b["NetworkingConfig"]["EndpointsConfig"]["dh_net"]
            .get("IPAddress")
            .is_none());
        let p = SwapPlan {
            old: "abc".into(),
            name: "drivehub".into(),
            image: "drivehub:0.2.0".into(),
            create: b,
            health_timeout_secs: 5,
        };
        assert_eq!(SwapPlan::decode(&p.encode()).unwrap(), p);
    }

    #[test]
    fn http_parsing() {
        let (s, b) = parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!((s, b.as_slice()), (200, &b"{}"[..]));
        let (s, b) = parse_response(b"HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n").unwrap();
        assert_eq!((s, b.as_slice()), (201, &b"abcde"[..]));
        assert!(parse_response(b"garbage").is_err());
    }

    /// Fake engine: records calls; the new container reports `health`.
    struct Fake {
        calls: Mutex<Vec<String>>,
        health: &'static str,
    }
    #[async_trait]
    impl DockerApi for Fake {
        async fn call(
            &self,
            method: &str,
            path: &str,
            _b: Option<&Value>,
        ) -> anyhow::Result<(u16, Value)> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("{method} {}", path.split('?').next().unwrap()));
            Ok(match (method, path) {
                ("POST", p) if p.starts_with("/containers/create") => (201, json!({"Id": "new1"})),
                ("GET", "/containers/new1/json") => (
                    200,
                    json!({"State": {"Running": true, "Health": {"Status": self.health}}}),
                ),
                _ => (204, Value::Null),
            })
        }
    }

    #[tokio::test]
    async fn swap_success_and_rollback() {
        let plan = SwapPlan {
            old: "old1".into(),
            name: "drivehub".into(),
            image: "i:2".into(),
            create: json!({}),
            health_timeout_secs: 1,
        };
        let ok_api = Fake {
            calls: Mutex::new(vec![]),
            health: "healthy",
        };
        assert_eq!(
            run_swap(&ok_api, &plan, std::time::Duration::from_millis(10))
                .await
                .unwrap(),
            "new1"
        );
        let c = ok_api.calls.lock().unwrap().clone();
        assert_eq!(c.first().unwrap(), "POST /containers/old1/rename");
        assert!(c.contains(&"DELETE /containers/old1".to_string()), "{c:?}");

        let bad = Fake {
            calls: Mutex::new(vec![]),
            health: "unhealthy",
        };
        let e = run_swap(&bad, &plan, std::time::Duration::from_millis(10))
            .await
            .unwrap_err();
        assert!(e.to_string().contains("old container restored"));
        let c = bad.calls.lock().unwrap().clone();
        assert!(c.contains(&"DELETE /containers/new1".to_string()), "{c:?}");
        assert_eq!(c.last().unwrap(), "POST /containers/old1/start");
        assert!(!c.contains(&"DELETE /containers/old1".to_string()));
    }
}
