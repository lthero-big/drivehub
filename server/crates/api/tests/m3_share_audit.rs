//! M3 integration tests (DEPTAI-474 sharing / DEPTAI-475 audit): visit / download / day
//! limits, PIN links (`?pin=`, `/s/<code>-<pin>`, pickup code), signed direct links + Range,
//! PIN brute-force protection, upload shares, owner management, audit coverage of every
//! entry point (Web API / WebDAV / share / auth / admin), hash-chain tamper detection,
//! retention, CSV/JSON export, alert rules (log / webhook / e-mail), dashboard.
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use drivehub_api::auth::LogMailer;
use drivehub_api::{connect, router, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

struct T {
    app: axum::Router,
    st: AppState,
    outbox: Arc<LogMailer>,
    _dir: tempfile::TempDir,
    admin: String,
}

struct Resp {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}
impl Resp {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }
}

fn b64(s: &str) -> String {
    data_encoding::BASE64.encode(s.as_bytes())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

impl T {
    async fn new() -> T {
        let db = connect("sqlite::memory:").await.unwrap();
        let st = AppState::new(db, None).await.unwrap();
        let outbox = Arc::new(LogMailer::default());
        st.auth.set_mailer(outbox.clone());
        let dir = tempfile::tempdir().unwrap();
        let app = router(st.clone(), None);
        let mut t = T {
            app,
            st,
            outbox,
            _dir: dir,
            admin: String::new(),
        };
        let root = t._dir.path().display().to_string();
        let r = t
            .call(
                "POST",
                "/api/mounts",
                None,
                Some(json!({"name": "local", "kind": "fs", "options": {"root": root}})),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
        for (p, c) in [
            ("pub/a.txt", "alpha"),
            ("pub/big.bin", "0123456789abcdef"),
            ("docs/x.md", "# x"),
            ("docs/sub/y.txt", "yankee"),
            ("inbox/.keep", ""),
        ] {
            let r = t
                .raw(
                    Request::put(format!("/api/fs/upload?path=/local/{p}"))
                        .body(Body::from(c))
                        .unwrap(),
                )
                .await;
            assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        }
        let r = t
            .call("POST", "/api/auth/init", None, Some(json!({"username": "admin", "email": "admin@example.com", "password": "admin-pass-1"})))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        t.admin = r.json()["access_token"].as_str().unwrap().to_string();
        t
    }

    async fn raw(&self, r: Request<Body>) -> Resp {
        let res = self.app.clone().oneshot(r).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Resp {
            status,
            headers,
            body,
        }
    }

    async fn req(
        &self,
        method: &str,
        uri: &str,
        tok: Option<&str>,
        body: Option<Value>,
        extra: &[(&str, &str)],
    ) -> Resp {
        let mut b = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(t) = tok {
            b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        self.raw(
            b.body(
                body.map(|v| Body::from(v.to_string()))
                    .unwrap_or_else(Body::empty),
            )
            .unwrap(),
        )
        .await
    }

    async fn call(&self, method: &str, uri: &str, tok: Option<&str>, body: Option<Value>) -> Resp {
        self.req(method, uri, tok, body, &[]).await
    }

    /// Anonymous request from a given client IP.
    async fn anon(&self, uri: &str, ip: &str, extra: &[(&str, &str)]) -> Resp {
        let mut h = vec![("x-forwarded-for", ip)];
        h.extend_from_slice(extra);
        self.req("GET", uri, None, None, &h).await
    }

    async fn adm(&self, method: &str, uri: &str, body: Option<Value>) -> Resp {
        let r = self
            .call(method, uri, Some(&self.admin.clone()), body)
            .await;
        assert!(
            r.status.is_success(),
            "{method} {uri}: {} {}",
            r.status,
            r.text()
        );
        r
    }

    async fn login_from(&self, ip: &str) -> Resp {
        self.req(
            "POST",
            "/api/auth/login",
            None,
            Some(json!({"login": "admin", "password": "admin-pass-1"})),
            &[("x-forwarded-for", ip)],
        )
        .await
    }

    async fn share(&self, body: Value) -> Value {
        self.adm("POST", "/api/shares", Some(body)).await.json()
    }

    async fn audit(&self, q: &str) -> Vec<Value> {
        self.adm("GET", &format!("/api/admin/audit?limit=1000&{q}"), None)
            .await
            .json()
            .as_array()
            .unwrap()
            .clone()
    }
}

fn code(s: &Value) -> String {
    s["code"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn share_visit_download_and_day_limits_expire() {
    let t = T::new().await;
    // visit limit
    let s = t
        .share(json!({"paths": ["/local/pub"], "max_visits": 2}))
        .await;
    let c = code(&s);
    assert_eq!(s["status"], "active");
    for _ in 0..2 {
        assert_eq!(
            t.anon(&format!("/api/s/{c}"), "1.0.0.1", &[]).await.status,
            StatusCode::OK
        );
    }
    let r = t.anon(&format!("/api/s/{c}"), "1.0.0.1", &[]).await;
    assert_eq!(r.status, StatusCode::GONE, "{}", r.text());
    let st = t
        .adm("GET", &format!("/api/shares/{}", s["id"]), None)
        .await
        .json();
    assert_eq!(st["status"], "exhausted");
    assert_eq!(st["visits"], 2);

    // download limit (Range continuation does not count)
    let s = t
        .share(json!({"paths": ["/local/pub/big.bin"], "max_downloads": 2}))
        .await;
    let c = code(&s);
    let o = t.anon(&format!("/api/s/{c}"), "1.0.0.2", &[]).await.json();
    let tok = o["token"].as_str().unwrap().to_string();
    assert_eq!(o["downloads_left"], 2);
    let dl = format!("/api/s/{c}/download?path=/big.bin&t={tok}");
    let r = t.anon(&dl, "1.0.0.2", &[]).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body, b"0123456789abcdef");
    assert!(r.headers[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .starts_with("attachment"));
    let r = t.anon(&dl, "1.0.0.2", &[("range", "bytes=4-")]).await;
    assert_eq!(r.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.body, b"456789abcdef");
    assert_eq!(t.anon(&dl, "1.0.0.2", &[]).await.status, StatusCode::OK);
    let r = t.anon(&dl, "1.0.0.2", &[]).await;
    assert_eq!(r.status, StatusCode::GONE, "{}", r.text());
    // whole share is dead now: open, direct link
    assert_eq!(
        t.anon(&format!("/api/s/{c}"), "1.0.0.2", &[]).await.status,
        StatusCode::GONE
    );

    // day limit
    let s = t.share(json!({"paths": ["/local/docs"], "days": 1})).await;
    let c = code(&s);
    let exp = s["expires_at"].as_i64().unwrap();
    assert!((exp - (now() + 86400)).abs() < 5, "{exp}");
    let o = t.anon(&format!("/api/s/{c}"), "1.0.0.3", &[]).await;
    assert_eq!(o.status, StatusCode::OK);
    let tok = o.json()["token"].as_str().unwrap().to_string();
    // a day passes
    sqlx::query("UPDATE shares SET expires_at = ? WHERE id = ?")
        .bind(now() - 1)
        .bind(s["id"].as_i64())
        .execute(&t.st.db)
        .await
        .unwrap();
    assert_eq!(
        t.anon(&format!("/api/s/{c}"), "1.0.0.3", &[]).await.status,
        StatusCode::GONE
    );
    assert_eq!(
        t.anon(
            &format!("/api/s/{c}/list?path=/docs&t={tok}"),
            "1.0.0.3",
            &[]
        )
        .await
        .status,
        StatusCode::GONE
    );
    let st = t
        .adm("GET", &format!("/api/shares/{}", s["id"]), None)
        .await
        .json();
    assert_eq!(st["status"], "expired");
    // owner extends it again → works
    t.adm(
        "PATCH",
        &format!("/api/shares/{}", s["id"]),
        Some(json!({"days": 3})),
    )
    .await;
    assert_eq!(
        t.anon(&format!("/api/s/{c}"), "1.0.0.3", &[]).await.status,
        StatusCode::OK
    );
    // expires_in_secs (short expiry)
    let s = t
        .share(json!({"paths": ["/local/pub/a.txt"], "expires_in_secs": 1}))
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
    assert_eq!(
        t.anon(&format!("/api/s/{}", code(&s)), "1.0.0.4", &[])
            .await
            .status,
        StatusCode::GONE
    );
    // manual revoke
    let s = t.share(json!({"paths": ["/local/pub/a.txt"]})).await;
    assert_eq!(
        t.anon(&format!("/api/s/{}", code(&s)), "1.0.0.4", &[])
            .await
            .status,
        StatusCode::OK
    );
    let r = t
        .adm("POST", &format!("/api/shares/{}/revoke", s["id"]), None)
        .await
        .json();
    assert_eq!(r["status"], "revoked");
    assert_eq!(
        t.anon(&format!("/api/s/{}", code(&s)), "1.0.0.4", &[])
            .await
            .status,
        StatusCode::GONE
    );
    // unknown code
    assert_eq!(
        t.anon("/api/s/nope1234", "1.0.0.5", &[]).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn pin_links_claim_in_one_click() {
    let t = T::new().await;
    let s = t
        .share(json!({"paths": ["/local/docs"], "pin": "4321"}))
        .await;
    let c = code(&s);
    assert_eq!(s["pickup_code"], format!("{c}-4321"));
    assert!(s["url_with_pin"]
        .as_str()
        .unwrap()
        .ends_with(&format!("/s/{c}-4321")));
    // without pin
    let r = t.anon(&format!("/api/s/{c}"), "2.0.0.1", &[]).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json()["need_pin"], true);
    // wrong pin
    let r = t
        .anon(&format!("/api/s/{c}?pin=0000"), "2.0.0.1", &[])
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json()["error"], "wrong pin");
    // one-click links
    for uri in [
        format!("/api/s/{c}?pin=4321"),
        format!("/api/s/{c}-4321"),
        format!("/s/{c}-4321"),
        format!("/s/{c}?pin=4321"),
    ] {
        let r = t.anon(&uri, "2.0.0.2", &[]).await;
        assert_eq!(r.status, StatusCode::OK, "{uri}: {}", r.text());
        let v = r.json();
        assert_eq!(v["name"], "docs");
        assert!(v["token"].is_string());
    }
    // pickup code from the home page
    for code_in in [
        format!("{c}-4321"),
        format!("{c} 4321"),
        format!("https://x.example/s/{c}-4321"),
    ] {
        let r = t
            .req(
                "POST",
                "/api/s/claim",
                None,
                Some(json!({"code": code_in})),
                &[("x-forwarded-for", "2.0.0.3")],
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{code_in}: {}", r.text());
    }
    let r = t
        .req(
            "POST",
            "/api/s/claim",
            None,
            Some(json!({"code": c, "pin": "4321"})),
            &[("x-forwarded-for", "2.0.0.3")],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let tok = r.json()["token"].as_str().unwrap().to_string();
    // browse + download with the visitor token
    let l = t
        .anon(
            &format!("/api/s/{c}/list?path=/docs&t={tok}"),
            "2.0.0.3",
            &[],
        )
        .await
        .json();
    let names: Vec<&str> = l["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"x.md") && names.contains(&"sub"),
        "{names:?}"
    );
    let r = t
        .anon(
            &format!("/api/s/{c}/download?path=/docs/sub/y.txt&t={tok}"),
            "2.0.0.3",
            &[],
        )
        .await;
    assert_eq!(r.body, b"yankee");
    // no token / forged token / path escape
    assert_eq!(
        t.anon(
            &format!("/api/s/{c}/download?path=/docs/x.md"),
            "2.0.0.3",
            &[]
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.anon(
            &format!("/api/s/{c}/download?path=/docs/x.md&t={tok}x"),
            "2.0.0.3",
            &[]
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_ne!(
        t.anon(
            &format!("/api/s/{c}/download?path=/docs/../pub/a.txt&t={tok}"),
            "2.0.0.3",
            &[]
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(
        t.anon(
            &format!("/api/s/{c}/download?path=/pub/a.txt&t={tok}"),
            "2.0.0.3",
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    // random pin + require login
    let s = t
        .share(json!({"paths": ["/local/pub/a.txt"], "random_pin": true, "require_login": true}))
        .await;
    let pin = s["pin"].as_str().unwrap().to_string();
    assert_eq!(pin.len(), 4);
    let r = t
        .anon(&format!("/api/s/{}-{pin}", code(&s)), "2.0.0.4", &[])
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json()["need_login"], true);
    let r = t
        .call(
            "GET",
            &format!("/api/s/{}-{pin}", code(&s)),
            Some(&t.admin),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn direct_links_are_signed_and_support_range() {
    let t = T::new().await;
    let s = t.share(json!({"paths": ["/local/pub/big.bin"]})).await;
    let url = s["direct_url"].as_str().unwrap().to_string();
    assert!(url.starts_with("/d/") && url.ends_with("/big.bin"), "{url}");
    let r = t.anon(&url, "3.0.0.1", &[]).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body, b"0123456789abcdef");
    assert_eq!(r.headers[header::ACCEPT_RANGES], "bytes");
    let r = t.anon(&url, "3.0.0.1", &[("range", "bytes=2-5")]).await;
    assert_eq!(r.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.body, b"2345");
    assert_eq!(r.headers[header::CONTENT_RANGE], "bytes 2-5/16");
    let r = t.anon(&url, "3.0.0.1", &[("range", "bytes=100-")]).await;
    assert_eq!(r.status, StatusCode::RANGE_NOT_SATISFIABLE);
    // tampered signature / payload / file name
    let (head, name) = url.rsplit_once('/').unwrap();
    let mut bad = head.to_string();
    let last = bad.pop().unwrap();
    bad.push(if last == 'A' { 'B' } else { 'A' });
    assert_eq!(
        t.anon(&format!("{bad}/{name}"), "3.0.0.1", &[])
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        t.anon(&format!("{head}/other.bin"), "3.0.0.1", &[])
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let tok = head.trim_start_matches("/d/");
    let (p, sig) = tok.split_once('.').unwrap();
    let mut payload: Value =
        serde_json::from_slice(&data_encoding::BASE64URL_NOPAD.decode(p.as_bytes()).unwrap())
            .unwrap();
    payload["p"] = json!("big.bin/../../secret");
    let forged = data_encoding::BASE64URL_NOPAD.encode(payload.to_string().as_bytes());
    assert_eq!(
        t.anon(&format!("/d/{forged}.{sig}/big.bin"), "3.0.0.1", &[])
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    // downloads counted (2 full: first GET and Range 2-5 is a continuation? no: start>0 is not counted)
    let st = t
        .adm("GET", &format!("/api/shares/{}", s["id"]), None)
        .await
        .json();
    assert_eq!(st["downloads"], 1, "{st}");
    // visitor-requested direct link for a file inside a folder share
    let s2 = t.share(json!({"paths": ["/local/docs"]})).await;
    let o = t
        .anon(&format!("/api/s/{}", code(&s2)), "3.0.0.2", &[])
        .await
        .json();
    let tok = o["token"].as_str().unwrap();
    let d = t
        .anon(
            &format!("/api/s/{}/direct?path=/docs/sub/y.txt&t={tok}", code(&s2)),
            "3.0.0.2",
            &[],
        )
        .await
        .json();
    let r = t.anon(d["path"].as_str().unwrap(), "3.0.0.9", &[]).await;
    assert_eq!(r.body, b"yankee");
    // revoking kills direct links
    t.adm("POST", &format!("/api/shares/{}/revoke", s["id"]), None)
        .await;
    assert_eq!(t.anon(&url, "3.0.0.1", &[]).await.status, StatusCode::GONE);
    // preview-only: inline ok, download / direct refused
    let s3 = t
        .share(json!({"paths": ["/local/pub/a.txt"], "perm": "preview"}))
        .await;
    assert!(s3["direct_url"].is_null());
    let o = t
        .anon(&format!("/api/s/{}", code(&s3)), "3.0.0.3", &[])
        .await
        .json();
    let tok = o["token"].as_str().unwrap();
    let base = format!("/api/s/{}", code(&s3));
    assert_eq!(
        t.anon(
            &format!("{base}/download?path=/a.txt&t={tok}"),
            "3.0.0.3",
            &[]
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    let r = t
        .anon(
            &format!("{base}/download?path=/a.txt&inline=true&t={tok}"),
            "3.0.0.3",
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.headers[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .starts_with("inline"));
    assert_eq!(
        t.anon(
            &format!("{base}/direct?path=/a.txt&t={tok}"),
            "3.0.0.3",
            &[]
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn pin_bruteforce_needs_captcha_then_rate_limits() {
    let t = T::new().await;
    let s = t
        .share(json!({"paths": ["/local/pub"], "pin": "7777"}))
        .await;
    let c = code(&s);
    let ip = "4.0.0.1";
    for i in 0..3 {
        let r = t
            .anon(&format!("/api/s/{c}?pin={i}{i}{i}{i}"), ip, &[])
            .await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
        assert_eq!(r.json()["need_captcha"], i >= 2, "{i}");
    }
    // correct pin but no captcha → refused
    let r = t.anon(&format!("/api/s/{c}?pin=7777"), ip, &[]).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json()["need_captcha"], true);
    // wrong captcha → refused
    let cap = t.anon("/api/s/captcha", ip, &[]).await.json();
    assert!(cap["svg"].as_str().unwrap().starts_with("<svg"));
    let id = cap["id"].as_str().unwrap();
    let r = t
        .anon(
            &format!("/api/s/{c}?pin=7777&captcha_id={id}&captcha=999"),
            ip,
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // captcha is single-use; a fresh one with the right answer works
    let cap = t.anon("/api/s/captcha", ip, &[]).await.json();
    let id = cap["id"].as_str().unwrap();
    let ans = t.st.share_guard.peek_captcha(id).unwrap();
    let r = t
        .anon(
            &format!("/api/s/{c}?pin=7777&captcha_id={id}&captcha={ans}"),
            ip,
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // another IP is not affected
    assert_eq!(
        t.anon(&format!("/api/s/{c}-7777"), "4.0.0.2", &[])
            .await
            .status,
        StatusCode::OK
    );
    // code enumeration from one IP → 429 (even for valid code + pin)
    let ip = "4.0.0.3";
    for i in 0..10 {
        assert_eq!(
            t.anon(&format!("/api/s/zz{i}zzzzz"), ip, &[]).await.status,
            StatusCode::NOT_FOUND
        );
    }
    let r = t.anon(&format!("/api/s/{c}-7777"), ip, &[]).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // failures are audited
    let a = t.audit("action=share_pin_fail").await;
    assert_eq!(a.len(), 3);
    assert!(a
        .iter()
        .all(|e| e["allowed"] == false && e["share_id"] == s["id"] && e["ip"] == "4.0.0.1"));
}

#[tokio::test]
async fn upload_share_collects_files() {
    let t = T::new().await;
    let s = t
        .share(json!({"paths": ["/local/inbox"], "perm": "upload", "pin": "abc1"}))
        .await;
    let c = code(&s);
    let tok = t
        .anon(&format!("/api/s/{c}-abc1"), "5.0.0.1", &[])
        .await
        .json()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let up = |p: &str| {
        Request::put(format!("/api/s/{c}/upload?path={p}&t={tok}"))
            .header("x-forwarded-for", "5.0.0.1")
            .body(Body::from("homework"))
            .unwrap()
    };
    let r = t.raw(up("hw.txt")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        std::fs::read_to_string(t._dir.path().join("inbox/hw.txt")).unwrap(),
        "homework"
    );
    assert_eq!(
        t.raw(up("/inbox/hw.txt")).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(t.raw(up("/inbox/hw2.txt")).await.status, StatusCode::OK);
    let st = t
        .adm("GET", &format!("/api/shares/{}", s["id"]), None)
        .await
        .json();
    assert_eq!(st["uploads"], 2);
    // upload needs a single folder; download shares refuse uploads
    let r = t
        .call(
            "POST",
            "/api/shares",
            Some(&t.admin),
            Some(json!({"paths": ["/local/pub/a.txt"], "perm": "upload"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let s2 = t.share(json!({"paths": ["/local/docs"]})).await;
    let tok2 = t
        .anon(&format!("/api/s/{}", code(&s2)), "5.0.0.1", &[])
        .await
        .json()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let r = t
        .raw(
            Request::put(format!(
                "/api/s/{}/upload?path=/docs/z.txt&t={tok2}",
                code(&s2)
            ))
            .body(Body::from("z"))
            .unwrap(),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn share_management_permissions_and_stats() {
    let t = T::new().await;
    // a normal user without the share bit cannot share
    t.adm(
        "POST",
        "/api/admin/users",
        Some(json!({"username": "bob", "password": "bob-pass-12"})),
    )
    .await;
    let bob = t
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(json!({"login": "bob", "password": "bob-pass-12"})),
        )
        .await
        .json()["access_token"]
        .as_str()
        .unwrap()
        .to_string();
    let r = t
        .call(
            "POST",
            "/api/shares",
            Some(&bob),
            Some(json!({"paths": ["/local/pub/a.txt"]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    t.adm("POST", "/api/acl/rules", Some(json!({"path": "/local/pub", "subject": "logged_in", "allow": ["read", "download", "share"]})))
        .await;
    let r = t
        .call(
            "POST",
            "/api/shares",
            Some(&bob),
            Some(json!({"paths": ["/local/pub/a.txt"], "max_visits": 5})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let bs = r.json();
    assert_eq!(bs["owner"], "bob");
    assert_eq!(
        t.call(
            "POST",
            "/api/shares",
            Some(&bob),
            Some(json!({"paths": ["/local/docs"]}))
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    // admin share is invisible to bob
    let a = t
        .share(json!({"paths": ["/local/docs"], "name": "Docs"}))
        .await;
    assert_eq!(a["name"], "Docs");
    let mine = t.call("GET", "/api/shares", Some(&bob), None).await.json();
    assert_eq!(mine.as_array().unwrap().len(), 1);
    assert_eq!(
        t.call("GET", &format!("/api/shares/{}", a["id"]), Some(&bob), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.call(
            "POST",
            &format!("/api/shares/{}/revoke", a["id"]),
            Some(&bob),
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let all = t.adm("GET", "/api/shares?all=true", None).await.json();
    assert_eq!(all.as_array().unwrap().len(), 2);
    // patch limits / pin
    let p = t
        .call(
            "PATCH",
            &format!("/api/shares/{}", bs["id"]),
            Some(&bob),
            Some(json!({"max_visits": null, "pin": "9999", "max_downloads": 3})),
        )
        .await
        .json();
    assert!(p["max_visits"].is_null());
    assert_eq!(p["max_downloads"], 3);
    assert_eq!(p["has_pin"], true);
    let c = code(&bs);
    assert_eq!(
        t.anon(&format!("/api/s/{c}"), "6.0.0.1", &[]).await.status,
        StatusCode::UNAUTHORIZED
    );
    let o = t
        .anon(&format!("/api/s/{c}-9999"), "6.0.0.1", &[])
        .await
        .json();
    t.anon(
        &format!(
            "/api/s/{c}/download?path=/a.txt&t={}",
            o["token"].as_str().unwrap()
        ),
        "6.0.0.1",
        &[],
    )
    .await;
    t.anon(&format!("/api/s/{c}-9999"), "6.0.0.2", &[]).await;
    // stats
    let st = t
        .call(
            "GET",
            &format!("/api/shares/{}", bs["id"]),
            Some(&bob),
            None,
        )
        .await
        .json();
    assert_eq!(st["visits"], 2);
    assert_eq!(st["downloads"], 1);
    assert_eq!(st["stats"]["unique_ips"], 2);
    let acts: Vec<String> = st["stats"]["by_action"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["action"].as_str().unwrap().to_string())
        .collect();
    for want in [
        "share_create",
        "share_update",
        "share_visit",
        "share_download",
    ] {
        assert!(acts.contains(&want.to_string()), "{want} in {acts:?}");
    }
    // delete
    t.call(
        "DELETE",
        &format!("/api/shares/{}", bs["id"]),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(
        t.anon(&format!("/api/s/{c}-9999"), "6.0.0.1", &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

/// Every entry point (Web API, WebDAV, share, auth, admin) shows up in the audit with
/// client type, IP, UA, bytes and share id, and can be filtered.
#[tokio::test]
async fn every_entry_point_is_audited_and_searchable() {
    let t = T::new().await;
    let web = [
        ("x-drivehub-client", "web/0.1.0"),
        ("user-agent", "Mozilla/5.0 test-browser"),
        ("x-forwarded-for", "7.0.0.1"),
    ];
    let tk = t.admin.clone();
    let a = Some(tk.as_str());
    assert_eq!(
        t.req("GET", "/api/fs/list?path=/local/pub", a, None, &web)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        t.req(
            "GET",
            "/api/fs/download?path=/local/pub/big.bin",
            a,
            None,
            &web
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(
        t.req(
            "GET",
            "/api/fs/download?path=/local/pub/a.txt&preview=true",
            a,
            None,
            &web
        )
        .await
        .status,
        StatusCode::OK
    );
    let mut up = Request::put("/api/fs/upload?path=/local/pub/new.txt")
        .header(header::AUTHORIZATION, format!("Bearer {tk}"));
    for (k, v) in web {
        up = up.header(k, v);
    }
    assert_eq!(
        t.raw(up.body(Body::from("12345")).unwrap()).await.status,
        StatusCode::OK
    );
    t.req(
        "POST",
        "/api/fs/rename",
        a,
        Some(json!({"path": "/local/pub/new.txt", "new_name": "new2.txt"})),
        &web,
    )
    .await;
    t.req(
        "POST",
        "/api/fs/move",
        a,
        Some(json!({"src": "/local/pub/new2.txt", "dst": "/local/docs/new2.txt"})),
        &web,
    )
    .await;
    t.req(
        "POST",
        "/api/fs/delete",
        a,
        Some(json!({"path": "/local/docs/new2.txt"})),
        &web,
    )
    .await;
    // Android app
    t.req(
        "GET",
        "/api/fs/list?path=/local/docs",
        a,
        None,
        &[
            ("x-drivehub-client", "app/0.1.0"),
            ("x-forwarded-for", "7.0.0.2"),
        ],
    )
    .await;
    // WebDAV
    let basic = format!("Basic {}", b64("admin:admin-pass-1"));
    let dav = |m: &str, p: &str, body: &str| {
        Request::builder()
            .method(m)
            .uri(p)
            .header(header::AUTHORIZATION, basic.clone())
            .header("x-forwarded-for", "7.0.0.3")
            .header("user-agent", "davfs2/1.6")
            .header("depth", if m == "PROPFIND" { "1" } else { "infinity" })
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    assert!(t
        .raw(dav("PROPFIND", "/dav/local/pub", ""))
        .await
        .status
        .is_success());
    assert_eq!(
        t.raw(dav("GET", "/dav/local/pub/a.txt", "")).await.status,
        StatusCode::OK
    );
    assert!(t
        .raw(dav("PUT", "/dav/local/pub/dav.txt", "via-dav"))
        .await
        .status
        .is_success());
    assert!(t
        .raw(dav("DELETE", "/dav/local/pub/dav.txt", ""))
        .await
        .status
        .is_success());
    // share
    let s = t.share(json!({"paths": ["/local/pub/big.bin"]})).await;
    t.anon(
        s["direct_url"].as_str().unwrap(),
        "7.0.0.4",
        &[("user-agent", "curl/8")],
    )
    .await;
    // auth: failed + successful login; admin: mount change, ACL
    t.req(
        "POST",
        "/api/auth/login",
        None,
        Some(json!({"login": "admin", "password": "nope-nope"})),
        &[("x-forwarded-for", "7.0.0.5")],
    )
    .await;
    t.req(
        "POST",
        "/api/auth/login",
        None,
        Some(json!({"login": "admin", "password": "admin-pass-1"})),
        &[
            ("x-forwarded-for", "7.0.0.5"),
            ("user-agent", "Mozilla/5.0 x"),
        ],
    )
    .await;
    let root = t._dir.path().join("pub").display().to_string();
    t.adm(
        "POST",
        "/api/mounts",
        Some(json!({"name": "pubm", "kind": "fs", "options": {"root": root}})),
    )
    .await;
    t.adm(
        "POST",
        "/api/acl/rules",
        Some(json!({"path": "/local/docs", "subject": "anonymous", "allow": ["read"]})),
    )
    .await;

    let webev = t.audit("client=web&channel=api").await;
    let acts: Vec<&str> = webev
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    for want in [
        "list", "download", "preview", "upload", "rename", "move", "delete",
    ] {
        assert!(acts.contains(&want), "web {want} in {acts:?}");
    }
    let dl = webev.iter().find(|e| e["action"] == "download").unwrap();
    assert_eq!(dl["bytes"], 16);
    assert_eq!(dl["ip"], "7.0.0.1");
    assert_eq!(dl["ua"], "Mozilla/5.0 test-browser");
    assert_eq!(dl["storage"], "local");
    assert_eq!(dl["path"], "/local/pub/big.bin");
    assert_eq!(dl["username"], "admin");
    assert!(dl["time"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        webev.iter().find(|e| e["action"] == "upload").unwrap()["bytes"],
        5
    );
    assert!(!t.audit("client=android&action=list").await.is_empty());
    let davev = t.audit("client=webdav").await;
    let acts: Vec<&str> = davev
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    for want in ["list", "download", "upload", "delete"] {
        assert!(acts.contains(&want), "dav {want} in {acts:?}");
    }
    assert!(davev
        .iter()
        .all(|e| e["channel"] == "webdav" && e["ip"] == "7.0.0.3" && e["ua"] == "davfs2/1.6"));
    let sh = t.audit(&format!("share_id={}", s["id"])).await;
    let acts: Vec<&str> = sh.iter().map(|e| e["action"].as_str().unwrap()).collect();
    assert!(
        acts.contains(&"share_create") && acts.contains(&"share_direct"),
        "{acts:?}"
    );
    let d = sh.iter().find(|e| e["action"] == "share_direct").unwrap();
    assert_eq!(d["username"], "anonymous");
    assert_eq!(d["ip"], "7.0.0.4");
    assert_eq!(d["bytes"], 16);
    let logins = t.audit("action=login&ip=7.0.0.5").await;
    assert_eq!(logins.len(), 2);
    assert!(
        logins.iter().any(|e| e["allowed"] == false)
            && logins
                .iter()
                .any(|e| e["allowed"] == true && e["client"] == "web")
    );
    assert!(!t
        .audit("channel=admin&action=mount_save&path=/pubm")
        .await
        .is_empty());
    assert!(!t.audit("action=acl_rule_add").await.is_empty());
    // combined filters: path prefix + user + time window + text
    let f = t
        .audit(&format!(
            "path=/local/pub&user=admin&from={}&to={}",
            now() - 60,
            now() + 60
        ))
        .await;
    assert!(f
        .iter()
        .all(|e| e["path"].as_str().unwrap().starts_with("/local/pub")));
    assert!(f.len() >= 5);
    assert!(t.audit(&format!("from={}", now() + 3600)).await.is_empty());
    assert!(!t.audit("q=davfs2").await.is_empty());
    // denied only
    assert!(t
        .audit("denied=true")
        .await
        .iter()
        .all(|e| e["allowed"] == false));
    // pagination
    let p1 = t
        .adm("GET", "/api/admin/audit?limit=3", None)
        .await
        .json()
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(p1.len(), 3);
    let p2 = t
        .adm(
            "GET",
            &format!("/api/admin/audit?limit=3&before_id={}", p1[2]["id"]),
            None,
        )
        .await
        .json();
    assert!(p2[0]["id"].as_i64().unwrap() < p1[2]["id"].as_i64().unwrap());
    // non-admins cannot read the audit log
    assert_eq!(
        t.call("GET", "/api/admin/audit", None, None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn hash_chain_detects_tampering() {
    let t = T::new().await;
    for i in 0..5 {
        t.adm("GET", &format!("/api/fs/list?path=/local/pub&x={i}"), None)
            .await;
    }
    let v = t.adm("GET", "/api/admin/audit/verify", None).await.json();
    assert_eq!(v["ok"], true, "{v}");
    assert!(v["checked"].as_i64().unwrap() >= 5);
    // append-only: UPDATE / DELETE rejected by triggers
    let rows = t.audit("action=list").await;
    let victim = rows[2]["id"].as_i64().unwrap();
    assert!(sqlx::query("UPDATE audit_log SET path = '/x' WHERE id = ?")
        .bind(victim)
        .execute(&t.st.db)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM audit_log WHERE id = ?")
        .bind(victim)
        .execute(&t.st.db)
        .await
        .is_err());
    // an attacker with raw DB access drops the trigger and edits a row → detected
    sqlx::query("DROP TRIGGER audit_no_update")
        .execute(&t.st.db)
        .await
        .unwrap();
    sqlx::query("UPDATE audit_log SET path = '/local/innocent' WHERE id = ?")
        .bind(victim)
        .execute(&t.st.db)
        .await
        .unwrap();
    let v = t.adm("GET", "/api/admin/audit/verify", None).await.json();
    assert_eq!(v["ok"], false);
    assert_eq!(v["first_bad_id"], victim);
    assert!(v["reason"].as_str().unwrap().contains("modified"), "{v}");
    // re-hashing the edited row is caught at the next link
    let t = T::new().await;
    for i in 0..5 {
        t.adm("GET", &format!("/api/fs/list?path=/local/pub&x={i}"), None)
            .await;
    }
    let rows = t.audit("action=list&order=asc").await;
    let victim = rows[1]["id"].as_i64().unwrap();
    sqlx::query("DROP TRIGGER audit_no_update")
        .execute(&t.st.db)
        .await
        .unwrap();
    sqlx::query("UPDATE audit_log SET detail = 'x', hash = 'forged' WHERE id = ?")
        .bind(victim)
        .execute(&t.st.db)
        .await
        .unwrap();
    let v = t.adm("GET", "/api/admin/audit/verify", None).await.json();
    assert_eq!(v["ok"], false);
    assert_eq!(v["first_bad_id"], victim);
    // deleting a row is detected as a gap
    let t = T::new().await;
    for i in 0..5 {
        t.adm("GET", &format!("/api/fs/list?path=/local/pub&x={i}"), None)
            .await;
    }
    let rows = t.audit("action=list").await;
    let victim = rows[2]["id"].as_i64().unwrap();
    sqlx::query("DROP TRIGGER audit_no_delete")
        .execute(&t.st.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM audit_log WHERE id = ?")
        .bind(victim)
        .execute(&t.st.db)
        .await
        .unwrap();
    let v = t.adm("GET", "/api/admin/audit/verify", None).await.json();
    assert_eq!(v["ok"], false);
    assert!(v["reason"].as_str().unwrap().contains("gap"), "{v}");
}

#[tokio::test]
async fn retention_purge_keeps_chain_valid() {
    let t = T::new().await;
    let p = drivehub_api::auth::Principal::anonymous(false, "8.0.0.1".into());
    for i in 0..4 {
        let mut e = drivehub_api::audit::AuditEvent::new(
            &p,
            "api",
            "old_event",
            "/local/pub",
            true,
            &format!("{i}"),
        );
        e.ts = now() - 40 * 86400;
        t.st.audit_ev(e);
    }
    t.adm("GET", "/api/fs/list?path=/local/pub", None).await;
    let pol = t
        .adm(
            "PUT",
            "/api/admin/audit/policy",
            Some(json!({"retention_days": 30})),
        )
        .await
        .json();
    assert_eq!(pol["retention_days"], 30);
    let r = t.adm("POST", "/api/admin/audit/purge", None).await.json();
    assert!(r["deleted"].as_i64().unwrap() >= 4, "{r}");
    assert!(t.audit("action=old_event").await.is_empty());
    let v = t.adm("GET", "/api/admin/audit/verify", None).await.json();
    assert_eq!(v["ok"], true, "{v}");
    assert!(v["anchor_id"].as_i64().unwrap() > 0);
    assert!(!t.audit("action=audit_purge").await.is_empty());
}

#[tokio::test]
async fn export_csv_and_json() {
    let t = T::new().await;
    let s = t.share(json!({"paths": ["/local/pub/a.txt"]})).await;
    t.anon(
        &format!("/api/s/{}", code(&s)),
        "9.0.0.1",
        &[("user-agent", "agent, with \"quotes\"")],
    )
    .await;
    t.adm("GET", "/api/fs/list?path=/local/pub", None).await;
    let r = t
        .adm("GET", "/api/admin/audit/export?format=csv", None)
        .await;
    assert!(r.headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/csv"));
    assert!(r.headers[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .contains(".csv"));
    let csv = r.text();
    let mut lines = csv.lines();
    assert!(lines
        .next()
        .unwrap()
        .trim_start_matches('\u{feff}')
        .starts_with("id,time,ts,user_id,username,ip,client,channel,action,path"));
    assert!(csv.contains(",share_visit,"));
    assert!(csv.contains("\"agent, with \"\"quotes\"\"\""), "{csv}");
    let n_csv = csv.lines().count() - 1;
    let j = t
        .adm("GET", "/api/admin/audit/export?format=json", None)
        .await;
    assert!(j.headers[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .contains(".json"));
    let arr = j.json();
    let arr = arr.as_array().unwrap();
    assert!(arr.len() >= n_csv); // json export happened later (csv export itself is audited)
    assert!(arr
        .windows(2)
        .all(|w| w[0]["id"].as_i64() < w[1]["id"].as_i64()));
    assert!(arr.iter().all(|e| e["hash"].as_str().unwrap().len() == 64));
    // filtered export
    let f = t
        .adm(
            "GET",
            &format!("/api/admin/audit/export?format=json&share_id={}", s["id"]),
            None,
        )
        .await
        .json();
    assert!(f
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["share_id"] == s["id"]));
    assert_eq!(f.as_array().unwrap().len(), 2);
}

async fn webhook_server() -> (String, Arc<Mutex<Vec<Value>>>) {
    let got: Arc<Mutex<Vec<Value>>> = Arc::default();
    let g = got.clone();
    let app = axum::Router::new().route(
        "/hook",
        axum::routing::post(move |axum::Json(v): axum::Json<Value>| {
            let g = g.clone();
            async move {
                g.lock().unwrap().push(v);
                "ok"
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (format!("http://{addr}/hook"), got)
}

async fn wait_for<F: Fn() -> bool>(f: F) -> bool {
    for _ in 0..100 {
        if f() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}

#[tokio::test]
async fn alert_rules_fire_to_log_webhook_and_email() {
    let t = T::new().await;
    let (url, got) = webhook_server().await;
    // validation
    let r = t
        .call(
            "POST",
            "/api/admin/alerts",
            Some(&t.admin),
            Some(json!({"name": "x", "kind": "burst", "threshold": 0, "actions": "download"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = t.call("POST", "/api/admin/alerts", Some(&t.admin), Some(json!({"name": "x", "kind": "burst", "threshold": 2, "actions": "delete", "sink": "webhook", "target": "ftp://x"}))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let dl = t
        .adm("POST", "/api/admin/alerts", Some(json!({"name": "mass download", "kind": "burst", "actions": "download,share_download,share_direct", "threshold": 3, "window_secs": 60})))
        .await
        .json();
    let del = t
        .adm("POST", "/api/admin/alerts", Some(json!({"name": "mass delete", "kind": "burst", "actions": "delete", "threshold": 2, "window_secs": 60, "sink": "webhook", "target": url})))
        .await
        .json();
    let geo = t
        .adm("POST", "/api/admin/alerts", Some(json!({"name": "new network login", "kind": "new_ip_login", "sink": "email", "target": "sec@example.com"})))
        .await
        .json();
    assert_eq!(
        t.adm("GET", "/api/admin/alerts", None)
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        3
    );
    // 4 downloads → one alert (cooldown)
    for _ in 0..4 {
        t.adm("GET", "/api/fs/download?path=/local/pub/a.txt", None)
            .await;
    }
    let ev = t
        .adm(
            "GET",
            &format!("/api/admin/alerts/events?rule_id={}", dl["id"]),
            None,
        )
        .await
        .json();
    assert_eq!(ev.as_array().unwrap().len(), 1, "{ev}");
    assert!(ev[0]["message"].as_str().unwrap().contains("admin"));
    assert_eq!(ev[0]["delivered"], true);
    // 2 deletes → webhook
    t.adm(
        "POST",
        "/api/fs/delete",
        Some(json!({"path": "/local/docs/x.md"})),
    )
    .await;
    t.adm(
        "POST",
        "/api/fs/delete",
        Some(json!({"path": "/local/docs/sub"})),
    )
    .await;
    assert!(
        wait_for(|| !got.lock().unwrap().is_empty()).await,
        "webhook not called"
    );
    let hook = got.lock().unwrap()[0].clone();
    assert_eq!(hook["alert"], "mass delete");
    assert_eq!(hook["user"], "admin");
    assert_eq!(hook["event"]["action"], "delete");
    let mut delivered = false;
    for _ in 0..40 {
        let ev = t
            .adm(
                "GET",
                &format!("/api/admin/alerts/events?rule_id={}", del["id"]),
                None,
            )
            .await
            .json();
        if ev[0]["delivered"] == true {
            delivered = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(delivered);
    // login from a new network → e-mail
    assert_eq!(t.login_from("10.1.0.1").await.status, StatusCode::OK); // init login was from "local"
    let before = t.outbox.outbox.lock().unwrap().len();
    assert_eq!(t.login_from("10.1.0.2").await.status, StatusCode::OK); // same /16 → no alert
    assert_eq!(t.login_from("203.0.113.9").await.status, StatusCode::OK); // new network
    let ev = t
        .adm(
            "GET",
            &format!("/api/admin/alerts/events?rule_id={}", geo["id"]),
            None,
        )
        .await
        .json();
    assert!(
        ev.as_array()
            .unwrap()
            .iter()
            .any(|e| e["ip"] == "203.0.113.9"),
        "{ev}"
    );
    assert!(
        !ev.as_array().unwrap().iter().any(|e| e["ip"] == "10.1.0.2"),
        "{ev}"
    );
    assert!(
        wait_for(|| t
            .outbox
            .outbox
            .lock()
            .unwrap()
            .iter()
            .skip(before)
            .any(|m| m.to == "sec@example.com" && m.body.contains("203.0.113.9")))
        .await,
        "no alert mail"
    );
    // test button + disable
    let r = t
        .adm(
            "POST",
            &format!("/api/admin/alerts/{}/test", del["id"]),
            None,
        )
        .await
        .json();
    assert!(r["event_id"].as_i64().unwrap() > 0);
    assert!(
        wait_for(|| got
            .lock()
            .unwrap()
            .iter()
            .any(|h| h["message"] == "test alert"))
        .await
    );
    t.adm("PUT", &format!("/api/admin/alerts/{}", dl["id"]), Some(json!({"name": "mass download", "kind": "burst", "actions": "download", "threshold": 1, "enabled": false}))).await;
    t.adm("GET", "/api/fs/download?path=/local/pub/a.txt", None)
        .await;
    let ev = t
        .adm(
            "GET",
            &format!("/api/admin/alerts/events?rule_id={}", dl["id"]),
            None,
        )
        .await
        .json();
    assert_eq!(ev.as_array().unwrap().len(), 1);
    t.adm("DELETE", &format!("/api/admin/alerts/{}", dl["id"]), None)
        .await;
    assert_eq!(
        t.adm("GET", "/api/admin/alerts", None)
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn dashboard_traffic_hot_files_shares_anomalies() {
    let t = T::new().await;
    for _ in 0..3 {
        t.adm("GET", "/api/fs/download?path=/local/pub/big.bin", None)
            .await;
    }
    t.adm("GET", "/api/fs/download?path=/local/pub/a.txt", None)
        .await;
    let s = t.share(json!({"paths": ["/local/pub/a.txt"]})).await;
    for i in 0..3 {
        t.anon(&format!("/api/s/{}", code(&s)), &format!("11.0.0.{i}"), &[])
            .await;
    }
    t.call("GET", "/api/fs/list?path=/local/pub", None, None)
        .await; // denied (anonymous)
    let d = t
        .adm("GET", "/api/admin/audit/dashboard?days=7", None)
        .await
        .json();
    assert_eq!(d["totals"]["download_bytes"], 16 * 3 + 5);
    assert!(d["totals"]["denied"].as_i64().unwrap() >= 1);
    assert_eq!(d["traffic"].as_array().unwrap().len(), 1);
    assert_eq!(d["hot_files"][0]["path"], "/local/pub/big.bin");
    assert_eq!(d["hot_files"][0]["count"], 3);
    assert_eq!(d["top_shares"][0]["id"], s["id"]);
    assert_eq!(d["top_shares"][0]["visits"], 3);
    assert!(!d["recent_denied"].as_array().unwrap().is_empty());
}
