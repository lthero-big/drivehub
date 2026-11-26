use axum::body::Body;
use axum::http::{Request, StatusCode};
use drivehub_api::{connect, router, AppState};
use http_body_util::BodyExt;
use tower::ServiceExt;

async fn app() -> axum::Router {
    let db = connect("sqlite::memory:").await.unwrap();
    router(AppState::new(db, None).await.unwrap(), None)
}

async fn call(req: Request<Body>) -> (StatusCode, serde_json::Value) {
    let (status, _headers, v) = call_full(req).await;
    (status, v)
}

async fn call_full(req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, serde_json::Value) {
    let res = app().await.oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn version_endpoint_returns_contract() {
    let (s, v) = call(Request::get("/api/version").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["api_version"], 1);
    assert!(v["min_app_version"].is_string());
}

#[tokio::test]
async fn health_checks_db() {
    let (s, v) = call(Request::get("/api/v1/health").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["db"], true);
}

#[tokio::test]
async fn old_app_gets_426_with_min_version() {
    let req = Request::get("/api/v1/health")
        .header("x-drivehub-client", "app/0.0.1")
        .body(Body::empty())
        .unwrap();
    let (s, v) = call(req).await;
    assert_eq!(s, StatusCode::UPGRADE_REQUIRED);
    assert_eq!(v["status"], "client_too_old");
    assert_eq!(v["min_version"], "0.1.0");
}

#[tokio::test]
async fn newer_api_major_means_server_too_old() {
    let req = Request::get("/api/v1/health")
        .header("x-drivehub-client", "app/0.1.0")
        .header("x-drivehub-api", "2")
        .body(Body::empty())
        .unwrap();
    let (s, v) = call(req).await;
    assert_eq!(s, StatusCode::UPGRADE_REQUIRED);
    assert_eq!(v["status"], "server_too_old");
}

#[tokio::test]
async fn openapi_lists_paths() {
    let (s, v) = call(
        Request::get("/api/openapi.json")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(v["paths"]["/api/version"].is_object());
    assert!(v["paths"]["/api/v1/health"].is_object());
}

#[tokio::test]
async fn version_and_health_advertise_server_version_header() {
    let (s, h, v) = call_full(Request::get("/api/version").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        h.get("x-drivehub-server-version")
            .unwrap()
            .to_str()
            .unwrap(),
        env!("CARGO_PKG_VERSION")
    );
    assert!(v["web_build"].is_null(), "no web_dir -> no web_build: {v}");

    let (s, h, _) = call_full(Request::get("/api/v1/health").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        h.get("x-drivehub-server-version")
            .unwrap()
            .to_str()
            .unwrap(),
        env!("CARGO_PKG_VERSION")
    );
}

#[tokio::test]
async fn version_reports_web_build_from_version_json() {
    let dir = std::env::temp_dir().join(format!(
        "dh-web-build-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("version.json"),
        r#"{"version":"0.2.0","build":"0.2.0+testhash"}"#,
    )
    .unwrap();
    let db = connect("sqlite::memory:").await.unwrap();
    let app = router(AppState::new(db, None).await.unwrap(), Some(dir.clone()));
    let res = app
        .oneshot(Request::get("/api/version").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["web_build"], "0.2.0+testhash");
    let _ = std::fs::remove_dir_all(&dir);
}
