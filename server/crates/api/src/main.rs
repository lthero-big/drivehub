use drivehub_api::update::install::{self, Pending, MAX_BOOT_ATTEMPTS};
use drivehub_api::update::{self, Restart};
use drivehub_api::{connect, router, ApiDoc, AppState};
use drivehub_core::config::Config;
use std::future::IntoFuture;
use utoipa::OpenApi;

/// Grace period for in-flight requests when restarting into a new version.
const DRAIN_SECS: u64 = 10;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // drivehub openapi  -> print the OpenAPI contract (used by CI and client generators)
    if args.first().map(String::as_str) == Some("openapi") {
        println!("{}", ApiDoc::openapi().to_pretty_json()?);
        return Ok(());
    }
    // drivehub version | release … | update docker-swap …
    if let Some(r) = update::cli::dispatch(&args).await {
        return r;
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
    let data_dir = cfg.data_dir.clone();

    // A pending upgrade: count boots of the new binary; give up after MAX_BOOT_ATTEMPTS.
    let pending = Pending::load(&data_dir).filter(|p| p.state == "restarting");
    if let Some(mut p) = pending.clone() {
        p.boot_attempts += 1;
        let _ = p.save(&data_dir);
        tracing::info!(to = %p.to_version, attempt = p.boot_attempts, "booting freshly installed version");
        if p.boot_attempts > MAX_BOOT_ATTEMPTS {
            p.rollback_and_restart(&data_dir, "new version failed to start repeatedly");
        }
    }
    let fault = drivehub_core::version::fault();
    if fault.as_deref() == Some("crash") {
        anyhow::bail!("injected startup crash (DRIVEHUB_BUILD_FAULT=crash)");
    }
    let db = match connect(&cfg.database_url()).await.and_then(|db| {
        if fault.as_deref() == Some("migrate") {
            anyhow::bail!("injected migration failure (DRIVEHUB_BUILD_FAULT=migrate)")
        }
        Ok(db)
    }) {
        Ok(db) => db,
        Err(e) => {
            if let Some(p) = pending {
                p.rollback_and_restart(&data_dir, &format!("database migration failed: {e:#}"));
            }
            return Err(e);
        }
    };
    let state = match AppState::new(db, Some(&cfg.data_dir)).await {
        Ok(s) => s,
        Err(e) => {
            if let Some(p) = pending {
                p.rollback_and_restart(&data_dir, &format!("startup failed: {e:#}"));
            }
            return Err(e);
        }
    };
    state
        .updater
        .configure(cfg.update.clone(), &cfg.bind, &cfg.database_url());
    let app = router(state.clone(), cfg.web_dir.clone());
    let listener = match tokio::net::TcpListener::bind(&cfg.bind).await {
        Ok(l) => l,
        Err(e) => {
            if let Some(p) = pending {
                state.db.close().await;
                p.rollback_and_restart(&data_dir, &format!("cannot listen on {}: {e}", cfg.bind));
            }
            return Err(e.into());
        }
    };
    tracing::info!(bind = %cfg.bind, version = drivehub_core::version::server_version(), "drivehub listening");
    state.updater.resume(update::local_base(&cfg.bind)).await;
    state.updater.spawn_background();

    let mut rx = state.updater.restart_rx();
    let serve = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = rx.wait_for(|r| r.is_some()) => {}
        }
    });
    let mut rx2 = state.updater.restart_rx();
    tokio::select! {
        r = serve.into_future() => r?,
        _ = async move {
            let _ = rx2.wait_for(|r| r.is_some()).await;
            tokio::time::sleep(std::time::Duration::from_secs(DRAIN_SECS)).await;
        } => tracing::warn!("in-flight requests did not finish within {DRAIN_SECS}s; restarting anyway"),
    }
    match state.updater.restart_request() {
        None => Ok(()),
        Some(Restart::Upgrade) => {
            state.audit_log.flush().await;
            state.db.close().await;
            let p = Pending::load(&data_dir);
            let exe = p
                .as_ref()
                .map(|p| p.exe_path.clone())
                .or_else(|| std::env::current_exe().ok())
                .unwrap();
            install::restart(&exe, &cfg.update.restart)
        }
        Some(Restart::Rollback(reason)) => {
            state.audit_log.flush().await;
            state.db.close().await;
            match Pending::load(&data_dir) {
                Some(p) => p.rollback_and_restart(&data_dir, &reason),
                None => anyhow::bail!("rollback requested without an update marker: {reason}"),
            }
        }
    }
}
