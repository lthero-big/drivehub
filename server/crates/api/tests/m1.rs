//! M1 API integration tests: mounts, unified tree, file ops, Range, tasks, search.
use axum::body::Body;
use axum::http::{Request, StatusCode};
use drivehub_api::{AppState, connect, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Ctx {
    app: axum::Router,
    state: AppState,
    _dirs: Vec<tempfile::TempDir>,
    a: String,
    b: String,
}

async fn ctx() -> Ctx {
    let db = connect("sqlite::memory:").await.unwrap();
    let state = AppState::new(db, None).await.unwrap();
    let (da, dbb) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let app = router(state.clone(), None);
    let c = Ctx {
        app,
        state,
        a: da.path().display().to_string(),
        b: dbb.path().display().to_string(),
        _dirs: vec![da, dbb],
    };
    for (name, root, extra) in [
        ("local", &c.a, json!({})),
        ("backup", &c.b, json!({"sort_order": -1})),
    ] {
        let mut body = json!({"name": name, "kind": "fs", "options": {"root": root}});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (s, _) = req(&c, "POST", "/api/mounts", Some(body)).await;
        assert_eq!(s, StatusCode::OK);
    }
    c
}

async fn raw(c: &Ctx, r: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let res = c.app.clone().oneshot(r).await.unwrap();
    let (s, h) = (res.status(), res.headers().clone());
    (
        s,
        h,
        res.into_body().collect().await.unwrap().to_bytes().to_vec(),
    )
}

async fn req(c: &Ctx, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let b = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    let r = b
        .body(
            body.map(|v| Body::from(v.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    let (s, _, bytes) = raw(c, r).await;
    (s, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn upload(c: &Ctx, path: &str, data: &[u8]) -> (StatusCode, Value) {
    let r = Request::put(format!("/api/fs/upload?path={}", enc(path)))
        .body(Body::from(data.to_vec()))
        .unwrap();
    let (s, _, b) = raw(c, r).await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"/-._".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[tokio::test]
async fn root_lists_mounts_sorted_and_hides_hidden() {
    let c = ctx().await;
    let (_, v) = req(
        &c,
        "POST",
        "/api/mounts",
        Some(json!({"name": "secret", "kind": "fs", "options": {"root": c.a}, "hidden": true})),
    )
    .await;
    assert_eq!(v["ok"], true);
    let (s, v) = req(&c, "GET", "/api/fs/list?path=/", None).await;
    assert_eq!(s, StatusCode::OK);
    let names: Vec<&str> = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["backup", "local"]); // sort_order -1 first, hidden excluded
    let (_, v) = req(&c, "GET", "/api/mounts", None).await;
    assert_eq!(v.as_array().unwrap().len(), 3);
    req(&c, "POST", "/api/mounts", Some(json!({"name": "s3x", "kind": "s3", "options": {"bucket": "b", "endpoint": "http://127.0.0.1:1", "secret_access_key": "TOPSECRET"}}))).await;
    let (_, v) = req(&c, "GET", "/api/mounts", None).await;
    assert!(!v.to_string().contains("TOPSECRET"));
    let (s, _) = req(
        &c,
        "POST",
        "/api/mounts",
        Some(json!({"name": "bad", "kind": "nope", "options": {}})),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_IMPLEMENTED);
    let (s, _) = req(&c, "DELETE", "/api/mounts/secret", None).await;
    assert_eq!(s, StatusCode::OK);
}

fn item_names(v: &Value) -> Vec<String> {
    v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn disabled_mount_excluded_until_enabled() {
    let c = ctx().await;
    let (s, _) = req(
        &c,
        "POST",
        "/api/mounts",
        Some(json!({"name": "parked", "kind": "fs", "options": {"root": c.a}, "enabled": false})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let (_, v) = req(&c, "GET", "/api/fs/list?path=/", None).await;
    let n = item_names(&v);
    assert!(!n.iter().any(|x| x == "parked"), "{n:?}");
    assert!(n.iter().any(|x| x == "local"), "{n:?}");

    let (_, v) = req(&c, "GET", "/api/mounts", None).await;
    let parked = v
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "parked")
        .expect("parked in admin list");
    assert_eq!(parked["enabled"], false);

    let (s, _) = req(&c, "GET", "/api/fs/list?path=/parked", None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    let (s, _) = req(
        &c,
        "POST",
        "/api/mounts",
        Some(json!({"name": "fresh", "kind": "fs", "options": {"root": c.b}})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (_, v) = req(&c, "GET", "/api/mounts", None).await;
    let fresh = v
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "fresh")
        .expect("fresh in admin list");
    assert_eq!(fresh["enabled"], true);
    let (_, v) = req(&c, "GET", "/api/fs/list?path=/", None).await;
    let n = item_names(&v);
    assert!(n.iter().any(|x| x == "fresh"), "{n:?}");

    let (s, _) = req(
        &c,
        "POST",
        "/api/mounts",
        Some(json!({"name": "parked", "kind": "fs", "options": {"root": c.a}, "enabled": true})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (_, v) = req(&c, "GET", "/api/fs/list?path=/", None).await;
    let n = item_names(&v);
    assert!(n.iter().any(|x| x == "parked"), "{n:?}");
}

#[tokio::test]
async fn upload_list_stat_range_download() {
    let c = ctx().await;
    let (s, v) = upload(&c, "/local/docs/你好 世界.txt", b"0123456789abcdef").await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["size"], 16);
    for i in 0..5 {
        upload(&c, &format!("/local/docs/f{i}.bin"), &vec![0u8; i * 10]).await;
    }
    let (_, v) = req(
        &c,
        "GET",
        "/api/fs/list?path=/local/docs&per_page=2&page=2&sort=size&order=desc",
        None,
    )
    .await;
    assert_eq!(v["total"], 6);
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    assert_eq!(v["items"][0]["name"], "f2.bin");
    assert_eq!(v["items"][1]["size"], 16);
    let (_, v) = req(&c, "GET", "/api/fs/stat?path=/local/docs", None).await;
    assert_eq!(v["is_dir"], true);
    let p = enc("/local/docs/你好 世界.txt");
    let r = Request::get(format!("/api/fs/download?path={p}"))
        .header("range", "bytes=10-13")
        .body(Body::empty())
        .unwrap();
    let (s, h, b) = raw(&c, r).await;
    assert_eq!(s, StatusCode::PARTIAL_CONTENT);
    assert_eq!(b, b"abcd");
    assert_eq!(h["content-range"], "bytes 10-13/16");
    let r = Request::get(format!("/api/fs/download?path={p}"))
        .header("range", "bytes=-3")
        .body(Body::empty())
        .unwrap();
    assert_eq!(raw(&c, r).await.2, b"def");
    let r = Request::get(format!("/api/fs/download?path={p}"))
        .header("range", "bytes=99-")
        .body(Body::empty())
        .unwrap();
    assert_eq!(raw(&c, r).await.0, StatusCode::RANGE_NOT_SATISFIABLE);
    let r = Request::get(format!("/api/fs/download?path={p}"))
        .body(Body::empty())
        .unwrap();
    let (s, h, b) = raw(&c, r).await;
    assert_eq!((s, b.len()), (StatusCode::OK, 16));
    assert_eq!(h["accept-ranges"], "bytes");
    let (s, _) = req(&c, "GET", "/api/fs/stat?path=/local/nope", None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = req(&c, "GET", "/api/fs/stat?path=/local/../etc", None).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn list_cache_ttl_and_refresh() {
    let c = ctx().await;
    upload(&c, "/local/a.txt", b"a").await;
    let (_, v) = req(&c, "GET", "/api/fs/list?path=/local", None).await;
    assert_eq!(v["total"], 1);
    std::fs::write(format!("{}/outside.txt", c.a), b"x").unwrap(); // change behind our back
    let (_, v) = req(&c, "GET", "/api/fs/list?path=/local", None).await;
    assert_eq!(v["total"], 1, "served from cache");
    let (_, v) = req(&c, "GET", "/api/fs/list?path=/local&refresh=true", None).await;
    assert_eq!(v["total"], 2);
}

#[tokio::test]
async fn mkdir_rename_copy_move_delete_same_mount() {
    let c = ctx().await;
    assert_eq!(
        req(
            &c,
            "POST",
            "/api/fs/mkdir",
            Some(json!({"path": "/local/x/y"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    upload(&c, "/local/x/y/f.txt", b"hello").await;
    assert_eq!(
        req(
            &c,
            "POST",
            "/api/fs/rename",
            Some(json!({"path": "/local/x/y/f.txt", "new_name": "g.txt"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, v) = req(
        &c,
        "POST",
        "/api/fs/copy",
        Some(json!({"src": "/local/x", "dst": "/local/x2"})),
    )
    .await;
    assert!(v["task_id"].is_null());
    assert_eq!(
        std::fs::read(format!("{}/x2/y/g.txt", c.a)).unwrap(),
        b"hello"
    );
    req(
        &c,
        "POST",
        "/api/fs/move",
        Some(json!({"src": "/local/x2/y/g.txt", "dst": "/local/moved.txt"})),
    )
    .await;
    assert!(std::path::Path::new(&format!("{}/moved.txt", c.a)).exists());
    assert_eq!(
        req(
            &c,
            "POST",
            "/api/fs/copy",
            Some(json!({"src": "/local/x", "dst": "/local/x/inner"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        req(
            &c,
            "POST",
            "/api/fs/delete",
            Some(json!({"path": "/local/x"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(!std::path::Path::new(&format!("{}/x", c.a)).exists());
    assert_eq!(
        req(
            &c,
            "POST",
            "/api/fs/delete",
            Some(json!({"path": "/local"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn read_only_mount_rejects_writes() {
    let c = ctx().await;
    req(
        &c,
        "POST",
        "/api/mounts",
        Some(json!({"name": "ro", "kind": "fs", "options": {"root": c.a}, "read_only": true})),
    )
    .await;
    assert_eq!(upload(&c, "/ro/a.txt", b"x").await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        req(&c, "POST", "/api/fs/mkdir", Some(json!({"path": "/ro/d"})))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

async fn wait_task(c: &Ctx, id: i64) -> Value {
    for _ in 0..100 {
        let (_, v) = req(c, "GET", &format!("/api/tasks/{id}"), None).await;
        if v["status"] == "done" || v["status"] == "failed" {
            return v;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("task {id} did not finish");
}

#[tokio::test]
async fn cross_mount_copy_and_move_are_background_tasks() {
    let c = ctx().await;
    upload(&c, "/local/d/a.txt", b"aaaa").await;
    upload(&c, "/local/d/sub/b.txt", b"bb").await;
    let (_, v) = req(
        &c,
        "POST",
        "/api/fs/copy",
        Some(json!({"src": "/local/d", "dst": "/backup/d"})),
    )
    .await;
    let id = v["task_id"].as_i64().expect("task id");
    let t = wait_task(&c, id).await;
    assert_eq!(t["status"], "done", "{t}");
    assert_eq!(
        (t["total_bytes"].as_i64(), t["done_bytes"].as_i64()),
        (Some(6), Some(6))
    );
    assert_eq!(
        std::fs::read(format!("{}/d/sub/b.txt", c.b)).unwrap(),
        b"bb"
    );
    let (_, v) = req(
        &c,
        "POST",
        "/api/fs/move",
        Some(json!({"src": "/local/d/a.txt", "dst": "/backup/a-moved.txt"})),
    )
    .await;
    let t = wait_task(&c, v["task_id"].as_i64().unwrap()).await;
    assert_eq!(t["status"], "done");
    assert!(!std::path::Path::new(&format!("{}/d/a.txt", c.a)).exists());
    assert_eq!(
        std::fs::read(format!("{}/a-moved.txt", c.b)).unwrap(),
        b"aaaa"
    );
    let (_, v) = req(&c, "GET", "/api/tasks?status=done", None).await;
    assert_eq!(v.as_array().unwrap().len(), 2);
    let (_, v) = req(
        &c,
        "POST",
        "/api/fs/copy",
        Some(json!({"src": "/local/missing", "dst": "/backup/m"})),
    )
    .await;
    assert!(v["error"].is_string());
}

#[tokio::test]
async fn interrupted_tasks_resume_on_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (ra, rb) = (dir.path().join("a"), dir.path().join("b"));
    std::fs::create_dir_all(&ra).unwrap();
    std::fs::write(ra.join("big.bin"), vec![7u8; 1 << 20]).unwrap();
    let url = format!("sqlite://{}?mode=rwc", dir.path().join("t.db").display());
    let db = connect(&url).await.unwrap();
    for (n, r) in [("a", &ra), ("b", &rb)] {
        sqlx::query("INSERT INTO mounts (name, kind, options, created_at) VALUES (?, 'fs', ?, 0)")
            .bind(n)
            .bind(json!({"root": r.display().to_string()}).to_string())
            .execute(&db)
            .await
            .unwrap();
    }
    // simulate a crash mid-transfer
    sqlx::query("INSERT INTO tasks (kind, src, dst, status, done_bytes, created_at, updated_at) VALUES ('copy','/a/big.bin','/b/big.bin','running',123,0,0)")
        .execute(&db)
        .await
        .unwrap();
    let st = AppState::new(db, Some(dir.path())).await.unwrap();
    for _ in 0..100 {
        if let Some(t) = st.tasks.get(1).await.unwrap() {
            if t.status == "done" {
                assert_eq!(t.done_bytes, 1 << 20);
                assert_eq!(std::fs::read(rb.join("big.bin")).unwrap().len(), 1 << 20);
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("task not resumed");
}

#[tokio::test]
async fn search_keyword_filters_and_semantic_placeholder() {
    let c = ctx().await;
    upload(&c, "/local/工作/2024年度财务报告.pdf", &vec![1u8; 2048]).await;
    upload(&c, "/local/工作/会议纪要.docx", b"x").await;
    upload(&c, "/backup/old/财务报告-备份.pdf", b"y").await;
    let (_, v) = req(&c, "POST", "/api/search/reindex", None).await;
    assert_eq!(v["files"], 5, "{v}"); // 2 dirs + 3 files
    let (_, v) = req(&c, "GET", &format!("/api/search?q={}", enc("财务")), None).await;
    assert_eq!(v["total"], 2, "{v}");
    let (_, v) = req(
        &c,
        "GET",
        &format!("/api/search?q={}", enc("财务 size:>1k mount:local")),
        None,
    )
    .await;
    assert_eq!(v["total"], 1);
    assert_eq!(v["hits"][0]["path"], "/local/工作/2024年度财务报告.pdf");
    let (_, v) = req(&c, "GET", "/api/search?q=ext:docx", None).await;
    assert_eq!(v["total"], 1);
    let (_, v) = req(&c, "GET", "/api/search?q=x&mode=semantic", None).await;
    assert_eq!(v["enabled"], false);
    assert_eq!(
        req(&c, "GET", "/api/search?q=x&mode=bogus", None).await.0,
        StatusCode::BAD_REQUEST
    );
    // upload is indexed incrementally without reindex
    upload(&c, "/local/新发票.pdf", b"z").await;
    let (_, v) = req(&c, "GET", &format!("/api/search?q={}", enc("发票")), None).await;
    assert_eq!(v["total"], 1);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM files")
        .fetch_one(&c.state.db)
        .await
        .unwrap();
    assert!(n >= 6);
}

#[tokio::test]
async fn openapi_has_m1_paths() {
    let c = ctx().await;
    let (_, v) = req(&c, "GET", "/api/openapi.json", None).await;
    for p in [
        "/api/fs/list",
        "/api/fs/download",
        "/api/fs/upload",
        "/api/tasks",
        "/api/search",
        "/api/mounts",
    ] {
        assert!(v["paths"][p].is_object(), "{p}");
    }
}
