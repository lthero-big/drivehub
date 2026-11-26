//! DEPTAI-485 round 5: categorized fine-grained permissions (rename / move / copy / tag /
//! share_upload + delegated admin capabilities), tags, access statistics and share fixes
//! (upload only for folder shares, enable/disable toggle).
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
    _st: AppState,
    _dir: tempfile::TempDir,
    admin: String,
}

struct Resp {
    status: StatusCode,
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

impl T {
    async fn new() -> T {
        let db = connect("sqlite::memory:").await.unwrap();
        let st = AppState::new(db, None).await.unwrap();
        st.auth.set_mailer(Arc::new(LogMailer::default()));
        let dir = tempfile::tempdir().unwrap();
        let app = router(st.clone(), None);
        let mut t = T {
            app,
            _st: st,
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
            ("team/a.txt", "alpha"),
            ("team/b.txt", "bravo"),
            ("team/sub/c.txt", "charlie"),
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
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Resp { status, body }
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

    async fn adm(&self, method: &str, uri: &str, body: Option<Value>) -> Value {
        let r = self
            .call(method, uri, Some(&self.admin.clone()), body)
            .await;
        assert!(
            r.status.is_success(),
            "{method} {uri}: {} {}",
            r.status,
            r.text()
        );
        r.json()
    }

    /// Creates a plain user and returns (id, access token).
    async fn user(&self, name: &str) -> (i64, String) {
        let u = self
            .adm("POST", "/api/admin/users", Some(json!({"username": name, "email": format!("{name}@example.com"), "password": format!("{name}-pass-1"), "role": "user"})))
            .await;
        let r = self
            .call(
                "POST",
                "/api/auth/login",
                None,
                Some(json!({"login": name, "password": format!("{name}-pass-1")})),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        (
            u["id"].as_i64().unwrap(),
            r.json()["access_token"].as_str().unwrap().to_string(),
        )
    }

    async fn rule(&self, uid: i64, path: &str, allow: &[&str]) {
        self.adm(
            "POST",
            "/api/acl/rules",
            Some(json!({"path": path, "subject": "user", "subject_id": uid, "allow": allow})),
        )
        .await;
    }

    async fn role(&self, name: &str, perms: &[&str]) -> i64 {
        self.adm(
            "POST",
            "/api/admin/roles",
            Some(json!({"name": name, "permissions": perms})),
        )
        .await["id"]
            .as_i64()
            .unwrap()
    }
}

#[tokio::test]
async fn catalog_lists_categorized_permissions() {
    let t = T::new().await;
    let r = t.call("GET", "/api/acl/catalog", None, None).await;
    assert_eq!(r.status, StatusCode::OK);
    let c = r.json();
    let perms = c["permissions"].as_array().unwrap();
    assert_eq!(perms.len(), 20);
    let cats: Vec<&str> = c["categories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    assert_eq!(cats, ["file", "share", "tag", "admin"]);
    for (n, cat, global) in [
        ("rename", "file", false),
        ("move", "file", false),
        ("share_upload", "share", false),
        ("share_manage", "share", true),
        ("tag", "tag", false),
        ("admin_users", "admin", true),
        ("admin_audit", "admin", true),
    ] {
        let p = perms
            .iter()
            .find(|p| p["name"] == n)
            .unwrap_or_else(|| panic!("{n}"));
        assert_eq!(p["category"], cat, "{n}");
        assert_eq!(p["global"], global, "{n}");
    }
    // builtin roles were migrated: editor (old "edit") gained rename + move, viewer gained tag
    let roles = t.adm("GET", "/api/admin/roles", None).await;
    let get = |n: &str| {
        roles
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == n)
            .unwrap()["permissions"]
            .clone()
    };
    let ed = get("editor");
    for p in ["rename", "move", "copy", "tag"] {
        assert!(
            ed.as_array().unwrap().iter().any(|x| x == p),
            "editor lacks {p}: {ed}"
        );
    }
    assert!(get("viewer").as_array().unwrap().iter().any(|x| x == "tag"));
    assert!(!get("manager")
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x == "admin_users"));
}

#[tokio::test]
async fn rename_move_copy_tag_need_their_own_bits() {
    let t = T::new().await;
    let (bob, tok) = t.user("bob").await;
    // edit without rename / move: neither works any more
    t.rule(
        bob,
        "/local/team",
        &["read", "download", "upload", "create", "edit"],
    )
    .await;
    let ren = json!({"path": "/local/team/a.txt", "new_name": "a2.txt"});
    let r = t
        .call("POST", "/api/fs/rename", Some(&tok), Some(ren.clone()))
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    assert!(r.text().contains("rename"), "{}", r.text());
    let mv = json!({"src": "/local/team/b.txt", "dst": "/local/team/sub/b.txt"});
    let r = t
        .call("POST", "/api/fs/move", Some(&tok), Some(mv.clone()))
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    let cp = json!({"src": "/local/team/b.txt", "dst": "/local/team/sub/b-copy.txt"});
    let r = t
        .call("POST", "/api/fs/copy", Some(&tok), Some(cp.clone()))
        .await;
    assert_eq!(
        r.status,
        StatusCode::FORBIDDEN,
        "copy needs copy: {}",
        r.text()
    );
    let tag = json!({"paths": ["/local/team/a.txt"], "add_names": ["urgent"]});
    let r = t
        .call("POST", "/api/tags/assign", Some(&tok), Some(tag.clone()))
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    // grant them
    t.rule(bob, "/local/team", &["rename", "move", "copy", "tag"])
        .await;
    let r = t
        .call("POST", "/api/fs/rename", Some(&tok), Some(ren))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = t.call("POST", "/api/fs/copy", Some(&tok), Some(cp)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = t
        .call(
            "POST",
            "/api/tags/assign",
            Some(&tok),
            Some(json!({"paths": ["/local/team/b.txt"], "add_names": ["urgent"]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = t.call("POST", "/api/fs/move", Some(&tok), Some(mv)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // the tag followed the move
    let r = t
        .call(
            "GET",
            "/api/tags/of?path=/local/team/sub/b.txt",
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(
        r.json()["/local/team/sub/b.txt"][0]["name"],
        "urgent",
        "{}",
        r.text()
    );
}

#[tokio::test]
async fn delegated_admin_capabilities_are_enforced() {
    let t = T::new().await;
    let (carol, tok) = t.user("carol").await;
    // nothing delegated: every admin area is forbidden, caps empty
    for u in [
        "/api/admin/users",
        "/api/admin/roles",
        "/api/admin/audit",
        "/api/admin/settings",
        "/api/acl/rules?path=/",
    ] {
        let r = t.call("GET", u, Some(&tok), None).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{u}: {}", r.text());
    }
    assert_eq!(
        t.call("GET", "/api/auth/me", Some(&tok), None).await.json()["caps"],
        json!([])
    );
    // a "user manager" role (root level) gives exactly user management
    let rid = t.role("user-manager", &["admin_users"]).await;
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{carol}"),
        Some(json!({"roles": [rid]})),
    )
    .await;
    let me = t.call("GET", "/api/auth/me", Some(&tok), None).await.json();
    assert_eq!(me["caps"], json!(["admin_users"]));
    let st = t
        .call("GET", "/api/auth/status", Some(&tok), None)
        .await
        .json();
    assert_eq!(st["me"]["caps"], json!(["admin_users"]));
    let r = t.call("GET", "/api/admin/users", Some(&tok), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = t
        .call(
            "POST",
            "/api/admin/users",
            Some(&tok),
            Some(json!({"username": "dave", "password": "dave-pass-1"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let dave = r.json()["id"].as_i64().unwrap();
    // …but no escalation: cannot create / promote admins or touch the admin account
    let r = t
        .call(
            "POST",
            "/api/admin/users",
            Some(&tok),
            Some(json!({"username": "eve", "password": "eve-pass-1", "role": "admin"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t
        .call(
            "PATCH",
            &format!("/api/admin/users/{dave}"),
            Some(&tok),
            Some(json!({"role": "admin"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t
        .call(
            "PATCH",
            "/api/admin/users/1",
            Some(&tok),
            Some(json!({"disabled": true})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // other areas stay closed
    for u in [
        "/api/admin/audit",
        "/api/admin/settings",
        "/api/acl/rules?path=/",
    ] {
        assert_eq!(
            t.call("GET", u, Some(&tok), None).await.status,
            StatusCode::FORBIDDEN,
            "{u}"
        );
    }
    // role managers cannot hand out capabilities they do not hold
    let rid2 = t.role("role-manager", &["admin_roles"]).await;
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{carol}"),
        Some(json!({"roles": [rid, rid2]})),
    )
    .await;
    let r = t
        .call(
            "POST",
            "/api/admin/roles",
            Some(&tok),
            Some(json!({"name": "x", "permissions": ["admin_settings"]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    let r = t
        .call(
            "POST",
            "/api/admin/roles",
            Some(&tok),
            Some(json!({"name": "x", "permissions": ["read", "admin_users"]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // audit capability opens audit + full access statistics
    let rid3 = t.role("auditor", &["admin_audit"]).await;
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{carol}"),
        Some(json!({"roles": [rid3]})),
    )
    .await;
    assert_eq!(
        t.call("GET", "/api/admin/audit", Some(&tok), None)
            .await
            .status,
        StatusCode::OK
    );
    let s = t
        .call("GET", "/api/stats/access?scope=files", Some(&tok), None)
        .await
        .json();
    assert_eq!(s["scope"], "files");
    assert_eq!(
        t.call("GET", "/api/admin/users", Some(&tok), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    // global caps only count at the root: a deeper rule does not grant admin_users
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{carol}"),
        Some(json!({"roles": []})),
    )
    .await;
    t.rule(carol, "/local/team", &["read", "admin_users"]).await;
    assert_eq!(
        t.call("GET", "/api/admin/users", Some(&tok), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn upload_only_for_folder_shares_and_toggle() {
    let t = T::new().await;
    // file share cannot be upload, neither on create nor by patch
    let r = t
        .call(
            "POST",
            "/api/shares",
            Some(&t.admin.clone()),
            Some(json!({"paths": ["/local/team/a.txt"], "perm": "upload"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let s = t
        .adm(
            "POST",
            "/api/shares",
            Some(json!({"paths": ["/local/team/a.txt"], "perm": "download"})),
        )
        .await;
    let id = s["id"].as_i64().unwrap();
    let r = t
        .call(
            "PATCH",
            &format!("/api/shares/{id}"),
            Some(&t.admin.clone()),
            Some(json!({"perm": "upload"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text());
    // toggle off / on
    let v = t
        .adm(
            "PATCH",
            &format!("/api/shares/{id}"),
            Some(json!({"revoked": true})),
        )
        .await;
    assert_eq!(v["status"], "revoked");
    let v = t
        .adm(
            "PATCH",
            &format!("/api/shares/{id}"),
            Some(json!({"revoked": false})),
        )
        .await;
    assert_eq!(v["status"], "active");
    // folder share may become upload
    let f = t
        .adm(
            "POST",
            "/api/shares",
            Some(json!({"paths": ["/local/inbox"], "perm": "download"})),
        )
        .await;
    let v = t
        .adm(
            "PATCH",
            &format!("/api/shares/{}", f["id"]),
            Some(json!({"perm": "upload"})),
        )
        .await;
    assert_eq!(v["perm"], "upload");
    // a user with share + upload but without share_upload cannot create collect shares
    let (bob, tok) = t.user("bob").await;
    t.adm("POST", "/api/acl/rules", Some(json!({"path": "/local/inbox", "subject": "user", "subject_id": bob, "allow": ["read", "download", "upload", "share"]}))).await;
    let r = t
        .call(
            "POST",
            "/api/shares",
            Some(&tok),
            Some(json!({"paths": ["/local/inbox"], "perm": "upload"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    t.adm("POST", "/api/acl/rules", Some(json!({"path": "/local/inbox", "subject": "user", "subject_id": bob, "allow": ["share_upload"]}))).await;
    let r = t
        .call(
            "POST",
            "/api/shares",
            Some(&tok),
            Some(json!({"paths": ["/local/inbox"], "perm": "upload"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // bob cannot see the admin's shares without share_manage
    let r = t
        .call("GET", &format!("/api/shares/{id}"), Some(&tok), None)
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let rid = t.role("share-admin", &["share_manage"]).await;
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{bob}"),
        Some(json!({"roles": [rid]})),
    )
    .await;
    let r = t
        .call("GET", &format!("/api/shares/{id}"), Some(&tok), None)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

#[tokio::test]
async fn tags_crud_filter_and_delete_cleanup() {
    let t = T::new().await;
    let a = t
        .adm(
            "POST",
            "/api/tags",
            Some(json!({"name": "work", "color": "blue"})),
        )
        .await;
    let r = t
        .call(
            "POST",
            "/api/tags",
            Some(&t.admin.clone()),
            Some(json!({"name": "bad", "color": "neon"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let aid = a["id"].as_i64().unwrap();
    t.adm(
        "POST",
        "/api/tags/assign",
        Some(json!({"paths": ["/local/team/a.txt", "/local/team/b.txt"], "add": [aid]})),
    )
    .await;
    t.adm(
        "POST",
        "/api/tags/assign",
        Some(json!({"paths": ["/local/team/b.txt"], "add_names": ["home"]})),
    )
    .await;
    let list = t.adm("GET", "/api/tags", None).await;
    let work = list
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "work")
        .unwrap()
        .clone();
    assert_eq!(work["count"], 2);
    let home = list
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "home")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let any = t
        .adm("GET", &format!("/api/tags/files?tags={aid},{home}"), None)
        .await;
    assert_eq!(any.as_array().unwrap().len(), 2);
    let all = t
        .adm(
            "GET",
            &format!("/api/tags/files?tags={aid},{home}&mode=all"),
            None,
        )
        .await;
    assert_eq!(all.as_array().unwrap().len(), 1);
    assert_eq!(all[0]["path"], "/local/team/b.txt");
    let of = t.adm("GET", "/api/tags/of?dir=/local/team", None).await;
    assert_eq!(of["/local/team/b.txt"].as_array().unwrap().len(), 2);
    // tags are private per user
    let (_bob, tok) = t.user("bob").await;
    let r = t.call("GET", "/api/tags", Some(&tok), None).await;
    assert_eq!(r.json(), json!([]));
    // deleting the file drops its tags
    let r = t
        .call(
            "POST",
            "/api/fs/delete",
            Some(&t.admin.clone()),
            Some(json!({"path": "/local/team/b.txt"})),
        )
        .await;
    assert!(r.status.is_success(), "{} {}", r.status, r.text());
    let any = t
        .adm("GET", &format!("/api/tags/files?tags={aid},{home}"), None)
        .await;
    assert_eq!(any.as_array().unwrap().len(), 1);
    t.adm("DELETE", &format!("/api/tags/{home}"), None).await;
    assert_eq!(
        t.adm("GET", "/api/tags", None)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn access_stats_filters() {
    let t = T::new().await;
    let s = t
        .adm(
            "POST",
            "/api/shares",
            Some(json!({"paths": ["/local/team/a.txt"], "perm": "download"})),
        )
        .await;
    let code = s["code"].as_str().unwrap().to_string();
    for ip in ["10.0.0.1", "10.0.0.2", "10.0.0.2"] {
        let r = t
            .raw(
                Request::get(format!("/api/s/{code}"))
                    .header("x-forwarded-for", ip)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert!(r.status.is_success(), "{} {}", r.status, r.text());
    }
    let all = t.adm("GET", "/api/stats/access", None).await;
    assert!(all["summary"]["visits"].as_i64().unwrap() >= 3, "{all}");
    assert_eq!(all["summary"]["unique_ips"], 2);
    let one = t.adm("GET", "/api/stats/access?ip=10.0.0.2", None).await;
    assert_eq!(one["summary"]["visits"], 2, "{one}");
    let by_share = t
        .adm(
            "GET",
            &format!("/api/stats/access?share_id={}&kind=visit", s["id"]),
            None,
        )
        .await;
    assert!(by_share["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["share_id"] == s["id"]));
    let future = t
        .adm("GET", "/api/stats/access?from=4102444800", None)
        .await;
    assert_eq!(future["summary"]["events"], 0);
    // plain users only see their own shares
    let (_bob, tok) = t.user("bob").await;
    let mine = t
        .call("GET", "/api/stats/access", Some(&tok), None)
        .await
        .json();
    assert_eq!(mine["summary"]["events"], 0, "{mine}");
}

/// Merge of r5 delegated caps with main's unified level roles (DEPTAI-464r): a delegated
/// user / group / role manager can never grant the admin level through roles or groups.
#[tokio::test]
async fn delegated_managers_cannot_grant_admin_level() {
    let t = T::new().await;
    let (carol, tok) = t.user("carol").await;
    let (dave, _) = t.user("dave").await;
    let roles = t.adm("GET", "/api/admin/roles", None).await;
    let admin_role = roles
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["level"] == "admin")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let rid = t
        .role("mgr", &["admin_users", "admin_groups", "admin_roles"])
        .await;
    t.adm(
        "PATCH",
        &format!("/api/admin/users/{carol}"),
        Some(json!({"roles": [rid]})),
    )
    .await;
    // direct admin-level role
    let r = t
        .call(
            "PATCH",
            &format!("/api/admin/users/{dave}"),
            Some(&tok),
            Some(json!({"roles": [admin_role]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    // admin group membership
    let g = t
        .adm("POST", "/api/admin/groups", Some(json!({"name": "admins"})))
        .await["id"]
        .as_i64()
        .unwrap();
    t.adm(
        "PATCH",
        &format!("/api/admin/groups/{g}"),
        Some(json!({"roles": [admin_role]})),
    )
    .await;
    let r = t
        .call(
            "PATCH",
            &format!("/api/admin/users/{dave}"),
            Some(&tok),
            Some(json!({"groups": [g]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    let r = t
        .call(
            "PATCH",
            &format!("/api/admin/groups/{g}"),
            Some(&tok),
            Some(json!({"members": [carol]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    let r = t
        .call(
            "DELETE",
            &format!("/api/admin/groups/{g}"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    // giving a plain group the admin role
    let g2 = t
        .adm("POST", "/api/admin/groups", Some(json!({"name": "plain"})))
        .await["id"]
        .as_i64()
        .unwrap();
    let r = t
        .call(
            "PATCH",
            &format!("/api/admin/groups/{g2}"),
            Some(&tok),
            Some(json!({"roles": [admin_role]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    // editing the admin role itself
    let r = t
        .call(
            "PATCH",
            &format!("/api/admin/roles/{admin_role}"),
            Some(&tok),
            Some(json!({"name": "admin", "permissions": []})),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
    // ordinary management still works
    let r = t
        .call(
            "PATCH",
            &format!("/api/admin/groups/{g2}"),
            Some(&tok),
            Some(json!({"members": [dave]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let me = t.call("GET", "/api/auth/me", Some(&tok), None).await.json();
    assert_ne!(me["role"], "admin");
}
