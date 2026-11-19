//! 115 driver against an in-process mock of webapi / proapi / passportapi (test RSA key).
use axum::{
    extract::{Form, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use drivehub_storage::{build_driver, drivers::p115::m115, ByteRange, StorageError};
use futures::StreamExt;
use num_bigint::BigUint;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const TEST_N: &str = "c475839b10ef98ed18ce804b2ffc2bb34abe17532e9bd1b3e0186d02d895a4a8ecd23d5e3d65c1d117a35fbaefb17bf4e61c095422fbf71bcfc570537a0e227b3896a689423d4c1d52e689e99f5af70fc110c5c687ddf754e7858248375419f08ed8328151eeaa24fe8dfa8c8d77a55bcd1c84523422fbe2a92fd80286de0507";
const TEST_D: &str = "562a5476868f0fbbadcda46755bc7c4e3ed1f0d902f044a168004e8f98fec9216dfd27fd55607409891c96b81eb8f16d101febd783208fd91adfb5cc67141bfaba40e42961d1e99c423b1673b8dcf1cc9852fda493a1b3c28ee6d583d4bb8b6e5e142122b93fc48f4a8fc6efbb76cce74f813db9bff5fb58bc1d7d3b6a43d4c1";
const COOKIE: &str = "UID=1_A1_1; CID=c; SEID=s; KID=k";

#[derive(Clone)]
struct Obj {
    id: String,
    parent: String,
    name: String,
    dir: bool,
    data: Vec<u8>,
}
#[derive(Default)]
struct Mock {
    objs: Vec<Obj>,
    next: u64,
    base: String,
}
type S = Arc<Mutex<Mock>>;

fn private_op(input: &[u8]) -> Vec<u8> {
    let n = BigUint::parse_bytes(TEST_N.as_bytes(), 16).unwrap();
    let d = BigUint::parse_bytes(TEST_D.as_bytes(), 16).unwrap();
    let r = BigUint::from_bytes_be(input).modpow(&d, &n).to_bytes_be();
    let mut out = vec![0u8; 128 - r.len()];
    out.extend(r);
    out
}

/// Server side of m115: decrypt request -> (client key, json).
fn server_decode(data: &str) -> ([u8; 16], Vec<u8>) {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap();
    let mut plain = Vec::new();
    for c in raw.chunks(128) {
        let m = private_op(c);
        let i = m
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, b)| **b == 0)
            .unwrap()
            .0;
        plain.extend_from_slice(&m[i + 1..]);
    }
    let key: [u8; 16] = plain[..16].try_into().unwrap();
    let mut body = plain[16..].to_vec();
    m115::xor_transform(&mut body, &m115::XOR_CLIENT_KEY);
    body.reverse();
    m115::xor_transform(&mut body, &m115::derive_key(&key, 4));
    (key, body)
}

fn server_encode(plain: &[u8], key: &[u8; 16]) -> String {
    let k2 = [7u8; 16];
    let mut body = plain.to_vec();
    m115::xor_transform(&mut body, &m115::derive_key(key, 4));
    body.reverse();
    m115::xor_transform(&mut body, &m115::derive_key(&k2, 12));
    let mut buf = k2.to_vec();
    buf.extend(body);
    let mut out = Vec::new();
    for c in buf.chunks(128 - 11) {
        let mut m = vec![0u8, 1];
        m.extend(std::iter::repeat_n(0xffu8, 128 - c.len() - 3));
        m.push(0);
        m.extend_from_slice(c);
        out.extend(private_op(&m));
    }
    base64::engine::general_purpose::STANDARD.encode(out)
}

fn ok_cookie(h: &HeaderMap) -> bool {
    h.get("cookie").map(|v| v == COOKIE).unwrap_or(false)
}

async fn sso(h: HeaderMap) -> Json<Value> {
    Json(if ok_cookie(&h) {
        json!({"state": 0, "data": {"user_id": 1}})
    } else {
        json!({"state": 1, "code": 99})
    })
}

async fn files(
    State(s): State<S>,
    h: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    assert!(ok_cookie(&h));
    let m = s.lock().unwrap();
    let cid = q["cid"].clone();
    let off: usize = q["offset"].parse().unwrap();
    let lim: usize = q["limit"].parse().unwrap();
    let all: Vec<Value> = m.objs.iter().filter(|o| o.parent == cid).map(|o| {
        if o.dir { json!({"cid": o.id, "pid": o.parent, "n": o.name, "t": "1763520000"}) }
        else { json!({"fid": o.id, "cid": o.parent, "n": o.name, "s": o.data.len(), "pc": format!("pc{}", o.id), "te": "1763520000"}) }
    }).collect();
    let known = cid == "0" || m.objs.iter().any(|o| o.id == cid && o.dir);
    let page: Vec<Value> = all.iter().skip(off).take(lim).cloned().collect();
    Json(
        json!({"state": true, "cid": if known { cid.as_str() } else { "0" }, "count": all.len(), "offset": off, "data": page}),
    )
}

fn subtree(m: &Mock, id: &str) -> Vec<Obj> {
    let mut v = vec![];
    for o in m.objs.iter().filter(|o| o.parent == id) {
        v.push(o.clone());
        v.extend(subtree(m, &o.id));
    }
    v
}

async fn op(
    State(s): State<S>,
    Path(op): Path<String>,
    Form(f): Form<HashMap<String, String>>,
) -> Json<Value> {
    let mut m = s.lock().unwrap();
    match op.as_str() {
        "add" => {
            m.next += 1;
            let id = format!("{}", 100 + m.next);
            m.objs.push(Obj {
                id: id.clone(),
                parent: f["pid"].clone(),
                name: f["cname"].clone(),
                dir: true,
                data: vec![],
            });
            Json(json!({"state": true, "cid": id, "cname": f["cname"]}))
        }
        "move" => {
            let id = f["fid[0]"].clone();
            m.objs
                .iter_mut()
                .filter(|o| o.id == id)
                .for_each(|o| o.parent = f["pid"].clone());
            Json(json!({"state": true}))
        }
        "batch_rename" => {
            let id = f["fid"].clone();
            m.objs
                .iter_mut()
                .filter(|o| o.id == id)
                .for_each(|o| o.name = f[&format!("files_new_name[{id}]")].clone());
            Json(json!({"state": true}))
        }
        "copy" => {
            let src = m.objs.iter().find(|o| o.id == f["fid[0]"]).unwrap().clone();
            let mut todo = vec![src.clone()];
            todo.extend(subtree(&m, &src.id));
            let mut map: HashMap<String, String> = HashMap::new();
            for o in todo {
                m.next += 1;
                let nid = format!("{}", 100 + m.next);
                let parent = if o.id == src.id {
                    f["pid"].clone()
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
            Json(json!({"state": true}))
        }
        _ => Json(json!({"state": false, "errno": 1, "error": "bad op"})),
    }
}

async fn rb_delete(State(s): State<S>, Form(f): Form<HashMap<String, String>>) -> Json<Value> {
    let mut m = s.lock().unwrap();
    let id = f["fid[0]"].clone();
    let doomed: Vec<String> = std::iter::once(id.clone())
        .chain(subtree(&m, &id).into_iter().map(|o| o.id))
        .collect();
    m.objs.retain(|o| !doomed.contains(&o.id));
    Json(json!({"state": true}))
}

async fn downurl(
    State(s): State<S>,
    h: HeaderMap,
    Form(f): Form<HashMap<String, String>>,
) -> Json<Value> {
    assert_eq!(h["user-agent"], "Mozilla/5.0 115Browser/27.0.5.7");
    let (key, body) = server_decode(&f["data"]);
    let req: Value = serde_json::from_slice(&body).unwrap();
    let pc = req["pickcode"].as_str().unwrap().to_string();
    let m = s.lock().unwrap();
    let o = m.objs.iter().find(|o| format!("pc{}", o.id) == pc).unwrap();
    let info = json!({ o.id.clone(): {"file_name": o.name, "file_size": o.data.len().to_string(), "pick_code": pc,
        "url": {"url": format!("{}/dl/{}", m.base, o.id), "client": 1, "oss_id": "x"}}});
    Json(
        json!({"state": true, "msg": "", "data": server_encode(info.to_string().as_bytes(), &key)}),
    )
}

async fn dl(State(s): State<S>, h: HeaderMap, Path(id): Path<String>) -> impl IntoResponse {
    assert!(ok_cookie(&h));
    let m = s.lock().unwrap();
    let d = m.objs.iter().find(|o| o.id == id).unwrap().data.clone();
    if let Some(r) = h.get("range").and_then(|v| v.to_str().ok()) {
        let (a, b) = r.trim_start_matches("bytes=").split_once('-').unwrap();
        let a: usize = a.parse().unwrap();
        let b: usize = if b.is_empty() {
            d.len() - 1
        } else {
            b.parse().unwrap()
        };
        return (StatusCode::PARTIAL_CONTENT, d[a..=b].to_vec());
    }
    (StatusCode::OK, d)
}

async fn start() -> (S, String) {
    let s: S = Arc::new(Mutex::new(Mock::default()));
    s.lock().unwrap().objs.push(Obj {
        id: "f1".into(),
        parent: "0".into(),
        name: "hello.txt".into(),
        dir: false,
        data: b"0123456789".to_vec(),
    });
    let app = Router::new()
        .route("/app/1.0/web/1.0/check/sso", get(sso))
        .route("/files", get(files))
        .route("/files/{op}", post(op))
        .route("/rb/delete", post(rb_delete))
        .route("/app/chrome/downurl", post(downurl))
        .route("/dl/{id}", get(dl))
        .with_state(s.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    s.lock().unwrap().base = base.clone();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (s, base)
}

fn opts(base: &str, cookie: &str) -> HashMap<String, String> {
    [
        ("cookie", cookie),
        ("webapi_endpoint", base),
        ("proapi_endpoint", base),
        ("passport_endpoint", base),
        ("m115_n", TEST_N),
        ("page_size", "2"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

async fn collect(s: drivehub_storage::ByteStream) -> Vec<u8> {
    s.map(|c| c.unwrap().to_vec())
        .collect::<Vec<_>>()
        .await
        .concat()
}

#[test]
fn m115_roundtrip_with_test_key() {
    let rsa = m115::Rsa::new(TEST_N);
    let key = [3u8; 16];
    let payload = br#"{"pickcode":"abc123"}"#;
    let (k, body) = server_decode(&m115::encode(&rsa, payload, &key));
    assert_eq!(k, key);
    assert_eq!(body, payload);
    let long = vec![b'x'; 300]; // multi-block
    assert_eq!(
        m115::decode(&rsa, &server_encode(&long, &key), &key).unwrap(),
        long
    );
}

#[tokio::test]
async fn p115_conformance_against_mock() {
    let (_s, base) = start().await;
    let drv = build_driver("p115", &opts(&base, COOKIE)).unwrap();
    assert_eq!(drv.kind(), "p115");
    drv.mkdir("t/sub").await.unwrap();
    drv.mkdir("t/sub").await.unwrap(); // idempotent
    drv.copy("hello.txt", "t/x.txt").await.unwrap();
    assert_eq!(drv.stat("t/x.txt").await.unwrap().size, 10);
    assert_eq!(
        collect(
            drv.read(
                "t/x.txt",
                Some(ByteRange {
                    start: 2,
                    end: Some(5)
                })
            )
            .await
            .unwrap()
        )
        .await,
        b"234"
    );
    assert_eq!(
        collect(
            drv.read(
                "t/x.txt",
                Some(ByteRange {
                    start: 7,
                    end: None
                })
            )
            .await
            .unwrap()
        )
        .await,
        b"789"
    );
    assert_eq!(
        collect(drv.read("hello.txt", None).await.unwrap()).await,
        b"0123456789"
    );
    drv.copy("t/x.txt", "t/y.txt").await.unwrap();
    drv.copy("t/x.txt", "t/sub/w.txt").await.unwrap();
    drv.rename("t/y.txt", "t/z.txt").await.unwrap();
    drv.r#move("t/z.txt", "t/sub/z2.txt").await.unwrap();
    assert!(drv.stat("t/z.txt").await.is_err());
    let names: Vec<String> = drv
        .list("t/sub")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names.len(), 2, "{names:?}"); // pagination with page_size=2 + exact count
    assert_eq!(drv.list_recursive("t").await.unwrap().len(), 4);
    assert_eq!(drv.list("").await.unwrap().len(), 2);
    assert!(matches!(
        drv.write("t/n.txt", bytes::Bytes::from_static(b"x")).await,
        Err(StorageError::Unsupported(_))
    ));
    drv.delete("t").await.unwrap();
    assert!(drv.stat("t").await.is_err());
    assert_eq!(drv.list("").await.unwrap().len(), 1);
}

#[tokio::test]
async fn p115_bad_cookie_and_missing_cookie() {
    let (_s, base) = start().await;
    let drv = build_driver("115", &opts(&base, "UID=bad")).unwrap();
    assert!(matches!(drv.list("").await, Err(StorageError::Config(_))));
    assert!(build_driver("p115", &HashMap::new()).is_err());
}

/// Live 115 test (read-side; upload not ported); runs only with DRIVEHUB_TEST_115_COOKIE.
/// Optional DRIVEHUB_TEST_115_FILE = path of an existing file (>=100 bytes) to Range-read and copy to fs.
#[tokio::test]
async fn p115_live_if_configured() {
    let Ok(cookie) = std::env::var("DRIVEHUB_TEST_115_COOKIE") else {
        return;
    };
    let drv = build_driver("p115", &HashMap::from([("cookie".to_string(), cookie)])).unwrap();
    drv.list("").await.unwrap();
    let root = "drivehub-live-test";
    drv.delete(root).await.unwrap();
    drv.mkdir(&format!("{root}/sub")).await.unwrap();
    drv.rename(&format!("{root}/sub"), &format!("{root}/sub2"))
        .await
        .unwrap();
    if let Ok(f) = std::env::var("DRIVEHUB_TEST_115_FILE") {
        let part = collect(
            drv.read(
                &f,
                Some(ByteRange {
                    start: 10,
                    end: Some(110),
                }),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(part.len(), 100);
        let tmp = tempfile::tempdir().unwrap();
        let fs = build_driver(
            "fs",
            &HashMap::from([("root".to_string(), tmp.path().to_string_lossy().to_string())]),
        )
        .unwrap();
        let n = fs
            .write_stream("x", drv.read(&f, None).await.unwrap(), &|_| {})
            .await
            .unwrap();
        assert_eq!(n, drv.stat(&f).await.unwrap().size);
        drv.copy(&f, &format!("{root}/copy")).await.unwrap();
    }
    drv.delete(root).await.unwrap();
}
