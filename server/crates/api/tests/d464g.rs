//! DEPTAI-464 follow-up: at-least-one-admin guard; drop-room folders hidden from file lists.
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
    rs.as_array().unwrap().iter().find(|r| r["name"] == name).unwrap()["id"].as_i64().unwrap()
}


async fn level_of(t: &T, id: i64) -> String {
    let us = t.adm("GET", "/api/admin/users", None).await.json();
    us.as_array().unwrap().iter().find(|u| u["id"] == id).unwrap()["level"].as_str().unwrap().to_string()
}

async fn blocked(t: &T, method: &str, uri: &str, body: Option<Value>) {
    let r = t.call(method, uri, Some(&t.admin), body.clone()).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{method} {uri} {body:?}: {}", r.text());
    assert!(r.text().contains("至少需要保留一个启用的管理员"), "{}", r.text());
}

async fn new_user(t: &T, name: &str) -> i64 {
    uid_of(&t.adm("POST", "/api/admin/users", Some(json!({"username": name, "password": "user-pass-12"}))).await.json())
}

/// Every path that could drop the last enabled admin is rejected and leaves state unchanged.
#[tokio::test]
async fn last_admin_guard_blocks_every_path() {
    let t = T::new().await;
    let aid = uid_of(&t.adm("GET", "/api/admin/users", None).await.json()[0]);
    let (admin_r, user_r) = (role_id(&t, "admin").await, role_id(&t, "user").await);
    // the only admin gets admin-ness only via group "ops"
    let gid = uid_of(&t.adm("POST", "/api/admin/groups", Some(json!({"name": "ops"}))).await.json());
    t.adm("PATCH", &format!("/api/admin/groups/{gid}"), Some(json!({"members": [aid], "roles": [admin_r]}))).await;
    t.adm("PATCH", &format!("/api/admin/users/{aid}"), Some(json!({"roles": [user_r]}))).await;
    assert_eq!(level_of(&t, aid).await, "admin");
    let g = format!("/api/admin/groups/{gid}");
    let u = format!("/api/admin/users/{aid}");
    // group: remove admin role / change roles / remove member / delete
    blocked(&t, "PATCH", &g, Some(json!({"roles": []}))).await;
    blocked(&t, "PATCH", &g, Some(json!({"roles": [user_r]}))).await;
    blocked(&t, "PATCH", &g, Some(json!({"members": []}))).await;
    blocked(&t, "DELETE", &g, None).await;
    // user: leave the group / disable / delete
    blocked(&t, "PATCH", &u, Some(json!({"groups": []}))).await;
    blocked(&t, "PATCH", &u, Some(json!({"disabled": true}))).await;
    blocked(&t, "DELETE", &u, None).await;
    // nothing changed (rolled back)
    let gj = t.adm("GET", "/api/admin/groups", None).await.json();
    let gj = gj.as_array().unwrap().iter().find(|x| x["id"] == gid).unwrap().clone();
    assert_eq!(gj["members"], 1, "{gj}");
    assert_eq!(gj["roles"][0]["name"], "admin", "{gj}");
    assert_eq!(level_of(&t, aid).await, "admin");
    // admin direct again → the group is no longer needed and can go
    t.adm("PATCH", &u, Some(json!({"roles": [admin_r]}))).await;
    t.adm("DELETE", &g, None).await;
    // direct-only admin: legacy account type / role list / disable / delete
    blocked(&t, "PATCH", &u, Some(json!({"role": "user"}))).await;
    blocked(&t, "PATCH", &u, Some(json!({"roles": [user_r]}))).await;
    blocked(&t, "PATCH", &u, Some(json!({"roles": []}))).await;
    blocked(&t, "PATCH", &u, Some(json!({"disabled": true}))).await;
    blocked(&t, "DELETE", &u, None).await;
    // a disabled admin does not count
    let bob = new_user(&t, "bob").await;
    t.adm("PATCH", &format!("/api/admin/users/{bob}"), Some(json!({"roles": [admin_r], "disabled": true}))).await;
    blocked(&t, "PATCH", &u, Some(json!({"disabled": true}))).await;
    blocked(&t, "PATCH", &u, Some(json!({"role": "guest"}))).await;
    // still an admin
    assert_eq!(t.call("GET", "/api/admin/users", Some(&t.admin), None).await.status, StatusCode::OK);
    assert_eq!(level_of(&t, aid).await, "admin");
}

/// With another enabled admin around the same changes go through.
#[tokio::test]
async fn non_last_admin_changes_still_work() {
    let t = T::new().await;
    let (admin_r, user_r) = (role_id(&t, "admin").await, role_id(&t, "user").await);
    // bob: direct admin
    let bob = new_user(&t, "bob").await;
    let b = format!("/api/admin/users/{bob}");
    t.adm("PATCH", &b, Some(json!({"roles": [admin_r]}))).await;
    assert_eq!(level_of(&t, bob).await, "admin");
    t.adm("PATCH", &b, Some(json!({"disabled": true}))).await;
    t.adm("PATCH", &b, Some(json!({"disabled": false}))).await;
    t.adm("PATCH", &b, Some(json!({"role": "user"}))).await;
    assert_eq!(level_of(&t, bob).await, "user");
    t.adm("PATCH", &b, Some(json!({"roles": [admin_r]}))).await;
    t.adm("DELETE", &b, None).await;
    // carol: admin via group only
    let carol = new_user(&t, "carol").await;
    let c = format!("/api/admin/users/{carol}");
    t.adm("PATCH", &c, Some(json!({"roles": []}))).await;
    let gid = uid_of(&t.adm("POST", "/api/admin/groups", Some(json!({"name": "ops"}))).await.json());
    let g = format!("/api/admin/groups/{gid}");
    t.adm("PATCH", &g, Some(json!({"members": [carol], "roles": [admin_r]}))).await;
    assert_eq!(level_of(&t, carol).await, "admin");
    // removing the group's admin role demotes her (no stale cached admin level)
    t.adm("PATCH", &g, Some(json!({"roles": [user_r]}))).await;
    assert_eq!(level_of(&t, carol).await, "user");
    t.adm("PATCH", &g, Some(json!({"roles": [admin_r]}))).await;
    t.adm("PATCH", &g, Some(json!({"members": []}))).await;
    assert_eq!(level_of(&t, carol).await, "user");
    t.adm("PATCH", &g, Some(json!({"members": [carol]}))).await;
    t.adm("PATCH", &c, Some(json!({"groups": []}))).await;
    assert_eq!(level_of(&t, carol).await, "user");
    t.adm("PATCH", &g, Some(json!({"members": [carol]}))).await;
    assert_eq!(level_of(&t, carol).await, "admin");
    t.adm("DELETE", &g, None).await;
    assert_eq!(level_of(&t, carol).await, "user");
    t.adm("DELETE", &c, None).await;
}
