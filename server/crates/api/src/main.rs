use drivehub_api::{connect, router, ApiDoc, AppState};
use drivehub_core::config::Config;
use utoipa::OpenApi;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // drivehub openapi  -> print the OpenAPI contract (used by CI and client generators)
    if std::env::args().nth(1).as_deref() == Some("openapi") {
        println!("{}", ApiDoc::openapi().to_pretty_json()?);
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let cfg_path = std::env::var("DRIVEHUB_CONFIG")
        .ok()
        .map(std::path::PathBuf::from);
    let cfg = Config::load(cfg_path.as_deref())?;
    std::fs::create_dir_all(&cfg.data_dir)?;
    let db = connect(&cfg.database_url()).await?;
    let state = AppState::new(db, Some(&cfg.data_dir)).await?;
    let app = router(state, cfg.web_dir.clone());
    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    tracing::info!(bind = %cfg.bind, "drivehub listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
