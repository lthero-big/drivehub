use axum::body::Body;
use axum::http::{Request, StatusCode};
use drivehub_api::{connect, router, AppState};
use http_body_util::BodyExt;
use tower::ServiceExt;

async fn app() -> axum::Router {
    let db = connect("sqlite::memory:").await.unwrap();
    router(AppState { db }, None)
}

async fn call(req: Request<Body>) -> (StatusCode, serde_json::Value) {
    let res = app().await.oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
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
