//! PikPak driver against an in-process mock of the PikPak user/drive/OSS APIs.
use axum::{
    body::Bytes as AxBytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use bytes::Bytes;
use drivehub_storage::{build_driver, drivers::pikpak, ByteRange, StorageDriver};
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug)]
struct Obj {
    id: String,
    parent: String,
    name: String,
    dir: bool,
    data: Vec<u8>,
    trashed: bool,
}

#[derive(Default)]
struct Mock {
    objs: Vec<Obj>,
    next: u64,
    access: String,
    expire_once: bool,
    logins: u32,
    refreshes: u32,
    captcha_inits: u32,
    pending: HashMap<String, String>, // oss key -> file id
    base: String,
}
type S = Arc<Mutex<Mock>>;

fn file_json(o: &Obj) -> Value {
    json!({"id": o.id, "name": o.name, "kind": if o.dir {"drive#folder"} else {"drive#file"},
        "size": o.data.len().to_string(), "modified_time": "2026-11-19T04:00:00.000+08:00"})
}

fn authed(m: &mut Mock, h: &HeaderMap) -> Option<Json<Value>> {
    let tok = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if m.expire_once {
        m.expire_once = false;
        return Some(Json(json!({"error_code": 16, "error": "unauthenticated"})));
    }
    if tok != format!("Bearer {}", m.access)
        || h.get("x-captcha-token")
            .map(|v| v.is_empty())
            .unwrap_or(true)
    {
        return Some(Json(json!({"error_code": 4122, "error": "token invalid"})));
    }
    None
}

async fn captcha(State(s): State<S>, Json(b): Json<Value>) -> Json<Value> {
    let mut m = s.lock().unwrap();
    m.captcha_inits += 1;
    assert!(b["meta"]["captcha_sign"]
        .as_str()
        .unwrap()
        .starts_with("1."));
    assert_eq!(b["client_id"], "YUMx5nI8ZU8Ap8pm");
    Json(json!({"captcha_token": format!("ct{}", m.captcha_inits), "expires_in": 300}))
}

async fn signin(State(s): State<S>, Json(b): Json<Value>) -> Json<Value> {
    let mut m = s.lock().unwrap();
    if b["username"] != "u@example.com"
        || b["password"] != "pw"
        || b["captcha_token"].as_str().unwrap_or("").is_empty()
    {
        return Json(json!({"error_code": 4002, "error": "invalid_account_or_password"}));
    }
    m.logins += 1;
    m.access = format!("at{}", m.logins);
    Json(json!({"access_token": m.access, "refresh_token": "rt", "sub": "uid1"}))
}

async fn token(State(s): State<S>, Json(b): Json<Value>) -> Json<Value> {
    let mut m = s.lock().unwrap();
    if b["refresh_token"] != "rt" {
        return Json(json!({"error_code": 4126, "error": "invalid_grant"}));
    }
    m.refreshes += 1;
    m.access = format!("rf{}", m.refreshes);
    Json(json!({"access_token": m.access, "refresh_token": "rt", "sub": "uid1"}))
}

async fn list(
    State(s): State<S>,
    h: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let mut m = s.lock().unwrap();
    if let Some(e) = authed(&mut m, &h) {
        return e;
    }
    let pid = q.get("parent_id").cloned().unwrap_or_default();
    let kids: Vec<Value> = m
        .objs
        .iter()
        .filter(|o| o.parent == pid && !o.trashed)
        .map(file_json)
        .collect();
    // two pages to exercise pagination
    let page = q.get("page_token").cloned().unwrap_or_default();
    let (a, b) = kids.split_at(kids.len() / 2);
    if page.is_empty() && !a.is_empty() {
        Json(json!({"files": a, "next_page_token": "p2"}))
    } else if page == "p2" {
        Json(json!({"files": b, "next_page_token": ""}))
    } else {
        Json(json!({"files": kids, "next_page_token": ""}))
    }
}

async fn create(State(s): State<S>, h: HeaderMap, Json(b): Json<Value>) -> Json<Value> {
    let mut m = s.lock().unwrap();
    if let Some(e) = authed(&mut m, &h) {
        return e;
    }
    m.next += 1;
    let id = format!("f{}", m.next);
    let dir = b["kind"] == "drive#folder";
    let o = Obj {
        id: id.clone(),
        parent: b["parent_id"].as_str().unwrap().into(),
        name: b["name"].as_str().unwrap().into(),
        dir,
        data: vec![],
        trashed: !dir,
    };
    m.objs.push(o.clone());
    if dir {
        return Json(json!({"file": file_json(&o)}));
    }
    let key = format!("k/{id}");
    m.pending.insert(key.clone(), id.clone());
    Json(
        json!({"file": file_json(&o), "resumable": {"kind": "drive#resumable", "provider": "PROVIDER_ALIYUN",
        "params": {"access_key_id": "AK", "access_key_secret": "SK", "bucket": "bkt", "endpoint": "oss.example", "key": key, "security_token": "STS"}}}),
    )
}

async fn oss(
    State(s): State<S>,
    Path((bucket, key)): Path<(String, String)>,
    h: HeaderMap,
    body: AxBytes,
) -> StatusCode {
    let mut m = s.lock().unwrap();
    assert_eq!(bucket, "bkt");
    assert!(h["authorization"].to_str().unwrap().starts_with("OSS AK:"));
    assert_eq!(h["x-oss-security-token"], "STS");
    let Some(id) = m.pending.remove(&key) else {
        return StatusCode::NOT_FOUND;
    };
    let o = m.objs.iter_mut().find(|o| o.id == id).unwrap();
    o.data = body.to_vec();
    o.trashed = false;
    StatusCode::OK
}

async fn one(State(s): State<S>, h: HeaderMap, Path(id): Path<String>) -> Json<Value> {
    let mut m = s.lock().unwrap();
    if let Some(e) = authed(&mut m, &h) {
        return e;
    }
    let base = m.base.clone();
    match m.objs.iter().find(|o| o.id == id && !o.trashed) {
        Some(o) => {
            let mut v = file_json(o);
            v["web_content_link"] = json!(format!("{base}/dl/{id}"));
            Json(v)
        }
        None => Json(json!({"error_code": 3, "error": "file_not_found"})),
    }
}

async fn patch(
    State(s): State<S>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<Value>,
) -> Json<Value> {
    let mut m = s.lock().unwrap();
    if let Some(e) = authed(&mut m, &h) {
        return e;
    }
    let o = m.objs.iter_mut().find(|o| o.id == id).unwrap();
    o.name = b["name"].as_str().unwrap().into();
    Json(file_json(o))
}

fn subtree(m: &Mock, id: &str) -> Vec<Obj> {
    let mut out = vec![];
    for o in m.objs.iter().filter(|o| o.parent == id && !o.trashed) {
        out.push(o.clone());
        out.extend(subtree(m, &o.id));
    }
    out
}

async fn batch(
    State(s): State<S>,
    h: HeaderMap,
    Path(op): Path<String>,
    Json(b): Json<Value>,
) -> Json<Value> {
    let mut m = s.lock().unwrap();
    if let Some(e) = authed(&mut m, &h) {
        return e;
    }
    let ids: Vec<String> = b["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let to = b["to"]["parent_id"].as_str().unwrap_or("").to_string();
    for id in ids {
        match op.as_str() {
            "files:batchTrash" => m
                .objs
                .iter_mut()
                .filter(|o| o.id == id)
                .for_each(|o| o.trashed = true),
            "files:batchMove" => m
                .objs
                .iter_mut()
                .filter(|o| o.id == id)
                .for_each(|o| o.parent = to.clone()),
            "files:batchCopy" => {
                let src = m.objs.iter().find(|o| o.id == id).unwrap().clone();
                let mut map: HashMap<String, String> = HashMap::new();
                let mut todo = vec![src.clone()];
                todo.extend(subtree(&m, &src.id));
                for o in todo {
                    m.next += 1;
                    let nid = format!("f{}", m.next);
                    let parent = if o.id == src.id {
                        to.clone()
                    } else {
                        map[&o.parent].clone()
                    };
                    map.insert(o.id.clone(), nid.clone());
                    m.objs.push(Obj {
                        id: nid,
                        parent,
                        ..o
                    });
                }
            }
            _ => panic!("op {op}"),
        }
    }
    Json(json!({}))
}

async fn dl(State(s): State<S>, Path(id): Path<String>, h: HeaderMap) -> impl IntoResponse {
    let m = s.lock().unwrap();
    let data = m.objs.iter().find(|o| o.id == id).unwrap().data.clone();
    if let Some(r) = h.get("range").and_then(|v| v.to_str().ok()) {
        let r = r.trim_start_matches("bytes=");
        let (a, b) = r.split_once('-').unwrap();
        let a: usize = a.parse().unwrap();
        let b: usize = if b.is_empty() {
            data.len() - 1
        } else {
            b.parse().unwrap()
        };
        return (
            StatusCode::PARTIAL_CONTENT,
            data[a..=b.min(data.len() - 1)].to_vec(),
        );
    }
    (StatusCode::OK, data)
}

async fn files_post(st: State<S>, h: HeaderMap, p: Path<String>, b: Json<Value>) -> Json<Value> {
    batch(st, h, p, b).await
}

async fn start() -> (S, String) {
    let s: S = Arc::new(Mutex::new(Mock::default()));
    let app = Router::new()
        .route("/v1/shield/captcha/init", post(captcha))
        .route("/v1/auth/signin", post(signin))
        .route("/v1/auth/token", post(token))
        .route("/drive/v1/files", get(list).post(create))
        .route("/drive/v1/files/{id}", get(one).patch(patch))
        .route("/drive/v1/{op}", post(files_post))
        .route("/oss/{bucket}/{*key}", put(oss))
        .route("/dl/{id}", get(dl))
        .with_state(s.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    s.lock().unwrap().base = base.clone();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (s, base)
}

fn opts(base: &str, extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut o: HashMap<String, String> = [
        ("username", "u@example.com"),
        ("password", "pw"),
        ("user_endpoint", base),
        ("api_endpoint", base),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    o.insert("oss_endpoint".into(), format!("{base}/oss"));
    for (k, v) in extra {
        o.insert(k.to_string(), v.to_string());
    }
    o
}

async fn collect(s: drivehub_storage::ByteStream) -> Vec<u8> {
    s.map(|c| c.unwrap().to_vec())
        .collect::<Vec<_>>()
        .await
        .concat()
}

/// Same conformance sequence the fs/s3/webdav drivers are held to in lib.rs.
async fn conformance(drv: &dyn StorageDriver) {
    drv.mkdir("t/sub").await.unwrap();
    drv.write("t/x.txt", Bytes::from_static(b"0123456789"))
        .await
        .unwrap();
    assert_eq!(drv.stat("t/x.txt").await.unwrap().size, 10);
    let part = collect(
        drv.read(
            "t/x.txt",
            Some(ByteRange {
                start: 2,
                end: Some(5),
            }),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(part, b"234");
    let tail = collect(
        drv.read(
            "t/x.txt",
            Some(ByteRange {
                start: 7,
                end: None,
            }),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(tail, b"789");
    assert_eq!(
        collect(drv.read("t/x.txt", None).await.unwrap()).await,
        b"0123456789"
    );
    let chunks: Vec<std::io::Result<Bytes>> = vec![
        Ok(Bytes::from(vec![1u8; 300_000])),
        Ok(Bytes::from(vec![2u8; 100_000])),
    ];
    let n = drv
        .write_stream(
            "t/sub/multi.bin",
            futures::stream::iter(chunks).boxed(),
            &|_| {},
        )
        .await
        .unwrap();
    assert_eq!(n, 400_000);
    assert_eq!(drv.stat("t/sub/multi.bin").await.unwrap().size, 400_000);
    let names: Vec<String> = drv
        .list("t")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert!(
        names.contains(&"x.txt".into()) && names.contains(&"sub".into()),
        "{names:?}"
    );
    assert_eq!(drv.list_recursive("t").await.unwrap().len(), 3);
    drv.copy("t/x.txt", "t/y.txt").await.unwrap();
    drv.rename("t/y.txt", "t/z.txt").await.unwrap();
    drv.r#move("t/z.txt", "t/sub/z2.txt").await.unwrap();
    assert_eq!(
        collect(drv.read("t/sub/z2.txt", None).await.unwrap()).await,
        b"0123456789"
    );
    assert!(drv.stat("t/z.txt").await.is_err());
    // overwrite
    drv.write("t/x.txt", Bytes::from_static(b"abc"))
        .await
        .unwrap();
    assert_eq!(drv.stat("t/x.txt").await.unwrap().size, 3);
    assert!(drv
        .link("t/x.txt", Duration::from_secs(60))
        .await
        .unwrap()
        .is_some());
    drv.delete("t").await.unwrap();
    assert!(drv.stat("t").await.is_err());
    assert!(drv.list("").await.unwrap().is_empty());
}

#[tokio::test]
async fn pikpak_conformance_against_mock() {
    let (s, base) = start().await;
    let drv = build_driver("pikpak", &opts(&base, &[])).unwrap();
    assert_eq!(drv.kind(), "pikpak");
    conformance(drv.as_ref()).await;
    let m = s.lock().unwrap();
    assert_eq!(m.logins, 1);
    assert!(m.captcha_inits >= 2);
}

#[tokio::test]
async fn pikpak_token_refresh_and_relogin() {
    let (s, base) = start().await;
    let drv = build_driver("pikpak", &opts(&base, &[])).unwrap();
    drv.mkdir("a").await.unwrap();
    s.lock().unwrap().expire_once = true; // next call answers error_code 16
    assert_eq!(drv.list("").await.unwrap().len(), 1);
    assert_eq!(s.lock().unwrap().refreshes, 1);
    // invalid refresh_token -> 4126 -> falls back to password login
    let drv2 = build_driver("pikpak", &opts(&base, &[("refresh_token", "bad")])).unwrap();
    assert_eq!(drv2.list("").await.unwrap().len(), 1);
    assert_eq!(s.lock().unwrap().logins, 2);
    // bad password surfaces an error
    let bad = build_driver("pikpak", &opts(&base, &[("password", "nope")])).unwrap();
    assert!(bad.list("").await.is_err());
}

#[test]
fn pikpak_helpers() {
    // gcid: empty input = sha1 of nothing over zero blocks
    assert_eq!(
        pikpak::gcid(b""),
        "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709"
    );
    assert_eq!(pikpak::gcid(b"abc").len(), 40);
    let s = pikpak::captcha_sign(
        "YUMx5nI8ZU8Ap8pm",
        "2.0.0",
        "mypikpak.com",
        "dev",
        "1",
        &["a", "b"],
    );
    let expect = format!(
        "1.{}",
        pikpak::md5_hex(&format!(
            "{}b",
            pikpak::md5_hex("YUMx5nI8ZU8Ap8pm2.0.0mypikpak.comdev1a")
        ))
    );
    assert_eq!(s, expect);
    assert!(build_driver("pikpak", &HashMap::new()).is_err());
}

/// Live PikPak test; runs only with DRIVEHUB_TEST_PIKPAK_USER / _PASS (optional _PLATFORM).
/// Works under a scratch folder `drivehub-live-test/` and cross-copies to a local fs mount.
#[tokio::test]
async fn pikpak_live_if_configured() {
    let (Ok(u), Ok(p)) = (
        std::env::var("DRIVEHUB_TEST_PIKPAK_USER"),
        std::env::var("DRIVEHUB_TEST_PIKPAK_PASS"),
    ) else {
        return;
    };
    let mut o = HashMap::from([("username".to_string(), u), ("password".to_string(), p)]);
    if let Ok(pl) = std::env::var("DRIVEHUB_TEST_PIKPAK_PLATFORM") {
        o.insert("platform".into(), pl);
    }
    let drv = build_driver("pikpak", &o).unwrap();
    drv.list("").await.unwrap();
    let root = "drivehub-live-test";
    drv.delete(root).await.unwrap();
    drv.mkdir(root).await.unwrap();
    let data: Vec<u8> = (0..2_000_000u32).map(|i| (i % 251) as u8).collect();
    drv.write(&format!("{root}/a.bin"), Bytes::from(data.clone()))
        .await
        .unwrap();
    assert_eq!(
        drv.stat(&format!("{root}/a.bin")).await.unwrap().size,
        data.len() as u64
    );
    let part = collect(
        drv.read(
            &format!("{root}/a.bin"),
            Some(ByteRange {
                start: 1000,
                end: Some(1100),
            }),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(part, &data[1000..1100]);
    drv.copy(&format!("{root}/a.bin"), &format!("{root}/b.bin"))
        .await
        .unwrap();
    drv.rename(&format!("{root}/b.bin"), &format!("{root}/c.bin"))
        .await
        .unwrap();
    // cross-storage copy pikpak -> fs
    let tmp = tempfile::tempdir().unwrap();
    let fs = build_driver(
        "fs",
        &HashMap::from([("root".to_string(), tmp.path().to_string_lossy().to_string())]),
    )
    .unwrap();
    let s = drv.read(&format!("{root}/c.bin"), None).await.unwrap();
    assert_eq!(
        fs.write_stream("c.bin", s, &|_| {}).await.unwrap(),
        data.len() as u64
    );
    // fs -> pikpak
    let s = fs.read("c.bin", None).await.unwrap();
    drv.write_stream(&format!("{root}/d.bin"), s, &|_| {})
        .await
        .unwrap();
    assert_eq!(
        drv.stat(&format!("{root}/d.bin")).await.unwrap().size,
        data.len() as u64
    );
    drv.delete(root).await.unwrap();
}
