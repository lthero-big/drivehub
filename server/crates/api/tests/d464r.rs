#![allow(dead_code)]
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use drivehub_api::auth::LogMailer;
use drivehub_api::{connect, router, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
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

fn uid_of(v: &Value) -> i64 {
    v["id"].as_i64().unwrap()
}

async fn role_id(t: &T, name: &str) -> i64 {
    let rs = t.adm("GET", "/api/admin/roles", None).await.json();
    rs.as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

/// DEPTAI-464r: account type is derived from builtin level roles (direct or via groups).
#[tokio::test]
async fn account_level_comes_from_roles() {
    let t = T::new().await;
    // the bootstrap admin got the builtin admin role
    let me = t.adm("GET", "/api/admin/users", None).await.json();
    let admin = &me.as_array().unwrap()[0];
    assert!(
        admin["roles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "admin"),
        "{admin}"
    );
    let (admin_r, user_r, guest_r) = (
        role_id(&t, "admin").await,
        role_id(&t, "user").await,
        role_id(&t, "guest").await,
    );
    let roles = t.adm("GET", "/api/admin/roles", None).await.json();
    assert!(roles
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["name"] == "guest" && r["level"] == "guest" && r["builtin"] == true));
    // new user: legacy `role` field still accepted and mapped to the level role
    let bob = t
        .adm(
            "POST",
            "/api/admin/users",
            Some(json!({"username": "bob", "password": "bob-pass-12", "role": "guest"})),
        )
        .await
        .json();
    assert_eq!(bob["level"], "guest");
    assert_eq!(bob["roles"].as_array().unwrap().len(), 1);
    let bid = uid_of(&bob);
    // admin via group role
    let g = t
        .adm("POST", "/api/admin/groups", Some(json!({"name": "ops"})))
        .await
        .json();
    let gid = uid_of(&g);
    t.adm(
        "PATCH",
        &format!("/api/admin/groups/{gid}"),
        Some(json!({"members": [bid], "roles": [admin_r]})),
    )
    .await;
    let bob = t
        .adm("GET", "/api/admin/users", None)
        .await
        .json()
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["id"] == bid)
        .unwrap()
        .clone();
    assert_eq!(bob["level"], "admin");
    let tok = t
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
    assert_eq!(
        t.call("GET", "/api/admin/users", Some(&tok), None)
            .await
            .status,
        StatusCode::OK
    );
    // removing the group's role demotes him again
    t.adm(
        "PATCH",
        &format!("/api/admin/groups/{gid}"),
        Some(json!({"roles": []})),
    )
    .await;
    assert_eq!(
        t.call("GET", "/api/admin/users", Some(&tok), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    // multi roles on the user: user + custom viewer
    let viewer = role_id(&t, "viewer").await;
    let r = t
        .adm(
            "PATCH",
            &format!("/api/admin/users/{bid}"),
            Some(json!({"roles": [user_r, viewer]})),
        )
        .await
        .json();
    assert_eq!(r["level"], "user");
    assert_eq!(r["roles"].as_array().unwrap().len(), 2);
    let _ = guest_r;
    // last admin can't lose the admin role
    let aid = uid_of(admin);
    let r = t
        .call(
            "PATCH",
            &format!("/api/admin/users/{aid}"),
            Some(&t.admin),
            Some(json!({"roles": [user_r]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text());
    let me = t.adm("GET", "/api/admin/users", None).await.json();
    assert_eq!(me.as_array().unwrap()[0]["level"], "admin");
    // builtin roles cannot be deleted
    assert_eq!(
        t.call(
            "DELETE",
            &format!("/api/admin/roles/{admin_r}"),
            Some(&t.admin),
            None
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
}

async fn room_tok(t: &T, c: &str) -> String {
    let r = t.anon(&format!("/api/s/{c}"), "7.0.0.1", &[]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["token"].as_str().unwrap().to_string()
}

/// DEPTAI-464r: drop room create → anonymous upload → list → download → caps → expiry.
#[tokio::test]
async fn drop_room_caps_and_expiry() {
    let t = T::new().await;
    let s = t
        .share(json!({"room": true, "paths": ["/local"], "max_uploads": 2, "max_bytes": 10}))
        .await;
    assert_eq!(s["kind"], "room");
    assert!(s["room_url"].as_str().unwrap().contains("/r/"));
    let folder = s["items"][0].as_str().unwrap().to_string();
    assert!(folder.starts_with("/local/.droprooms/"), "{folder}");
    let fname = folder.rsplit('/').next().unwrap().to_string();
    let c = code(&s);
    // /r/<code> redirects to the share entry
    let r = t
        .raw(Request::get(format!("/r/{c}")).body(Body::empty()).unwrap())
        .await;
    assert!(r.status.is_redirection(), "{}", r.status);
    let tok = room_tok(&t, &c).await;
    let up = |p: &str, body: &'static str| {
        Request::put(format!("/api/s/{c}/upload?path={p}&t={tok}"))
            .header("content-length", body.len().to_string())
            .body(Body::from(body))
            .unwrap()
    };
    assert_eq!(t.raw(up("a.txt", "hello")).await.status, StatusCode::OK);
    // size cap: 5 + 6 > 10
    assert_eq!(
        t.raw(up("b.txt", "world!")).await.status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(t.raw(up("b.txt", "abc")).await.status, StatusCode::OK);
    // count cap
    assert_eq!(
        t.raw(up("c.txt", "x")).await.status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(!t
        ._dir
        .path()
        .join(format!(".droprooms/{fname}/c.txt"))
        .exists());
    let l = t
        .anon(
            &format!("/api/s/{c}/list?t={tok}&path={fname}"),
            "7.0.0.1",
            &[],
        )
        .await;
    assert_eq!(l.status, StatusCode::OK, "{}", l.text());
    assert!(
        l.text().contains("a.txt") && l.text().contains("b.txt"),
        "{}",
        l.text()
    );
    let d = t
        .anon(
            &format!("/api/s/{c}/download?t={tok}&path={fname}/a.txt"),
            "7.0.0.1",
            &[],
        )
        .await;
    assert_eq!(d.status, StatusCode::OK);
    assert_eq!(d.text(), "hello");
    // listed in my shares with stats
    let mine = t.adm("GET", "/api/shares", None).await.json();
    let row = mine
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["code"] == c.as_str())
        .unwrap()
        .clone();
    assert_eq!(row["uploads"], 2);
    assert_eq!(row["up_bytes"], 8);

    // PIN room, download disabled
    let s2 = t
        .share(
            json!({"room": true, "paths": ["/local/docs"], "pin": "4242", "allow_download": false}),
        )
        .await;
    let c2 = code(&s2);
    assert_eq!(
        t.anon(&format!("/api/s/{c2}"), "7.0.0.2", &[]).await.status,
        StatusCode::UNAUTHORIZED
    );
    let tok2 = t
        .anon(&format!("/api/s/{c2}-4242"), "7.0.0.2", &[])
        .await
        .json()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let f2 = s2["items"][0]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    let r = t
        .raw(
            Request::put(format!("/api/s/{c2}/upload?path=z.txt&t={tok2}"))
                .body(Body::from("z"))
                .unwrap(),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let d = t
        .anon(
            &format!("/api/s/{c2}/download?t={tok2}&path={f2}/z.txt"),
            "7.0.0.2",
            &[],
        )
        .await;
    assert_eq!(d.status, StatusCode::FORBIDDEN);

    // expiry: room is rejected and its folder cleaned up
    let s3 = t
        .share(json!({"room": true, "paths": ["/local"], "expires_in_secs": -1}))
        .await;
    let f3 = s3["items"][0]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    assert!(t._dir.path().join(format!(".droprooms/{f3}")).exists());
    let r = t
        .anon(&format!("/api/s/{}", code(&s3)), "7.0.0.3", &[])
        .await;
    assert!(
        r.status == StatusCode::GONE || r.status == StatusCode::NOT_FOUND,
        "{}",
        r.status
    );
    assert_eq!(drivehub_api::share_api::sweep_rooms(&t.st).await, 1);
    assert!(!t._dir.path().join(format!(".droprooms/{f3}")).exists());
    assert_eq!(
        t.call(
            "GET",
            &format!("/api/shares/{}", s3["id"]),
            Some(&t.admin),
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    // deleting a room removes its folder
    t.adm("DELETE", &format!("/api/shares/{}", s["id"]), None)
        .await;
    assert!(!t._dir.path().join(format!(".droprooms/{fname}")).exists());
}
