//! DEPTAI-485 round 6: share delete (API side of undo), visitor IP statistics + offline geo.
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
fn install_geo() {
    use drivehub_api::geoip;
    let db = geoip::build_xdb(&[
        ("1.0.1.0".parse().unwrap(), "1.0.3.255".parse().unwrap(), "中国|福建省|福州市|中国电信|CN"),
        ("1.0.8.0".parse().unwrap(), "1.0.15.255".parse().unwrap(), "中国|广东省|广州市|中国电信|CN"),
        ("8.8.8.0".parse().unwrap(), "8.8.8.255".parse().unwrap(), "United States|California|0|Google LLC|US"),
    ]);
    geoip::set(Some(geoip::GeoDb::from_bytes(db).unwrap()));
}

#[tokio::test]
async fn ip_stats_with_regions_and_lan() {
    install_geo();
    let t = T::new().await;
    let s = t.share(json!({"paths": ["/local/pub/a.txt"]})).await;
    let c = code(&s);
    for ip in ["1.0.1.7", "1.0.1.7", "1.0.9.1", "8.8.8.8", "192.168.1.20", "10.1.2.3", "127.0.0.1"] {
        let r = t.anon(&format!("/api/s/{c}"), ip, &[]).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    }
    let st = t.adm("GET", "/api/stats/access?scope=shares", None).await.json();
    let geo = &st["summary"]["geo"];
    assert_eq!(geo["db"], true);
    let by = geo["by_country"].as_array().unwrap();
    let find = |k: &str| by.iter().find(|x| x["code"] == k).cloned().unwrap_or(Value::Null);
    assert_eq!(find("CN")["count"], 3, "{geo}");
    assert_eq!(find("CN")["ips"], 2);
    assert_eq!(find("US")["count"], 1);
    assert_eq!(find("LAN")["count"], 3);
    assert_eq!(find("LAN")["name"], "局域网");
    let regions = geo["by_region"].as_array().unwrap();
    assert!(regions.iter().any(|r| r["region"] == "福建省" && r["count"] == 2), "{regions:?}");
    assert!(regions.iter().any(|r| r["region"] == "广东省" && r["count"] == 1));
    // rows carry a region label; top ips carry the full lookup
    let rows = st["rows"].as_array().unwrap();
    assert!(rows.iter().any(|r| r["ip"] == "192.168.1.20" && r["geo"] == "局域网"));
    assert!(rows.iter().any(|r| r["ip"] == "1.0.1.7" && r["geo"] == "中国 · 福建省 · 福州市"));
    let top = st["summary"]["top_ips"].as_array().unwrap();
    assert_eq!(top[0]["ip"], "1.0.1.7");
    assert_eq!(top[0]["geo"]["isp"], "中国电信");

    // region filters
    let cn = t.adm("GET", "/api/stats/access?country=CN", None).await.json();
    assert_eq!(cn["total"], 3);
    let fj = t.adm("GET", &format!("/api/stats/access?country=CN&region={}", "%E7%A6%8F%E5%BB%BA%E7%9C%81"), None).await.json();
    assert_eq!(fj["total"], 2);
    let lan = t.adm("GET", "/api/stats/access?country=LAN", None).await.json();
    assert_eq!(lan["total"], 3);
    let none = t.adm("GET", "/api/stats/access?country=JP", None).await.json();
    assert_eq!(none["total"], 0);

    // per-IP table
    let ips = t.adm("GET", "/api/stats/ips?per_page=2", None).await.json();
    assert_eq!(ips["total"], 6);
    assert_eq!(ips["rows"].as_array().unwrap().len(), 2);
    let first = &ips["rows"][0];
    assert_eq!(first["ip"], "1.0.1.7");
    assert_eq!(first["events"], 2);
    assert_eq!(first["visits"], 2);
    assert_eq!(first["shares"], 1);
    assert_eq!(first["geo"]["region"], "福建省");
    assert!(first["last_ts"].as_i64().unwrap() >= first["first_ts"].as_i64().unwrap());
    let p2 = t.adm("GET", "/api/stats/ips?per_page=2&page=3", None).await.json();
    assert_eq!(p2["rows"].as_array().unwrap().len(), 2);
    let lan_ips = t.adm("GET", "/api/stats/ips?country=LAN", None).await.json();
    assert_eq!(lan_ips["total"], 3);
    assert!(lan_ips["rows"].as_array().unwrap().iter().all(|r| r["geo"]["code"] == "LAN"));
    let by_last = t.adm("GET", "/api/stats/ips?sort=last", None).await.json();
    assert_eq!(by_last["rows"].as_array().unwrap().len(), 6);

    // a plain user only sees IPs of their own shares
    t.adm("POST", "/api/admin/users", Some(json!({"username": "bob", "password": "bob-pass-12", "role": "user"}))).await;
    let r = t.call("POST", "/api/auth/login", None, Some(json!({"login": "bob", "password": "bob-pass-12"}))).await;
    let bob = r.json()["access_token"].as_str().unwrap().to_string();
    let r = t.call("GET", "/api/stats/ips", Some(&bob), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["total"], 0);
}

#[tokio::test]
async fn share_delete_is_final_after_undo_window() {
    // the web client defers DELETE until the undo window ends; the API itself must make the
    // share unreachable immediately once DELETE arrives and keep it listed until then
    let t = T::new().await;
    let s = t.share(json!({"paths": ["/local/pub/a.txt"]})).await;
    let c = code(&s);
    let id = s["id"].as_i64().unwrap();
    let list = t.adm("GET", "/api/shares", None).await.json();
    assert!(list.as_array().unwrap().iter().any(|x| x["id"] == id));
    t.adm("DELETE", &format!("/api/shares/{id}"), None).await;
    let list = t.adm("GET", "/api/shares", None).await.json();
    assert!(!list.as_array().unwrap().iter().any(|x| x["id"] == id));
    let r = t.anon(&format!("/api/s/{c}"), "1.0.1.7", &[]).await;
    assert!(r.status.is_client_error(), "{}", r.status);
}
