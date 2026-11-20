//! DEPTAI-484 end-to-end: a real `drivehub` process (v0.1.0) upgrades itself from a local
//! HTTP update source to v0.2.0 (exec in place, same PID), then refuses a corrupt package and
//! a badly signed manifest, and rolls back automatically when the new version fails its
//! health check or its database migration.
//!
//! Versions are produced from the one debug binary by tiny wrapper "releases" that set
//! `DRIVEHUB_TEST_VERSION` / `DRIVEHUB_TEST_FAULT` (honoured by debug builds only) and exec it,
//! so each release is a distinct file with its own SHA-256 just like a real binary.
use axum::{extract::State, routing::post, Json, Router};
use base64::Engine;
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_drivehub");

fn wrapper(version: &str, fault: &str) -> String {
    format!(
        "#!/bin/sh\n# drivehub test release {version} {fault}\nexport DRIVEHUB_TEST_VERSION={version}\nexport DRIVEHUB_TEST_FAULT={fault}\nexec {BIN} \"$@\"\n"
    )
}

fn sha(b: &[u8]) -> String {
    drivehub_api::update::manifest::sha256_hex(b)
}

fn web_tgz(index: &str, build: &str) -> Vec<u8> {
    let mut b = tar::Builder::new(flate2::write::GzEncoder::new(
        vec![],
        flate2::Compression::fast(),
    ));
    for (name, body) in [
        ("index.html", index.to_string()),
        (
            "version.json",
            json!({"version": "x", "build": build}).to_string(),
        ),
    ] {
        let mut h = tar::Header::new_gnu();
        h.set_size(body.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, name, body.as_bytes()).unwrap();
    }
    b.into_inner().unwrap().finish().unwrap()
}

/// Publishes a release directory `<rel>/<dir>/` and returns the manifest bytes.
fn publish(
    rel: &Path,
    dir: &str,
    version: &str,
    fault: &str,
    key: &SigningKey,
    web: Option<&str>,
) -> PathBuf {
    let d = rel.join(dir);
    std::fs::create_dir_all(&d).unwrap();
    let bin = wrapper(version, fault);
    std::fs::write(d.join("drivehub-bin"), &bin).unwrap();
    let mut artifacts = vec![
        json!({"kind": "server", "platform": drivehub_api::update::manifest::platform(),
               "url": "drivehub-bin", "sha256": sha(bin.as_bytes()), "size": bin.len()}),
        json!({"kind": "docker", "image": format!("drivehub:{version}")}),
        json!({"kind": "android", "platform": "android", "url": "app.apk", "sha256": sha(b"apk"), "size": 3, "version_code": 2}),
    ];
    if let Some(build) = web {
        let t = web_tgz(&format!("<html>{version}</html>"), build);
        std::fs::write(d.join("web.tar.gz"), &t).unwrap();
        artifacts
            .push(json!({"kind": "web", "url": "web.tar.gz", "sha256": sha(&t), "size": t.len()}));
    }
    let m = serde_json::to_vec_pretty(&json!({
        "version": version, "channel": "stable", "api_version": 1, "min_client_version": "0.1.0",
        "notes": format!("## {version}\n- test release"), "artifacts": artifacts
    }))
    .unwrap();
    std::fs::write(d.join("release-manifest.json"), &m).unwrap();
    std::fs::write(
        d.join("release-manifest.json.sig"),
        drivehub_api::update::manifest::sign(&m, key),
    )
    .unwrap();
    d
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

struct Server {
    child: std::process::Child,
    base: String,
    http: reqwest::Client,
    token: String,
    install: PathBuf,
    data: PathBuf,
    log: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    async fn req(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut r = self
            .http
            .request(method.parse().unwrap(), format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if let Some(b) = body {
            r = r.json(&b);
        }
        match r.send().await {
            Ok(res) => {
                let s = res.status().as_u16();
                (s, res.json().await.unwrap_or(Value::Null))
            }
            Err(_) => (0, Value::Null),
        }
    }

    async fn version(&self) -> Option<Value> {
        let r = self
            .http
            .get(format!("{}/api/version", self.base))
            .send()
            .await
            .ok()?;
        r.json().await.ok()
    }

    /// Waits until the update status reaches one of `states` (server may restart meanwhile).
    async fn wait_state(&self, states: &[&str], secs: u64) -> Value {
        let t = Instant::now();
        loop {
            let (s, v) = self.req("GET", "/api/admin/update/status", None).await;
            if s == 200 && states.contains(&v["status"]["state"].as_str().unwrap_or("")) {
                return v;
            }
            if t.elapsed() > Duration::from_secs(secs) {
                panic!(
                    "timeout waiting for {states:?}; last {s} {v}\n--- log ---\n{}",
                    std::fs::read_to_string(&self.log).unwrap_or_default()
                );
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    async fn audit_actions(&self) -> Vec<String> {
        let (_, v) = self
            .req("GET", "/api/admin/audit?channel=admin&limit=500", None)
            .await;
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| r["action"].as_str().unwrap_or("").to_string())
            .collect()
    }

    fn exe(&self) -> String {
        std::fs::read_to_string(self.install.join("drivehub")).unwrap()
    }

    fn assert_alive(&mut self) {
        assert!(
            self.child.try_wait().unwrap().is_none(),
            "process exited (exec must keep the PID)"
        );
    }
}

type Hooks = Arc<Mutex<Vec<Value>>>;

async fn hook(State(h): State<Hooks>, Json(v): Json<Value>) -> &'static str {
    h.lock().unwrap().push(v);
    "ok"
}

#[tokio::test(flavor = "multi_thread")]
async fn binary_upgrade_reject_and_rollback() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let (rel, install, data) = (root.join("rel"), root.join("install"), root.join("data"));
    for d in [&rel, &install, &data, &install.join("web")] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(install.join("web/index.html"), "<html>old</html>").unwrap();
    std::fs::write(install.join("web/version.json"), r#"{"build":"b1"}"#).unwrap();

    // update source: static release dirs + a webhook sink
    let hooks: Hooks = Arc::default();
    let src = Router::new()
        .route("/hook", post(hook))
        .with_state(hooks.clone())
        .fallback_service(tower_http::services::ServeDir::new(&rel));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let src_base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, src).await.unwrap() });

    let key = SigningKey::from_bytes(&[42; 32]);
    let pubkey = base64::engine::general_purpose::STANDARD.encode(key.verifying_key().as_bytes());
    let rogue = SigningKey::from_bytes(&[13; 32]);
    publish(&rel, "v2", "0.2.0", "", &key, Some("b2"));
    // corrupt package: manifest signed over the good hash, file damaged afterwards
    let v3 = publish(&rel, "v3", "0.3.0", "", &key, None);
    let mut damaged = std::fs::read(v3.join("drivehub-bin")).unwrap();
    damaged[30] ^= 0x20; // same size, one flipped bit
    std::fs::write(v3.join("drivehub-bin"), damaged).unwrap();
    // bad signature: manifest signed by an untrusted key
    publish(&rel, "v4", "0.4.0", "", &rogue, None);
    // healthy-looking binary whose health check fails after the restart
    publish(&rel, "v5", "0.5.0", "unhealthy", &key, Some("b5"));
    // binary whose database migration fails on boot
    publish(&rel, "v6", "0.6.0", "migrate", &key, None);

    std::fs::write(install.join("drivehub"), wrapper("0.1.0", "")).unwrap();
    drivehub_api::update::install::chmod_x(&install.join("drivehub")).unwrap();
    let port = free_port();
    let log = root.join("server.log");
    let logf = std::fs::File::create(&log).unwrap();
    let child = std::process::Command::new(install.join("drivehub"))
        .env("DRIVEHUB_BIND", format!("127.0.0.1:{port}"))
        .env("DRIVEHUB_DATA_DIR", &data)
        .env("DRIVEHUB_WEB_DIR", install.join("web"))
        .env(
            "DRIVEHUB_UPDATE_URL",
            format!("{src_base}/v2/release-manifest.json"),
        )
        .env("DRIVEHUB_UPDATE_TRUSTED_KEYS", &pubkey)
        .env("DRIVEHUB_UPDATE_EXE", install.join("drivehub"))
        .env("DRIVEHUB_UPDATE_HEALTH_TIMEOUT_SECS", "6")
        .env("DRIVEHUB_IN_DOCKER", "0")
        .env("RUST_LOG", "info,tower_http=warn")
        .stdout(logf.try_clone().unwrap())
        .stderr(logf)
        .spawn()
        .unwrap();
    let mut s = Server {
        child,
        base: format!("http://127.0.0.1:{port}"),
        http: reqwest::Client::new(),
        token: String::new(),
        install: install.clone(),
        data: data.clone(),
        log,
    };
    let t = Instant::now();
    while s.version().await.is_none() {
        assert!(
            t.elapsed() < Duration::from_secs(30),
            "server did not start"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let v = s.version().await.unwrap();
    assert_eq!(v["server_version"], "0.1.0");
    assert_eq!(v["update_available"], false);
    assert_eq!(v["web_build"], "b1");
    let r = s
        .http
        .post(format!("{}/api/auth/init", s.base))
        .json(&json!({"username": "admin", "email": "a@example.com", "password": "admin-pass-1"}))
        .send()
        .await
        .unwrap();
    s.token = r.json::<Value>().await.unwrap()["access_token"]
        .as_str()
        .unwrap()
        .to_string();
    // admin only
    let anon = s
        .http
        .get(format!("{}/api/admin/update/status", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(anon.status().as_u16(), 401);
    let (st, _) = s
        .req(
            "PUT",
            "/api/admin/update/settings",
            Some(json!({"mode": "bogus"})),
        )
        .await;
    assert_eq!(st, 400);
    let (st, _) = s
        .req(
            "PUT",
            "/api/admin/update/settings",
            Some(json!({"mode": "notify", "notify_webhook": format!("{src_base}/hook")})),
        )
        .await;
    assert_eq!(st, 200);

    // ---- check: verified manifest, update available, surfaced in /api/version
    let (st, v) = s.req("POST", "/api/admin/update/check", None).await;
    assert_eq!(st, 200, "{v}");
    assert_eq!(v["last_check"]["latest"]["version"], "0.2.0");
    assert_eq!(v["last_check"]["update_available"], true);
    assert!(v["last_check"]["latest"]["notes"]
        .as_str()
        .unwrap()
        .contains("test release"));
    let pv = s.version().await.unwrap();
    assert_eq!(
        (pv["latest"].as_str(), pv["update_available"].as_bool()),
        (Some("0.2.0"), Some(true))
    );
    // client package from the manifest (no local APK hosted)
    let a: Value = s
        .http
        .get(format!("{}/api/client/android/latest", s.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(a["source"], "manifest");
    assert_eq!(a["url"], format!("{src_base}/v2/app.apk"));
    assert_eq!(a["version_code"], 2);

    // ---- 1. real upgrade 0.1.0 -> 0.2.0 (download, verify, DB backup, swap, exec, health)
    let (st, v) = s
        .req("POST", "/api/admin/update/apply", Some(json!({})))
        .await;
    assert_eq!(st, 202, "{v}");
    let v = s
        .wait_state(&["succeeded", "failed", "rolled_back"], 90)
        .await;
    assert_eq!(v["status"]["state"], "succeeded", "{v}");
    assert_eq!(v["current_version"], "0.2.0");
    s.assert_alive();
    assert!(s.exe().contains("0.2.0"));
    assert!(std::fs::read_to_string(install.join("drivehub.bak"))
        .unwrap()
        .contains("0.1.0"));
    assert_eq!(
        std::fs::read_to_string(install.join("web/index.html")).unwrap(),
        "<html>0.2.0</html>"
    );
    assert!(install.join("web.bak/index.html").exists());
    assert_eq!(v["effective"]["db_backups"].as_array().unwrap().len(), 1);
    let pv = s.version().await.unwrap();
    assert_eq!(pv["server_version"], "0.2.0");
    assert_eq!(pv["update_available"], false);
    assert_eq!(v["last_check"]["update_available"], false, "installed release is no longer offered");
    assert_eq!(pv["web_build"], "b2", "web refresh prompt keys off this");
    let r = s
        .http
        .get(format!("{}/api/version", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.headers()["x-drivehub-server-version"], "0.2.0");
    assert!(!data.join("update/pending.json").exists());

    // ---- 2. corrupt package is refused (sha256 mismatch), nothing replaced
    let (st, _) = s
        .req("PUT", "/api/admin/update/settings", Some(json!({"source_url": format!("{src_base}/v3/release-manifest.json"), "notify_webhook": format!("{src_base}/hook")})))
        .await;
    assert_eq!(st, 200);
    let (st, v) = s
        .req("POST", "/api/admin/update/apply", Some(json!({})))
        .await;
    assert_eq!(st, 202, "{v}");
    let v = s.wait_state(&["failed", "succeeded"], 30).await;
    assert_eq!(v["status"]["state"], "failed");
    assert!(
        v["status"]["error"]
            .as_str()
            .unwrap()
            .contains("sha256 mismatch"),
        "{v}"
    );
    assert!(s.exe().contains("0.2.0"));
    assert_eq!(s.version().await.unwrap()["server_version"], "0.2.0");

    // ---- 3. manifest signed by an untrusted key is rejected (check + apply)
    let (st, _) = s
        .req(
            "PUT",
            "/api/admin/update/settings",
            Some(json!({"source_url": format!("{src_base}/v4/release-manifest.json")})),
        )
        .await;
    assert_eq!(st, 200);
    let (st, v) = s.req("POST", "/api/admin/update/check", None).await;
    assert_eq!(st, 200);
    assert!(
        v["last_check"]["error"]
            .as_str()
            .unwrap()
            .contains("signature verification failed"),
        "{v}"
    );
    assert!(
        v["last_check"]["latest"].is_null(),
        "unverified manifest must not be exposed"
    );
    assert_eq!(s.version().await.unwrap()["update_available"], false);
    s.req("POST", "/api/admin/update/apply", Some(json!({})))
        .await;
    let v = s.wait_state(&["failed"], 30).await;
    assert!(
        v["status"]["error"].as_str().unwrap().contains("signature"),
        "{v}"
    );
    // a tampered (re-written) manifest with the old signature fails too
    let m4 = rel.join("v2/release-manifest.json");
    let orig = std::fs::read(&m4).unwrap();
    std::fs::write(
        &m4,
        String::from_utf8(orig.clone())
            .unwrap()
            .replace("test release", "evil release"),
    )
    .unwrap();
    s.req(
        "PUT",
        "/api/admin/update/settings",
        Some(json!({"source_url": format!("{src_base}/v2/release-manifest.json")})),
    )
    .await;
    let (_, v) = s.req("POST", "/api/admin/update/check", None).await;
    assert!(
        v["last_check"]["error"]
            .as_str()
            .unwrap()
            .contains("signature verification failed"),
        "{v}"
    );
    std::fs::write(&m4, orig).unwrap();

    // ---- 4. new version fails its post-restart health check -> automatic rollback
    s.req("PUT", "/api/admin/update/settings", Some(json!({"source_url": format!("{src_base}/v5/release-manifest.json"), "notify_webhook": format!("{src_base}/hook")}))).await;
    let (st, v) = s
        .req("POST", "/api/admin/update/apply", Some(json!({})))
        .await;
    assert_eq!(st, 202, "{v}");
    let v = s.wait_state(&["rolled_back", "succeeded"], 90).await;
    assert_eq!(v["status"]["state"], "rolled_back", "{v}");
    assert!(
        v["status"]["error"]
            .as_str()
            .unwrap()
            .contains("health check failed"),
        "{v}"
    );
    assert_eq!(v["current_version"], "0.2.0");
    s.assert_alive();
    assert!(s.exe().contains("0.2.0") && !s.exe().contains("unhealthy"));
    assert_eq!(
        std::fs::read_to_string(install.join("web/index.html")).unwrap(),
        "<html>0.2.0</html>",
        "web bundle restored"
    );
    assert_eq!(s.version().await.unwrap()["server_version"], "0.2.0");
    // data written before the update survives the database restore
    let (st, _) = s.req("GET", "/api/admin/users", None).await;
    assert_eq!(st, 200);

    // ---- 5. database migration failure on boot -> automatic rollback
    s.req("PUT", "/api/admin/update/settings", Some(json!({"source_url": format!("{src_base}/v6/release-manifest.json"), "notify_webhook": format!("{src_base}/hook")}))).await;
    let (st, v) = s
        .req("POST", "/api/admin/update/apply", Some(json!({})))
        .await;
    assert_eq!(st, 202, "{v}");
    let v = s.wait_state(&["rolled_back", "succeeded"], 90).await;
    assert_eq!(v["status"]["state"], "rolled_back", "{v}");
    assert!(
        v["status"]["error"]
            .as_str()
            .unwrap()
            .contains("migration failed"),
        "{v}"
    );
    assert_eq!(s.version().await.unwrap()["server_version"], "0.2.0");
    s.assert_alive();

    // ---- audit trail + notifications
    let acts = s.audit_actions().await;
    for a in [
        "update_check",
        "update_apply",
        "update_install",
        "update_applied",
        "update_failed",
        "update_health_failed",
        "update_rolled_back",
        "update_settings",
    ] {
        assert!(acts.iter().any(|x| x == a), "audit lacks {a}: {acts:?}");
    }
    let (_, chain) = s.req("GET", "/api/admin/audit/verify", None).await;
    assert_eq!(chain["ok"], true, "{chain}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let msgs: Vec<String> = hooks
        .lock()
        .unwrap()
        .iter()
        .map(|h| h["message"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(
        msgs.iter().any(|m| m.contains("updated 0.1.0 -> 0.2.0")),
        "{msgs:?}"
    );
    assert!(msgs.iter().any(|m| m.contains("rolled back")), "{msgs:?}");

    // ---- locally hosted APK wins over the manifest
    std::fs::create_dir_all(s.data.join("clients/android")).unwrap();
    std::fs::write(s.data.join("clients/android/drivehub-0.2.0.apk"), b"PK-apk").unwrap();
    let a: Value = s
        .http
        .get(format!("{}/api/client/android/latest", s.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        (a["source"].as_str(), a["version"].as_str()),
        (Some("local"), Some("0.2.0"))
    );
    assert_eq!(a["sha256"], sha(b"PK-apk"));
    let body = s
        .http
        .get(format!("{}/api/client/android/download", s.base))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&body[..], b"PK-apk");
}

#[tokio::test]
async fn checks_can_be_disabled() {
    let db = drivehub_api::connect("sqlite::memory:").await.unwrap();
    let st = drivehub_api::AppState::new(db, None).await.unwrap();
    let mut cfg = st.updater.config();
    cfg.check = false;
    st.updater.set_config(cfg);
    let e = st
        .updater
        .check(&drivehub_api::update::Actor::system())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("disabled"));
    let e = st
        .updater
        .start(drivehub_api::update::Actor::system(), true)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("disabled"));
    assert!(!st.updater.version_info().update_available);
}
