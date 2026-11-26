//! M2 integration tests (DEPTAI-471/472/473): auth, registration toggle, rate limit, TOTP,
//! refresh/sessions/force logout, API tokens, app passwords, mail (log + fake SMTP),
//! mock OAuth (login, auto-link, explicit link), ACL deny + audit, quota, jail, gates,
//! and API vs WebDAV vs search permission consistency.
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use drivehub_api::auth::{totp_at, LogMailer, Mail, Mailer, OAuthProvider, SmtpConfig, SmtpMailer};
use drivehub_api::{connect, router, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;
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
        // setup mode: mount + files created before init
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
            ("team/b.txt", "bravo"),
            ("secret/c.txt", "charlie"),
            ("pub/big.bin", "0123456789abcdef"),
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
        let r = t.call("POST", "/api/auth/init", None, Some(json!({"username": "admin", "email": "admin@example.com", "password": "admin-pass-1"}))).await;
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

    async fn call(&self, method: &str, uri: &str, tok: Option<&str>, body: Option<Value>) -> Resp {
        let mut b = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(t) = tok {
            b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
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

    async fn login(&self, login: &str, pw: &str) -> Resp {
        self.call(
            "POST",
            "/api/auth/login",
            None,
            Some(json!({"login": login, "password": pw})),
        )
        .await
    }

    async fn user(&self, name: &str, role: &str) -> (i64, String) {
        let r = self.adm("POST", "/api/admin/users", Some(json!({"username": name, "email": format!("{name}@example.com"), "password": format!("{name}-pass-1"), "role": role}))).await;
        let id = r.json()["id"].as_i64().unwrap();
        let tok = self.login(name, &format!("{name}-pass-1")).await.json()["access_token"]
            .as_str()
            .unwrap()
            .to_string();
        (id, tok)
    }

    async fn dav(
        &self,
        method: &str,
        path: &str,
        basic: (&str, &str),
        body: Option<&str>,
        extra: &[(&str, &str)],
    ) -> Resp {
        let mut b = Request::builder().method(method).uri(path).header(
            header::AUTHORIZATION,
            format!("Basic {}", b64(&format!("{}:{}", basic.0, basic.1))),
        );
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        self.raw(
            b.body(
                body.map(|s| Body::from(s.to_string()))
                    .unwrap_or_else(Body::empty),
            )
            .unwrap(),
        )
        .await
    }
}

fn dav_names(xml: &str, base: &str) -> BTreeSet<String> {
    xml.split("<D:href>")
        .skip(1)
        .filter_map(|s| s.split("</D:href>").next())
        .map(|h| h.trim_end_matches('/').to_string())
        .filter(|h| h != base.trim_end_matches('/'))
        .filter_map(|h| h.rsplit('/').next().map(String::from))
        .collect()
}

#[tokio::test]
async fn init_once_status_and_anonymous_denied() {
    let t = T::new().await;
    let r = t
        .call(
            "POST",
            "/api/auth/init",
            None,
            Some(json!({"username": "x", "password": "xxxxxxxxxx"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let s = t.call("GET", "/api/auth/status", None, None).await.json();
    assert_eq!(s["initialized"], true);
    assert_eq!(s["open_registration"], false);
    assert_eq!(s["mail_transport"], "log");
    // anonymous after init: root listing empty, mount 401, admin APIs 401
    let r = t.call("GET", "/api/fs/list?path=/", None, None).await;
    assert_eq!(r.json()["total"], 0);
    assert_eq!(
        t.call("GET", "/api/fs/list?path=/local", None, None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.call("GET", "/api/mounts", None, None).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.call("GET", "/api/fs/list?path=/local", Some("garbage"), None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    // admin sees everything
    let r = t.adm("GET", "/api/fs/list?path=/local", None).await;
    assert_eq!(r.json()["total"], 3);
    let me = t.adm("GET", "/api/auth/me", None).await.json();
    assert_eq!(me["role"], "admin");
}

#[tokio::test]
async fn registration_toggle_and_roles() {
    let t = T::new().await;
    let reg = json!({"email": "eve@example.com", "password": "eve-pass-123"});
    let r = t
        .call("POST", "/api/auth/register", None, Some(reg.clone()))
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    t.adm(
        "PUT",
        "/api/admin/settings",
        Some(json!({"open_registration": true})),
    )
    .await;
    let r = t
        .call("POST", "/api/auth/register", None, Some(reg.clone()))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let tok = r.json()["tokens"]["access_token"]
        .as_str()
        .unwrap()
        .to_string();
    let me = t.call("GET", "/api/auth/me", Some(&tok), None).await.json();
    assert_eq!(me["role"], "user");
    assert_eq!(me["username"], "eve");
    // duplicate
    assert_eq!(
        t.call("POST", "/api/auth/register", None, Some(reg))
            .await
            .status,
        StatusCode::CONFLICT
    );
    // non-admin can't touch admin APIs
    assert_eq!(
        t.call("GET", "/api/admin/users", Some(&tok), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        t.call(
            "PUT",
            "/api/admin/settings",
            Some(&tok),
            Some(json!({"open_registration": false}))
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    // turn off again
    t.adm(
        "PUT",
        "/api/admin/settings",
        Some(json!({"open_registration": false})),
    )
    .await;
    let r = t
        .call(
            "POST",
            "/api/auth/register",
            None,
            Some(json!({"email": "z@example.com", "password": "zzzzzzzzzz"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // guest role is capped at read+download even with a broad grant
    let (gid, gtok) = t.user("gus", "guest").await;
    t.adm("POST", "/api/acl/rules", Some(json!({"path": "/local/team", "subject": "user", "subject_id": gid, "allow": ["upload", "delete"]}))).await;
    let e = t
        .call(
            "GET",
            "/api/acl/effective?path=/local/team",
            Some(&gtok),
            None,
        )
        .await
        .json();
    assert_eq!(e["permissions"], json!(["read", "download"]));
}

#[tokio::test]
async fn login_rate_limit() {
    let t = T::new().await;
    t.user("rita", "user").await;
    for _ in 0..5 {
        assert_eq!(
            t.login("rita", "wrong-password").await.status,
            StatusCode::UNAUTHORIZED
        );
    }
    let r = t.login("rita", "rita-pass-1").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // other accounts unaffected
    assert_eq!(
        t.login("admin", "admin-pass-1").await.status,
        StatusCode::OK
    );
    let audit = t
        .adm("GET", "/api/admin/audit?denied=true&channel=auth", None)
        .await
        .json();
    assert!(audit.as_array().unwrap().len() >= 5);
}

#[tokio::test]
async fn totp_flow() {
    let t = T::new().await;
    let (_, tok) = t.user("tom", "user").await;
    let s = t
        .call("POST", "/api/auth/totp/setup", Some(&tok), None)
        .await
        .json();
    let secret = s["secret"].as_str().unwrap().to_string();
    assert!(s["otpauth_url"]
        .as_str()
        .unwrap()
        .starts_with("otpauth://totp/DriveHub:"));
    let bad = t
        .call(
            "POST",
            "/api/auth/totp/enable",
            Some(&tok),
            Some(json!({"code": "000000"})),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let code = totp_at(&secret, now).unwrap();
    assert_eq!(
        t.call(
            "POST",
            "/api/auth/totp/enable",
            Some(&tok),
            Some(json!({"code": code}))
        )
        .await
        .status,
        StatusCode::OK
    );
    let r = t.login("tom", "tom-pass-1").await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json()["totp_required"], true);
    let r = t
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(json!({"login": "tom", "password": "tom-pass-1", "totp_code": "123456x"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t.call("POST", "/api/auth/login", None, Some(json!({"login": "tom", "password": "tom-pass-1", "totp_code": totp_at(&secret, now).unwrap()}))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // with TOTP on, the account password is refused for WebDAV Basic
    let r = t
        .dav(
            "PROPFIND",
            "/dav/",
            ("tom", "tom-pass-1"),
            None,
            &[("depth", "1")],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn refresh_sessions_force_logout() {
    let t = T::new().await;
    let (uid, _) = t.user("sam", "user").await;
    let a = t.login("sam", "sam-pass-1").await.json();
    let (at, rt) = (
        a["access_token"].as_str().unwrap().to_string(),
        a["refresh_token"].as_str().unwrap().to_string(),
    );
    let sess = t
        .call("GET", "/api/auth/sessions", Some(&at), None)
        .await
        .json();
    assert_eq!(sess.as_array().unwrap().len(), 2);
    let r = t
        .call(
            "POST",
            "/api/auth/refresh",
            None,
            Some(json!({"refresh_token": rt})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let rt2 = r.json()["refresh_token"].as_str().unwrap().to_string();
    // reuse of the rotated token → session revoked (theft detection)
    assert_eq!(
        t.call(
            "POST",
            "/api/auth/refresh",
            None,
            Some(json!({"refresh_token": rt}))
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.call(
            "POST",
            "/api/auth/refresh",
            None,
            Some(json!({"refresh_token": rt2}))
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.call("GET", "/api/auth/me", Some(&at), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    // admin force logout
    let b = t.login("sam", "sam-pass-1").await.json();
    let bt = b["access_token"].as_str().unwrap().to_string();
    assert_eq!(
        t.call("GET", "/api/auth/me", Some(&bt), None).await.status,
        StatusCode::OK
    );
    let r = t
        .adm("POST", &format!("/api/admin/users/{uid}/logout"), None)
        .await;
    assert!(r.json()["revoked"].as_u64().unwrap() >= 1);
    assert_eq!(
        t.call("GET", "/api/auth/me", Some(&bt), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    // logout (own session)
    let c = t.login("sam", "sam-pass-1").await.json();
    let ct = c["access_token"].as_str().unwrap().to_string();
    t.call("POST", "/api/auth/logout", Some(&ct), None).await;
    assert_eq!(
        t.call("GET", "/api/auth/me", Some(&ct), None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn api_tokens_and_app_passwords() {
    let t = T::new().await;
    let (_, tok) = t.user("pat", "user").await;
    let r = t
        .call(
            "POST",
            "/api/auth/tokens",
            Some(&tok),
            Some(json!({"name": "ci"})),
        )
        .await
        .json();
    let pat = r["token"].as_str().unwrap().to_string();
    assert!(pat.starts_with("dh_pat_"));
    let me = t.call("GET", "/api/auth/me", Some(&pat), None).await.json();
    assert_eq!(me["username"], "pat");
    assert_eq!(me["auth_via"], "api_token");
    // token works as WebDAV password
    assert_eq!(
        t.dav(
            "PROPFIND",
            "/dav/local/",
            ("pat", &pat),
            None,
            &[("depth", "1")]
        )
        .await
        .status
        .as_u16(),
        207
    );
    let ap = t
        .call(
            "POST",
            "/api/auth/app-passwords",
            Some(&tok),
            Some(json!({"name": "rclone"})),
        )
        .await
        .json();
    let app_pw = ap["password"].as_str().unwrap().to_string();
    assert_eq!(
        t.dav(
            "PROPFIND",
            "/dav/local/",
            ("pat", &app_pw),
            None,
            &[("depth", "1")]
        )
        .await
        .status
        .as_u16(),
        207
    );
    assert_eq!(
        t.dav(
            "PROPFIND",
            "/dav/local/",
            ("pat", "pat-pass-1"),
            None,
            &[("depth", "1")]
        )
        .await
        .status
        .as_u16(),
        207
    );
    assert_eq!(
        t.dav(
            "PROPFIND",
            "/dav/local/",
            ("pat", "nope-nope"),
            None,
            &[("depth", "1")]
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    // no creds → challenge
    let r = t
        .raw(
            Request::builder()
                .method("PROPFIND")
                .uri("/dav/")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert!(r.headers.get(header::WWW_AUTHENTICATE).is_some());
    // revoke both
    let id = ap["id"].as_i64().unwrap();
    t.call(
        "DELETE",
        &format!("/api/auth/app-passwords/{id}"),
        Some(&tok),
        None,
    )
    .await;
    assert_eq!(
        t.dav(
            "PROPFIND",
            "/dav/local/",
            ("pat", &app_pw),
            None,
            &[("depth", "1")]
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    let tid = r_id(
        &t.call("GET", "/api/auth/tokens", Some(&tok), None)
            .await
            .json(),
    );
    t.call(
        "DELETE",
        &format!("/api/auth/tokens/{tid}"),
        Some(&tok),
        None,
    )
    .await;
    assert_eq!(
        t.call("GET", "/api/auth/me", Some(&pat), None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

fn r_id(v: &Value) -> i64 {
    v.as_array().unwrap()[0]["id"].as_i64().unwrap()
}

fn token_from_mail(m: &Mail) -> String {
    m.body.split("token: ").nth(1).unwrap().trim().to_string()
}

#[tokio::test]
async fn email_verification_and_password_reset() {
    let t = T::new().await;
    t.adm(
        "PUT",
        "/api/admin/settings",
        Some(json!({"open_registration": true, "require_email_verification": true})),
    )
    .await;
    let r = t
        .call(
            "POST",
            "/api/auth/register",
            None,
            Some(
                json!({"username": "vera", "email": "vera@example.com", "password": "vera-pass-1"}),
            ),
        )
        .await;
    assert_eq!(r.json()["verification_required"], true);
    assert_eq!(
        t.login("vera", "vera-pass-1").await.status,
        StatusCode::FORBIDDEN
    );
    let mail = t.outbox.outbox.lock().unwrap().last().cloned().unwrap();
    assert_eq!(mail.to, "vera@example.com");
    assert!(mail.body.contains("/#/verify?token="));
    let r = t
        .call(
            "POST",
            "/api/auth/email/verify",
            None,
            Some(json!({"token": token_from_mail(&mail)})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(t.login("vera", "vera-pass-1").await.status, StatusCode::OK);
    // token is single-use
    assert_eq!(
        t.call(
            "POST",
            "/api/auth/email/verify",
            None,
            Some(json!({"token": token_from_mail(&mail)}))
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    // reset
    assert_eq!(
        t.call(
            "POST",
            "/api/auth/password/forgot",
            None,
            Some(json!({"email": "nobody@example.com"}))
        )
        .await
        .status,
        StatusCode::OK
    );
    let n = t.outbox.outbox.lock().unwrap().len();
    t.call(
        "POST",
        "/api/auth/password/forgot",
        None,
        Some(json!({"email": "VERA@example.com"})),
    )
    .await;
    let mail = t.outbox.outbox.lock().unwrap().last().cloned().unwrap();
    assert_eq!(t.outbox.outbox.lock().unwrap().len(), n + 1);
    assert!(mail.body.contains("/#/reset?token="));
    let r = t
        .call(
            "POST",
            "/api/auth/password/reset",
            None,
            Some(json!({"token": token_from_mail(&mail), "new_password": "vera-new-pass"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        t.login("vera", "vera-pass-1").await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.login("vera", "vera-new-pass").await.status,
        StatusCode::OK
    );
}

/// Minimal fake SMTP server: proves the real lettre SMTP transport path end-to-end.
#[tokio::test]
async fn smtp_transport_against_fake_server() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (s, _) = l.accept().await.unwrap();
        let (r, mut w) = s.into_split();
        let mut r = BufReader::new(r);
        w.write_all(b"220 fake ESMTP\r\n").await.unwrap();
        let mut data = String::new();
        let mut in_data = false;
        let mut line = String::new();
        loop {
            line.clear();
            if r.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            if in_data {
                if line == ".\r\n" {
                    in_data = false;
                    w.write_all(b"250 queued\r\n").await.unwrap();
                } else {
                    data.push_str(&line);
                }
                continue;
            }
            let up = line.to_uppercase();
            let reply: &[u8] = if up.starts_with("EHLO") || up.starts_with("HELO") {
                b"250-fake\r\n250 OK\r\n"
            } else if up.starts_with("DATA") {
                in_data = true;
                b"354 go\r\n"
            } else if up.starts_with("QUIT") {
                w.write_all(b"221 bye\r\n").await.unwrap();
                break;
            } else {
                b"250 OK\r\n"
            };
            w.write_all(reply).await.unwrap();
        }
        data
    });
    let m = SmtpMailer {
        cfg: SmtpConfig {
            host: "127.0.0.1".into(),
            port,
            username: None,
            password: None,
            from: "DriveHub <noreply@example.com>".into(),
            security: "none".into(),
        },
    };
    m.send(Mail {
        to: "u@example.com".into(),
        subject: "Hello SMTP".into(),
        body: "token: abc".into(),
    })
    .await
    .unwrap();
    let data = server.await.unwrap();
    assert!(data.contains("Subject: Hello SMTP"), "{data}");
    assert!(data.contains("token: abc"));
}

/// Mock OAuth provider (authorization-code flow) served on a random local port.
async fn mock_oauth() -> String {
    use axum::routing::{get, post};
    let app = axum::Router::new()
        .route(
            "/token",
            post(|body: String| async move {
                if body.contains("code=good-gh") {
                    axum::Json(json!({"access_token": "gh-at", "token_type": "bearer"}))
                } else if body.contains("code=good-g") {
                    axum::Json(json!({"access_token": "g-at", "token_type": "bearer"}))
                } else {
                    axum::Json(json!({"error": "bad_verification_code"}))
                }
            }),
        )
        .route(
            "/user",
            get(|h: axum::http::HeaderMap| async move {
                let a = h
                    .get("authorization")
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_string();
                if a.ends_with("gh-at") {
                    axum::Json(json!({"id": 4242, "login": "octo", "email": null}))
                } else {
                    axum::Json(
                        json!({"sub": "g-1", "email": "OCTO@example.com", "email_verified": true}),
                    )
                }
            }),
        )
        .route(
            "/emails",
            get(|| async {
                axum::Json(
                    json!([{"email": "octo@example.com", "primary": true, "verified": true}]),
                )
            }),
        );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    base
}

fn provider(name: &str, base: &str, emails: bool) -> OAuthProvider {
    OAuthProvider {
        name: name.into(),
        client_id: format!("{name}-cid"),
        client_secret: "sec".into(),
        auth_url: format!("{base}/authorize"),
        token_url: format!("{base}/token"),
        userinfo_url: format!("{base}/user"),
        emails_url: emails.then(|| format!("{base}/emails")),
        scope: "email".into(),
    }
}

fn frag(loc: &str) -> Vec<(String, String)> {
    let f = loc.split("#/oauth?").nth(1).unwrap_or("");
    url::form_urlencoded::parse(f.as_bytes())
        .into_owned()
        .collect()
}

async fn oauth_round(t: &T, prov: &str, code: &str, tok: Option<&str>) -> Vec<(String, String)> {
    let start = if tok.is_some() {
        format!("/api/auth/oauth/{prov}/start?link=true&format=json")
    } else {
        format!("/api/auth/oauth/{prov}/start")
    };
    let r = t.call("GET", &start, tok, None).await;
    let url = if tok.is_some() {
        r.json()["url"].as_str().unwrap().to_string()
    } else {
        assert_eq!(r.status, StatusCode::SEE_OTHER);
        r.headers[header::LOCATION].to_str().unwrap().to_string()
    };
    let u = url::Url::parse(&url).unwrap();
    let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
    assert_eq!(q["client_id"], format!("{prov}-cid"));
    assert!(q["redirect_uri"].ends_with(&format!("/api/auth/oauth/{prov}/callback")));
    let r = t
        .raw(
            Request::get(format!(
                "/api/auth/oauth/{prov}/callback?code={code}&state={}",
                q["state"]
            ))
            .header("host", "dh.test")
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(r.status, StatusCode::SEE_OTHER);
    frag(r.headers[header::LOCATION].to_str().unwrap())
}

#[tokio::test]
async fn oauth_mock_login_autolink_and_explicit_link() {
    let t = T::new().await;
    let base = mock_oauth().await;
    t.st.auth
        .set_oauth_provider(provider("github", &base, true));
    t.st.auth
        .set_oauth_provider(provider("google", &base, false));
    let s = t.call("GET", "/api/auth/status", None, None).await.json();
    assert_eq!(s["oauth_providers"], json!(["github", "google"]));
    // unknown user + closed registration → error
    let f = oauth_round(&t, "github", "good-gh", None).await;
    assert_eq!(f[0].0, "error", "{f:?}");
    // bad code → error
    assert_eq!(oauth_round(&t, "github", "bad", None).await[0].0, "error");
    // invalid state → error
    let r = t
        .raw(
            Request::get("/api/auth/oauth/github/callback?code=good-gh&state=forged")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert!(r.headers[header::LOCATION]
        .to_str()
        .unwrap()
        .contains("error="));
    // existing local account with the same verified e-mail → auto-linked
    let (uid, tok) = t.user("octo", "user").await;
    let f = oauth_round(&t, "github", "good-gh", None).await;
    let at = &f
        .iter()
        .find(|(k, _)| k == "access_token")
        .expect("tokens")
        .1;
    let me = t.call("GET", "/api/auth/me", Some(at), None).await.json();
    assert_eq!(me["id"], uid);
    assert_eq!(me["identities"], json!(["github"]));
    // explicit link of a second login method while logged in
    let f = oauth_round(&t, "google", "good-g", Some(&tok)).await;
    assert_eq!(f[0], ("linked".to_string(), "google".to_string()));
    let ids = t
        .call("GET", "/api/auth/identities", Some(&tok), None)
        .await
        .json();
    assert_eq!(ids.as_array().unwrap().len(), 2);
    // google login now resolves to the same user
    let f = oauth_round(&t, "google", "good-g", None).await;
    let at = &f.iter().find(|(k, _)| k == "access_token").unwrap().1;
    assert_eq!(
        t.call("GET", "/api/auth/me", Some(at), None).await.json()["id"],
        uid
    );
    // linking an identity owned by someone else is refused
    let (_, other) = t.user("mallory", "user").await;
    assert_eq!(
        oauth_round(&t, "google", "good-g", Some(&other)).await[0].0,
        "error"
    );
    // open registration → new OAuth-only user
    t.adm("DELETE", &format!("/api/admin/users/{uid}"), None)
        .await;
    t.adm(
        "PUT",
        "/api/admin/settings",
        Some(json!({"open_registration": true})),
    )
    .await;
    let f = oauth_round(&t, "github", "good-gh", None).await;
    let at = &f
        .iter()
        .find(|(k, _)| k == "access_token")
        .expect("new user")
        .1;
    let me = t.call("GET", "/api/auth/me", Some(at), None).await.json();
    assert_eq!(me["username"], "octo");
    assert_eq!(me["has_password"], false);
}

/// ACL setup shared by the deny / consistency tests.
async fn acl_world(t: &T) -> (i64, String, String) {
    let g = t
        .adm("POST", "/api/admin/groups", Some(json!({"name": "team"})))
        .await
        .json();
    let gid = g["id"].as_i64().unwrap();
    let (bid, btok) = t.user("bob", "user").await;
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{bid}"),
        Some(json!({"groups": [gid]})),
    )
    .await;
    t.adm(
        "POST",
        "/api/acl/rules",
        Some(
            json!({"path": "/local/secret", "subject": "logged_in", "deny": ["read", "download"]}),
        ),
    )
    .await;
    t.adm("POST", "/api/acl/rules", Some(json!({"path": "/local/team", "subject": "group", "subject_id": gid, "allow": ["upload", "create", "edit", "rename", "move", "delete"]}))).await;
    let ap = t
        .call(
            "POST",
            "/api/auth/app-passwords",
            Some(&btok),
            Some(json!({"name": "dav"})),
        )
        .await
        .json();
    t.adm("POST", "/api/search/reindex", None).await;
    (bid, btok, ap["password"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn acl_deny_is_enforced_and_audited_on_api_and_webdav() {
    let t = T::new().await;
    let (_, tok, app) = acl_world(&t).await;
    // read denied on /local/secret
    assert_eq!(
        t.call("GET", "/api/fs/list?path=/local/secret", Some(&tok), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        t.call(
            "GET",
            "/api/fs/download?path=/local/secret/c.txt",
            Some(&tok),
            None
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        t.dav("GET", "/dav/local/secret/c.txt", ("bob", &app), None, &[])
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        t.dav(
            "PROPFIND",
            "/dav/local/secret/",
            ("bob", &app),
            None,
            &[("depth", "1")]
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    // upload denied on /local/pub (read-only for users)
    let r = t
        .raw(
            Request::put("/api/fs/upload?path=/local/pub/x.txt")
                .header("authorization", format!("Bearer {tok}"))
                .body(Body::from("x"))
                .unwrap(),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(
        t.dav("PUT", "/dav/local/pub/x.txt", ("bob", &app), Some("x"), &[])
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        t.dav("DELETE", "/dav/local/pub/a.txt", ("bob", &app), None, &[])
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        t.dav("MKCOL", "/dav/local/pub/newdir", ("bob", &app), None, &[])
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        t.call(
            "POST",
            "/api/fs/delete",
            Some(&tok),
            Some(json!({"path": "/local/pub/a.txt"}))
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    // allowed in team: upload, mkdir, rename, delete — via both entries
    let r = t
        .raw(
            Request::put("/api/fs/upload?path=/local/team/api.txt")
                .header("authorization", format!("Bearer {tok}"))
                .body(Body::from("api"))
                .unwrap(),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert!(t
        .dav(
            "PUT",
            "/dav/local/team/dav.txt",
            ("bob", &app),
            Some("hello dav"),
            &[]
        )
        .await
        .status
        .is_success());
    assert_eq!(
        t.dav("MKCOL", "/dav/local/team/sub", ("bob", &app), None, &[])
            .await
            .status,
        StatusCode::CREATED
    );
    assert!(t
        .dav(
            "MOVE",
            "/dav/local/team/dav.txt",
            ("bob", &app),
            None,
            &[("destination", "/dav/local/team/sub/moved.txt")]
        )
        .await
        .status
        .is_success());
    let r = t
        .dav(
            "GET",
            "/dav/local/team/sub/moved.txt",
            ("bob", &app),
            None,
            &[],
        )
        .await;
    assert_eq!(r.text(), "hello dav");
    // Range over WebDAV
    let r = t
        .dav(
            "GET",
            "/dav/local/pub/big.bin",
            ("bob", &app),
            None,
            &[("range", "bytes=4-7")],
        )
        .await;
    assert_eq!(r.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.text(), "4567");
    assert!(t
        .dav(
            "DELETE",
            "/dav/local/team/sub/moved.txt",
            ("bob", &app),
            None,
            &[]
        )
        .await
        .status
        .is_success());
    // audit: denials from both channels
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let a = t
        .adm("GET", "/api/admin/audit?denied=true&limit=200", None)
        .await
        .json();
    let chans: BTreeSet<String> = a
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["username"] == "bob")
        .map(|e| e["channel"].as_str().unwrap().to_string())
        .collect();
    assert!(
        chans.contains("api") && chans.contains("webdav"),
        "{chans:?}"
    );
    let ok = t
        .adm("GET", "/api/admin/audit?channel=webdav&limit=200", None)
        .await
        .json();
    assert!(ok
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["allowed"] == true && e["action"] == "upload"));
}

/// Same user ⇒ identical visibility/permissions through API, WebDAV and search.
#[tokio::test]
async fn permissions_consistent_across_api_webdav_search() {
    let t = T::new().await;
    let (_, tok, app) = acl_world(&t).await;
    for dir in ["/local", "/local/pub", "/local/team"] {
        let api: BTreeSet<String> = t
            .call("GET", &format!("/api/fs/list?path={dir}"), Some(&tok), None)
            .await
            .json()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["name"].as_str().unwrap().to_string())
            .collect();
        let r = t
            .dav(
                "PROPFIND",
                &format!("/dav{dir}/"),
                ("bob", &app),
                None,
                &[("depth", "1")],
            )
            .await;
        assert_eq!(r.status.as_u16(), 207);
        let dav = dav_names(&r.text(), &format!("/dav{dir}"));
        assert_eq!(api, dav, "listing mismatch in {dir}");
    }
    let root: BTreeSet<String> = t
        .call("GET", "/api/fs/list?path=/local", Some(&tok), None)
        .await
        .json()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        root,
        ["pub", "team"].iter().map(|s| s.to_string()).collect()
    );
    // search shows exactly the readable files
    let s = t
        .call("GET", "/api/search?q=ext:txt", Some(&tok), None)
        .await
        .json();
    let found: BTreeSet<String> = s["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["path"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        found,
        ["/local/pub/a.txt", "/local/team/b.txt"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    );
    assert_eq!(s["total"], 2);
    let s = t.adm("GET", "/api/search?q=ext:txt", None).await.json();
    assert_eq!(s["total"], 3);
    // per-file: effective READ/DOWNLOAD ⇔ API download ⇔ WebDAV GET
    for f in [
        "/local/pub/a.txt",
        "/local/team/b.txt",
        "/local/secret/c.txt",
    ] {
        let e = t
            .call(
                "GET",
                &format!("/api/acl/effective?path={f}"),
                Some(&tok),
                None,
            )
            .await
            .json();
        let can = e["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "download");
        let api = t
            .call(
                "GET",
                &format!("/api/fs/download?path={f}"),
                Some(&tok),
                None,
            )
            .await
            .status
            == StatusCode::OK;
        let dav = t
            .dav("GET", &format!("/dav{f}"), ("bob", &app), None, &[])
            .await
            .status
            == StatusCode::OK;
        let srch = found.contains(f);
        assert_eq!((can, api, dav, srch), (can, can, can, can), "{f}");
    }
    // admin effective viewer for another user explains the decision
    let bob = t
        .adm("GET", "/api/admin/users", None)
        .await
        .json()
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["username"] == "bob")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let e = t
        .adm(
            "GET",
            &format!("/api/acl/effective?path=/local/secret/c.txt&user_id={bob}"),
            None,
        )
        .await
        .json();
    assert_eq!(e["permissions"], json!([]));
    assert_eq!(e["trace"].as_array().unwrap().len(), 2);
    // a user may not inspect others
    assert_eq!(
        t.call(
            "GET",
            "/api/acl/effective?path=/local&user_id=1",
            Some(&tok),
            None
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn quota_jail_visible_mounts_and_password_gate() {
    let t = T::new().await;
    let (_, tok, _) = acl_world(&t).await;
    let bob = 2;
    // quota
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{bob}"),
        Some(json!({"quota_bytes": 8})),
    )
    .await;
    let up = |p: &str, data: &'static str| {
        Request::put(format!("/api/fs/upload?path={p}"))
            .header("authorization", format!("Bearer {tok}"))
            .header("content-length", data.len())
            .body(Body::from(data))
            .unwrap()
    };
    assert_eq!(
        t.raw(up("/local/team/q1.txt", "12345")).await.status,
        StatusCode::OK
    );
    assert_eq!(
        t.raw(up("/local/team/q2.txt", "12345")).await.status,
        StatusCode::INSUFFICIENT_STORAGE
    );
    let me = t.call("GET", "/api/auth/me", Some(&tok), None).await.json();
    assert_eq!(me["used_bytes"], 5);
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{bob}"),
        Some(json!({"quota_bytes": -1})),
    )
    .await;
    // jail: bob's root becomes /local/team
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{bob}"),
        Some(json!({"root_path": "/local/team"})),
    )
    .await;
    let l = t
        .call("GET", "/api/fs/list?path=/", Some(&tok), None)
        .await
        .json();
    let names: BTreeSet<String> = l["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["path"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains("/b.txt"), "{names:?}");
    let s = t
        .call("GET", "/api/search?q=ext:txt", Some(&tok), None)
        .await
        .json();
    assert!(s["hits"]
        .as_array()
        .unwrap()
        .iter()
        .all(|h| !h["path"].as_str().unwrap().starts_with("/local")));
    assert_eq!(
        t.call("GET", "/api/fs/download?path=/b.txt", Some(&tok), None)
            .await
            .text(),
        "bravo"
    );
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{bob}"),
        Some(json!({"root_path": "/"})),
    )
    .await;
    // visible mounts
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{bob}"),
        Some(json!({"visible_mounts": ["other"]})),
    )
    .await;
    assert_eq!(
        t.call("GET", "/api/fs/list?path=/", Some(&tok), None)
            .await
            .json()["total"],
        0
    );
    assert_eq!(
        t.call("GET", "/api/fs/list?path=/local", Some(&tok), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{bob}"),
        Some(json!({"clear_visible_mounts": true})),
    )
    .await;
    // password gate on /local/pub (+ anonymous may read with the password)
    t.adm(
        "PUT",
        "/api/acl/gates",
        Some(json!({"path": "/local/pub", "modes": ["password"], "password": "open-sesame"})),
    )
    .await;
    t.adm(
        "POST",
        "/api/acl/rules",
        Some(json!({"path": "/local/pub", "subject": "anonymous", "allow": ["read", "download"]})),
    )
    .await;
    assert_eq!(
        t.call("GET", "/api/fs/list?path=/local/pub", Some(&tok), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let r = t
        .raw(
            Request::get("/api/fs/list?path=/local/pub")
                .header("authorization", format!("Bearer {tok}"))
                .header("x-drivehub-path-password", "open-sesame")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let r = t
        .raw(
            Request::get("/api/fs/download?path=/local/pub/a.txt&path_password=open-sesame")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(r.text(), "alpha");
    assert_eq!(
        t.call("GET", "/api/fs/download?path=/local/pub/a.txt", None, None)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    // combine modes: logged-in OR password
    t.adm(
        "PUT",
        "/api/acl/gates",
        Some(json!({"path": "/local/pub", "modes": ["logged_in", "password"]})),
    )
    .await;
    assert_eq!(
        t.call("GET", "/api/fs/list?path=/local/pub", Some(&tok), None)
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn roles_crud_and_assignment_grant_permissions() {
    let t = T::new().await;
    // builtin roles are seeded
    let roles = t.adm("GET", "/api/admin/roles", None).await.json();
    let names: Vec<_> = roles
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"viewer".into()) && names.contains(&"manager".into()));
    // create / update / conflict
    let r = t
        .adm(
            "POST",
            "/api/admin/roles",
            Some(json!({"name": "uploader", "permissions": ["read", "upload"]})),
        )
        .await
        .json();
    let rid = r["id"].as_i64().unwrap();
    assert_eq!(
        t.call(
            "POST",
            "/api/admin/roles",
            Some(&t.admin.clone()),
            Some(json!({"name": "uploader"}))
        )
        .await
        .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        t.call(
            "POST",
            "/api/admin/roles",
            Some(&t.admin.clone()),
            Some(json!({"name": "x", "permissions": ["fly"]}))
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    // bob has no access to /local/team beyond the default logged_in read; deny upload by default
    let (bid, btok) = t.user("bob", "user").await;
    let up = |tok: String, p: &'static str| {
        let t = &t;
        async move {
            t.raw(
                Request::put(format!("/api/fs/upload?path=/local/team/{p}"))
                    .header(header::AUTHORIZATION, format!("Bearer {tok}"))
                    .body(Body::from("x"))
                    .unwrap(),
            )
            .await
            .status
        }
    };
    assert_eq!(up(btok.clone(), "u1.txt").await, StatusCode::FORBIDDEN);
    // assign role directly to the user
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{bid}"),
        Some(json!({"roles": [rid]})),
    )
    .await;
    assert_eq!(up(btok.clone(), "u1.txt").await, StatusCode::OK);
    let u = t.adm("GET", "/api/admin/users", None).await.json();
    let bob = u
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == bid)
        .unwrap()
        .clone();
    assert_eq!(bob["roles"][0]["name"], "uploader");
    // an explicit deny rule deeper still wins over the role
    t.adm("POST", "/api/acl/rules", Some(json!({"path": "/local/team", "subject": "user", "subject_id": bid, "deny": ["upload"]}))).await;
    assert_eq!(up(btok.clone(), "u2.txt").await, StatusCode::FORBIDDEN);
    // synthetic role rules are not listed as ACL rules
    let rules = t.adm("GET", "/api/acl/rules", None).await.json();
    assert!(rules
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["id"].as_i64().unwrap() > 0));
    // group role: carol via group
    let g = t
        .adm("POST", "/api/admin/groups", Some(json!({"name": "ops"})))
        .await
        .json();
    let gid = g["id"].as_i64().unwrap();
    let (cid, ctok) = t.user("carol", "user").await;
    assert_eq!(up(ctok.clone(), "c1.txt").await, StatusCode::FORBIDDEN);
    let g = t
        .adm(
            "PATCH",
            &format!("/api/admin/groups/{gid}"),
            Some(json!({"name": "ops2", "members": [cid], "roles": [rid]})),
        )
        .await
        .json();
    assert_eq!(g["name"], "ops2");
    assert_eq!(g["members"], 1);
    assert_eq!(g["roles"][0]["id"], rid);
    assert_eq!(up(ctok.clone(), "c1.txt").await, StatusCode::OK);
    // update role permissions removes the grant
    t.adm(
        "PATCH",
        &format!("/api/admin/roles/{rid}"),
        Some(json!({"name": "uploader", "permissions": ["read"]})),
    )
    .await;
    assert_eq!(up(ctok.clone(), "c2.txt").await, StatusCode::FORBIDDEN);
    // builtin role keeps its name
    let vid = roles
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "viewer")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let v = t
        .adm(
            "PATCH",
            &format!("/api/admin/roles/{vid}"),
            Some(json!({"name": "renamed", "permissions": ["read"]})),
        )
        .await
        .json();
    assert_eq!(v["name"], "viewer");
    // delete role clears assignments; non-admin is refused
    assert_eq!(
        t.call("GET", "/api/admin/roles", Some(&btok), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    t.adm("DELETE", &format!("/api/admin/roles/{rid}"), None)
        .await;
    let g = t.adm("GET", "/api/admin/groups", None).await.json();
    assert_eq!(g[0]["roles"].as_array().unwrap().len(), 0);
}
