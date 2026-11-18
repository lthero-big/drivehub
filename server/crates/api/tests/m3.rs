//! M3 web-support API tests (DEPTAI-476): resumable upload sessions, streaming zip, download headers.
use axum::body::Body;
use axum::http::{Request, StatusCode};
use drivehub_api::{connect, router, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
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

async fn put_chunk(c: &Ctx, id: &str, off: u64, data: &[u8]) -> (StatusCode, Value) {
    let r = Request::put(format!("/api/fs/uploads/{id}?offset={off}"))
        .body(Body::from(data.to_vec()))
        .unwrap();
    let (s, _, b) = raw(c, r).await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

async fn get_bytes(c: &Ctx, uri: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    raw(c, Request::get(uri).body(Body::empty()).unwrap()).await
}

#[tokio::test]
async fn chunked_upload_resume_and_complete() {
    let c = ctx().await;
    let data: Vec<u8> = (0..20_000u32).map(|i| (i % 251) as u8).collect();
    let (s, v) = req(
        &c,
        "POST",
        "/api/fs/uploads",
        Some(json!({"path": "/local/dir/big.bin", "size": data.len()})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["offset"], 0);
    let (s, v) = put_chunk(&c, &id, 0, &data[..7000]).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["offset"], 7000);
    // wrong offset (e.g. a retried chunk) → 409, state unchanged
    let (s, _) = put_chunk(&c, &id, 0, &data[..7000]).await;
    assert_eq!(s, StatusCode::CONFLICT);
    // "reload": ask the server where to resume
    let (s, v) = req(&c, "GET", &format!("/api/fs/uploads/{id}"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["offset"], 7000);
    // completing early is refused
    let (s, _) = req(&c, "POST", &format!("/api/fs/uploads/{id}/complete"), None).await;
    assert_eq!(s, StatusCode::CONFLICT);
    // overflow is refused and rolled back
    let mut too_much = data[7000..].to_vec();
    too_much.push(1);
    let (s, _) = put_chunk(&c, &id, 7000, &too_much).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (_, v) = req(&c, "GET", &format!("/api/fs/uploads/{id}"), None).await;
    assert_eq!(v["offset"], 7000);
    let (s, v) = put_chunk(&c, &id, 7000, &data[7000..]).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["offset"], data.len());
    let (s, v) = req(&c, "POST", &format!("/api/fs/uploads/{id}/complete"), None).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["path"], "/local/dir/big.bin");
    assert_eq!(v["size"], data.len());
    let (s, _, b) = get_bytes(&c, "/api/fs/download?path=/local/dir/big.bin").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b, data);
    // session is gone
    let (s, _) = req(&c, "GET", &format!("/api/fs/uploads/{id}"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // bogus ids never touch the filesystem
    let (s, _) = req(&c, "GET", "/api/fs/uploads/..%2F..%2Fetc", None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn upload_session_cancel_and_conflict() {
    let c = ctx().await;
    upload(&c, "/local/keep.txt", b"keep").await;
    let (s, _) = req(
        &c,
        "POST",
        "/api/fs/uploads",
        Some(json!({"path": "/local/keep.txt", "size": 3, "overwrite": false})),
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, v) = req(
        &c,
        "POST",
        "/api/fs/uploads",
        Some(json!({"path": "/local/x.txt", "size": 3})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let id = v["id"].as_str().unwrap().to_string();
    let (s, _) = req(&c, "DELETE", &format!("/api/fs/uploads/{id}"), None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = req(&c, "GET", &format!("/api/fs/uploads/{id}"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

fn u16le(b: &[u8], i: usize) -> usize {
    u16::from_le_bytes([b[i], b[i + 1]]) as usize
}
fn u32le(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// Minimal zip reader over the central directory: (name, crc, size, data).
fn unzip(z: &[u8]) -> Vec<(String, Vec<u8>)> {
    let e = z.len() - 22;
    assert_eq!(u32le(z, e), 0x0605_4b50);
    let n = u16le(z, e + 10);
    let mut p = u32le(z, e + 16) as usize;
    let mut out = vec![];
    for _ in 0..n {
        assert_eq!(u32le(z, p), 0x0201_4b50);
        let crc = u32le(z, p + 16);
        let size = u32le(z, p + 24) as usize;
        let nl = u16le(z, p + 28);
        let lho = u32le(z, p + 42) as usize;
        let name = String::from_utf8(z[p + 46..p + 46 + nl].to_vec()).unwrap();
        assert_eq!(u32le(z, lho), 0x0403_4b50);
        let data_at = lho + 30 + u16le(z, lho + 26) + u16le(z, lho + 28);
        let data = z[data_at..data_at + size].to_vec();
        assert_eq!(crc32fast::hash(&data), crc, "crc of {name}");
        out.push((name, data));
        p += 46 + nl;
    }
    out
}

#[tokio::test]
async fn zip_streams_folders_and_files() {
    let c = ctx().await;
    upload(&c, "/local/pack/a.txt", b"alpha").await;
    upload(&c, "/local/pack/sub/中文.md", b"# hi").await;
    upload(&c, "/local/pack/sub/empty.txt", b"").await;
    upload(&c, "/local/solo.txt", b"solo").await;
    let paths = enc("/local/pack\n/local/solo.txt");
    let (s, h, b) = get_bytes(&c, &format!("/api/fs/zip?paths={paths}&name=bundle")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h["content-type"], "application/zip");
    assert!(h["content-disposition"]
        .to_str()
        .unwrap()
        .contains("bundle.zip"));
    let mut files = unzip(&b);
    files.sort();
    let names: Vec<_> = files.iter().map(|f| f.0.as_str()).collect();
    assert_eq!(
        names,
        [
            "pack/a.txt",
            "pack/sub/empty.txt",
            "pack/sub/中文.md",
            "solo.txt"
        ]
    );
    assert_eq!(files[0].1, b"alpha");
    assert_eq!(files[3].1, b"solo");
    let (s, _, _) = get_bytes(&c, "/api/fs/zip?paths=").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn download_sandboxes_active_content() {
    let c = ctx().await;
    upload(&c, "/local/x.html", b"<script>alert(1)</script>").await;
    upload(&c, "/local/x.png", b"\x89PNG").await;
    upload(&c, "/local/x.mkv", b"..").await;
    let (_, h, _) = get_bytes(&c, "/api/fs/download?path=/local/x.html").await;
    assert!(h["content-security-policy"]
        .to_str()
        .unwrap()
        .starts_with("sandbox"));
    assert_eq!(h["x-content-type-options"], "nosniff");
    let (_, h, _) = get_bytes(&c, "/api/fs/download?path=/local/x.png").await;
    assert!(h.get("content-security-policy").is_none());
    assert_eq!(h["content-type"], "image/png");
    let (_, h, _) = get_bytes(&c, "/api/fs/download?path=/local/x.mkv").await;
    assert_eq!(h["content-type"], "video/x-matroska");
}

#[tokio::test]
async fn upload_session_requires_permission() {
    let c = ctx().await;
    let (s, _) = req(
        &c,
        "POST",
        "/api/auth/init",
        Some(json!({"username": "admin", "password": "password123"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = req(
        &c,
        "POST",
        "/api/fs/uploads",
        Some(json!({"path": "/local/x.bin", "size": 1})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _, _) = get_bytes(&c, "/api/fs/zip?paths=/local").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn openapi_has_m3_paths() {
    let c = ctx().await;
    let (_, v) = req(&c, "GET", "/api/openapi.json", None).await;
    for p in [
        "/api/fs/uploads",
        "/api/fs/uploads/{id}",
        "/api/fs/uploads/{id}/complete",
        "/api/fs/zip",
    ] {
        assert!(v["paths"][p].is_object(), "{p}");
    }
}

#[tokio::test]
async fn editing_mount_keeps_masked_secrets() {
    let c = ctx().await;
    let body = json!({"name": "dav", "kind": "webdav", "options": {"endpoint": "http://127.0.0.1:9", "username": "u", "password": "s3cret"}});
    let (s, _) = req(&c, "POST", "/api/mounts", Some(body)).await;
    assert_eq!(s, StatusCode::OK);
    let (_, v) = req(&c, "GET", "/api/mounts", None).await;
    let m = v
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "dav")
        .unwrap()
        .clone();
    assert_eq!(m["options"]["password"], "***");
    let mut edited = m.clone();
    edited["read_only"] = json!(true);
    let (s, _) = req(&c, "POST", "/api/mounts", Some(edited)).await;
    assert_eq!(s, StatusCode::OK);
    let kept = c
        .state
        .vfs
        .mounts()
        .iter()
        .find(|m| m.cfg.name == "dav")
        .unwrap()
        .cfg
        .clone();
    assert_eq!(kept.options["password"], "s3cret");
    assert!(kept.read_only);
}
