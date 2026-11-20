use semver::Version;
use serde::Serialize;
use utoipa::ToSchema;

/// Release version shared by server / web / app (one semver for all).
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
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
    /// Build id of the web bundle currently on disk (web_dir/version.json).
    /// A loaded page whose own build id differs should offer a reload.
    pub web_build: Option<String>,
}

impl VersionInfo {
    pub fn current() -> Self {
        Self {
            server_version: SERVER_VERSION.into(),
            api_version: API_VERSION,
            min_app_version: MIN_APP_VERSION.into(),
            min_web_version: MIN_WEB_VERSION.into(),
            web_build: None,
        }
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
    fn version_info_serializes_contract_fields() {
        let v = serde_json::to_value(VersionInfo::current()).unwrap();
        for k in [
            "server_version",
            "api_version",
            "min_app_version",
            "min_web_version",
            "web_build",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
    }
}
