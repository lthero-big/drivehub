use semver::Version;
use serde::Serialize;
use utoipa::ToSchema;

/// Release version shared by server / web / app (one semver for all). A release build can
/// stamp a different version with `DRIVEHUB_BUILD_VERSION=x.y.z cargo build` (used by the
/// release pipeline and by the auto-update end-to-end check to produce v_old / v_new).
pub const SERVER_VERSION: &str = match option_env!("DRIVEHUB_BUILD_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

/// Compile-time fault injection for update rollback drills (`DRIVEHUB_BUILD_FAULT=unhealthy`
/// or `migrate`). Never set for real releases.
pub const BUILD_FAULT: Option<&str> = option_env!("DRIVEHUB_BUILD_FAULT");

/// Effective running version. Debug builds additionally honour `DRIVEHUB_TEST_VERSION`
/// (integration tests run one binary as several versions); release builds ignore it.
pub fn server_version() -> &'static str {
    use std::sync::OnceLock;
    static V: OnceLock<String> = OnceLock::new();
    V.get_or_init(|| {
        if cfg!(debug_assertions) {
            if let Ok(v) = std::env::var("DRIVEHUB_TEST_VERSION") {
                if Version::parse(&v).is_ok() {
                    return v;
                }
            }
        }
        SERVER_VERSION.to_string()
    })
}

/// Active fault injection: compile-time `DRIVEHUB_BUILD_FAULT`, or (debug builds only)
/// runtime `DRIVEHUB_TEST_FAULT`.
pub fn fault() -> Option<String> {
    if let Some(f) = BUILD_FAULT {
        return Some(f.to_string());
    }
    if cfg!(debug_assertions) {
        return std::env::var("DRIVEHUB_TEST_FAULT")
            .ok()
            .filter(|v| !v.is_empty());
    }
    None
}

/// Major API contract version; bump only on breaking API changes.
pub const API_VERSION: u32 = 1;
/// Oldest Android app / web build this server still serves.
pub const MIN_APP_VERSION: &str = "0.1.0";
pub const MIN_WEB_VERSION: &str = "0.1.0";

/// Response of GET /api/version.
#[derive(Debug, Clone, Serialize, ToSchema, PartialEq)]
pub struct VersionInfo {
    pub server_version: String,
    pub api_version: u32,
    pub min_app_version: String,
    pub min_web_version: String,
    /// Latest release seen by the update checker (None = never checked / checks disabled).
    pub latest: Option<String>,
    /// `latest` is newer than `server_version`.
    pub update_available: bool,
    /// Minimum client version required by the latest release (falls back to this server's
    /// own `min_app_version`).
    pub min_client_version: String,
    /// Build id of the web bundle currently on disk (`<web_dir>/version.json`); a loaded
    /// page whose own build id differs should offer a reload.
    pub web_build: Option<String>,
}

impl VersionInfo {
    pub fn current() -> Self {
        Self {
            server_version: server_version().into(),
            api_version: API_VERSION,
            min_app_version: MIN_APP_VERSION.into(),
            min_web_version: MIN_WEB_VERSION.into(),
            latest: None,
            update_available: false,
            min_client_version: MIN_APP_VERSION.into(),
            web_build: None,
        }
    }
}

/// `a` is a strictly newer semver than `b` (unparsable versions are never newer).
pub fn is_newer(a: &str, b: &str) -> bool {
    match (Version::parse(a), Version::parse(b)) {
        (Ok(a), Ok(b)) => a > b,
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientKind {
    App,
    Web,
}

/// Outcome of negotiating a client against this server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Compat {
    Ok,
    /// Client is older than the server's minimum: the client must upgrade.
    ClientTooOld {
        min_version: String,
    },
    /// Client speaks a newer API major than this server: the server must upgrade.
    ServerTooOld {
        server_api_version: u32,
    },
    /// Client sent an unparsable version.
    Invalid {
        reason: String,
    },
}

/// Pure negotiation rule used by the middleware and by tests.
pub fn negotiate(kind: ClientKind, client_version: &str, client_api: Option<u32>) -> Compat {
    if let Some(api) = client_api {
        if api > API_VERSION {
            return Compat::ServerTooOld {
                server_api_version: API_VERSION,
            };
        }
    }
    let min = match kind {
        ClientKind::App => MIN_APP_VERSION,
        ClientKind::Web => MIN_WEB_VERSION,
    };
    match Version::parse(client_version) {
        Err(e) => Compat::Invalid {
            reason: e.to_string(),
        },
        Ok(v) if v < Version::parse(min).expect("valid min version") => Compat::ClientTooOld {
            min_version: min.into(),
        },
        Ok(_) => Compat::Ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_rules() {
        assert_eq!(negotiate(ClientKind::App, "0.1.0", Some(1)), Compat::Ok);
        assert_eq!(
            negotiate(ClientKind::App, "0.0.9", None),
            Compat::ClientTooOld {
                min_version: "0.1.0".into()
            }
        );
        assert_eq!(
            negotiate(ClientKind::Web, "9.0.0", Some(API_VERSION + 1)),
            Compat::ServerTooOld {
                server_api_version: API_VERSION
            }
        );
        assert!(matches!(
            negotiate(ClientKind::App, "abc", None),
            Compat::Invalid { .. }
        ));
    }

    #[test]
    fn newer_compare() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("0.2.0", "0.2.0-beta.1"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("x", "0.1.0"));
    }

    #[test]
    fn version_info_serializes_contract_fields() {
        let v = serde_json::to_value(VersionInfo::current()).unwrap();
        for k in [
            "server_version",
            "api_version",
            "min_app_version",
            "min_web_version",
            "latest",
            "update_available",
            "min_client_version",
            "web_build",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
    }
}
