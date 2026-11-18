//! Authentication core (DEPTAI-471): password hashing (Argon2id), HS256 JWT access tokens,
//! rotating refresh tokens bound to sessions, TOTP, API tokens, WebDAV app passwords,
//! login rate limiting, mail transport, OAuth provider config, and the single
//! authentication middleware that turns any credential into a [`Principal`].
use crate::error::{ApiError, ApiResult};
use crate::AppState;
use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use data_encoding::{BASE32_NOPAD, BASE64URL_NOPAD, HEXLOWER};
use drivehub_core::acl::{self, Acl, Effective, Gate, Identity, Role};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

// ---------------------------------------------------------------- crypto helpers

pub fn hash_password(pw: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default() // Argon2id v19, m=19456 KiB, t=2, p=1
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub fn verify_password(pw: &str, phc: &str) -> bool {
    PasswordHash::new(phc)
        .map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

pub fn check_password_policy(pw: &str) -> ApiResult<()> {
    if pw.chars().count() < 8 {
        return Err(ApiError::bad("password must be at least 8 characters"));
    }
    Ok(())
}

pub fn sha256_hex(s: &str) -> String {
    HEXLOWER.encode(&Sha256::digest(s.as_bytes()))
}

/// Constant-time byte comparison.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn random_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    BASE64URL_NOPAD.encode(&b)
}

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: i64,
    pub sid: String,
    pub typ: String,
    pub iat: i64,
    pub exp: i64,
}

pub fn jwt_sign(secret: &[u8], c: &Claims) -> String {
    let h = BASE64URL_NOPAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let p = BASE64URL_NOPAD.encode(serde_json::to_string(c).unwrap().as_bytes());
    let mut mac = HmacSha256::new_from_slice(secret).unwrap();
    mac.update(format!("{h}.{p}").as_bytes());
    let s = BASE64URL_NOPAD.encode(&mac.finalize().into_bytes());
    format!("{h}.{p}.{s}")
}

pub fn jwt_verify(secret: &[u8], tok: &str) -> Option<Claims> {
    let mut it = tok.split('.');
    let (h, p, s) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() {
        return None;
    }
    let hdr: serde_json::Value =
        serde_json::from_slice(&BASE64URL_NOPAD.decode(h.as_bytes()).ok()?).ok()?;
    if hdr["alg"] != "HS256" {
        return None;
    }
    let mut mac = HmacSha256::new_from_slice(secret).unwrap();
    mac.update(format!("{h}.{p}").as_bytes());
    mac.verify_slice(&BASE64URL_NOPAD.decode(s.as_bytes()).ok()?)
        .ok()?;
    let c: Claims = serde_json::from_slice(&BASE64URL_NOPAD.decode(p.as_bytes()).ok()?).ok()?;
    (c.exp > now()).then_some(c)
}

// ---------------------------------------------------------------- TOTP (RFC 6238)

pub fn totp_new_secret() -> String {
    let mut b = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut b);
    BASE32_NOPAD.encode(&b)
}

pub fn totp_at(secret_b32: &str, t: i64) -> Option<String> {
    let key = BASE32_NOPAD
        .decode(secret_b32.trim_end_matches('=').as_bytes())
        .ok()?;
    let counter = (t / 30) as u64;
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(&key).ok()?;
    mac.update(&counter.to_be_bytes());
    let r = mac.finalize().into_bytes();
    let off = (r[19] & 0xf) as usize;
    let bin = ((r[off] as u32 & 0x7f) << 24)
        | ((r[off + 1] as u32) << 16)
        | ((r[off + 2] as u32) << 8)
        | r[off + 3] as u32;
    Some(format!("{:06}", bin % 1_000_000))
}

/// Accepts the current code and ±1 step of clock skew.
pub fn totp_check(secret_b32: &str, code: &str) -> bool {
    let code = code.trim();
    let t = now();
    [-30, 0, 30]
        .iter()
        .any(|d| totp_at(secret_b32, t + d).as_deref() == Some(code))
}

// ---------------------------------------------------------------- rate limiting

pub struct RateLimiter {
    hits: Mutex<HashMap<String, Vec<Instant>>>,
    pub max_account: usize,
    pub max_ip: usize,
    pub window: Duration,
}

impl RateLimiter {
    pub fn from_env() -> Self {
        let get = |k: &str, d: usize| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d)
        };
        Self {
            hits: Mutex::new(HashMap::new()),
            max_account: get("DRIVEHUB_LOGIN_MAX_FAILS", 5),
            max_ip: get("DRIVEHUB_LOGIN_MAX_FAILS_IP", 30),
            window: Duration::from_secs(get("DRIVEHUB_LOGIN_WINDOW_SECS", 900) as u64),
        }
    }
    fn count(&self, key: &str) -> usize {
        let mut m = self.hits.lock().unwrap();
        let w = self.window;
        let v = m.entry(key.to_string()).or_default();
        v.retain(|t| t.elapsed() < w);
        v.len()
    }
    pub fn blocked(&self, account: &str, ip: &str) -> bool {
        self.count(&format!("a:{}", account.to_lowercase())) >= self.max_account
            || self.count(&format!("i:{ip}")) >= self.max_ip
    }
    pub fn fail(&self, account: &str, ip: &str) {
        let mut m = self.hits.lock().unwrap();
        for k in [format!("a:{}", account.to_lowercase()), format!("i:{ip}")] {
            m.entry(k).or_default().push(Instant::now());
        }
    }
    pub fn success(&self, account: &str) {
        self.hits
            .lock()
            .unwrap()
            .remove(&format!("a:{}", account.to_lowercase()));
    }
}

// ---------------------------------------------------------------- mail

#[derive(Debug, Clone)]
pub struct Mail {
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[async_trait::async_trait]
pub trait Mailer: Send + Sync {
    /// "smtp" or "log".
    fn kind(&self) -> &'static str;
    async fn send(&self, m: Mail) -> anyhow::Result<()>;
}

/// Development / fallback transport: writes mails to the log and keeps them in memory.
#[derive(Default)]
pub struct LogMailer {
    pub outbox: Mutex<Vec<Mail>>,
}

#[async_trait::async_trait]
impl Mailer for LogMailer {
    fn kind(&self) -> &'static str {
        "log"
    }
    async fn send(&self, m: Mail) -> anyhow::Result<()> {
        tracing::info!(to = %m.to, subject = %m.subject, body = %m.body, "mail (log transport)");
        let mut o = self.outbox.lock().unwrap();
        o.push(m);
        let n = o.len();
        if n > 100 {
            o.drain(..n - 100);
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub from: String,
    /// starttls | tls | none
    pub security: String,
}

impl SmtpConfig {
    pub fn from_env() -> Option<Self> {
        let g = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let host = g("DRIVEHUB_SMTP_HOST")?;
        let security = g("DRIVEHUB_SMTP_SECURITY").unwrap_or_else(|| "starttls".into());
        let port = g("DRIVEHUB_SMTP_PORT")
            .and_then(|v| v.parse().ok())
            .unwrap_or(match security.as_str() {
                "tls" => 465,
                "none" => 25,
                _ => 587,
            });
        Some(Self {
            from: g("DRIVEHUB_SMTP_FROM").unwrap_or_else(|| format!("DriveHub <noreply@{host}>")),
            host,
            port,
            username: g("DRIVEHUB_SMTP_USERNAME"),
            password: g("DRIVEHUB_SMTP_PASSWORD"),
            security,
        })
    }
}

pub struct SmtpMailer {
    pub cfg: SmtpConfig,
}

#[async_trait::async_trait]
impl Mailer for SmtpMailer {
    fn kind(&self) -> &'static str {
        "smtp"
    }
    async fn send(&self, m: Mail) -> anyhow::Result<()> {
        use lettre::message::header::ContentType;
        use lettre::transport::smtp::authentication::Credentials;
        use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
        let c = &self.cfg;
        let mut b = match c.security.as_str() {
            "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(&c.host)?,
            "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&c.host),
            _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&c.host)?,
        }
        .port(c.port)
        .timeout(Some(Duration::from_secs(20)));
        if let (Some(u), Some(p)) = (&c.username, &c.password) {
            b = b.credentials(Credentials::new(u.clone(), p.clone()));
        }
        let msg = Message::builder()
            .from(c.from.parse()?)
            .to(m.to.parse()?)
            .subject(m.subject)
            .header(ContentType::TEXT_PLAIN)
            .body(m.body)?;
        b.build().send(msg).await?;
        Ok(())
    }
}

// ---------------------------------------------------------------- OAuth providers

#[derive(Debug, Clone, Serialize)]
pub struct OAuthProvider {
    pub name: String,
    pub client_id: String,
    #[serde(skip)]
    pub client_secret: String,
    pub auth_url: String,
    pub token_url: String,
    pub userinfo_url: String,
    /// GitHub: list of emails with `verified` flags.
    pub emails_url: Option<String>,
    pub scope: String,
}

impl OAuthProvider {
    pub fn defaults(
        name: &str,
    ) -> Option<(
        &'static str,
        &'static str,
        &'static str,
        Option<&'static str>,
        &'static str,
    )> {
        match name {
            "google" => Some((
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://oauth2.googleapis.com/token",
                "https://openidconnect.googleapis.com/v1/userinfo",
                None,
                "openid email profile",
            )),
            "github" => Some((
                "https://github.com/login/oauth/authorize",
                "https://github.com/login/oauth/access_token",
                "https://api.github.com/user",
                Some("https://api.github.com/user/emails"),
                "read:user user:email",
            )),
            _ => None,
        }
    }

    /// `DRIVEHUB_OAUTH_<NAME>_CLIENT_ID` / `_CLIENT_SECRET` (+ optional `_AUTH_URL`,
    /// `_TOKEN_URL`, `_USERINFO_URL`, `_EMAILS_URL`, `_SCOPE` overrides).
    pub fn from_env(name: &str) -> Option<Self> {
        let up = name.to_uppercase();
        let g = |k: &str| {
            std::env::var(format!("DRIVEHUB_OAUTH_{up}_{k}"))
                .ok()
                .filter(|v| !v.is_empty())
        };
        let (a, t, u, e, s) = Self::defaults(name)?;
        Some(Self {
            name: name.into(),
            client_id: g("CLIENT_ID")?,
            client_secret: g("CLIENT_SECRET")?,
            auth_url: g("AUTH_URL").unwrap_or_else(|| a.into()),
            token_url: g("TOKEN_URL").unwrap_or_else(|| t.into()),
            userinfo_url: g("USERINFO_URL").unwrap_or_else(|| u.into()),
            emails_url: g("EMAILS_URL").or(e.map(String::from)),
            scope: g("SCOPE").unwrap_or_else(|| s.into()),
        })
    }
}

#[derive(Debug, Clone)]
pub struct OAuthState {
    pub provider: String,
    pub link_user: Option<i64>,
    pub redirect_uri: String,
    pub created: Instant,
}

// ---------------------------------------------------------------- Auth service

pub struct Auth {
    pub jwt_secret: Vec<u8>,
    pub access_ttl: i64,
    pub refresh_ttl: i64,
    pub limiter: RateLimiter,
    pub mailer: RwLock<Arc<dyn Mailer>>,
    pub oauth: RwLock<HashMap<String, OAuthProvider>>,
    pub oauth_states: Mutex<HashMap<String, OAuthState>>,
    /// short-lived "password/OAuth ok, TOTP pending" tickets → user id
    pub totp_tickets: Mutex<HashMap<String, (i64, String, Instant)>>,
    pub public_url: Option<String>,
    pub initialized: AtomicBool,
    pub acl: RwLock<Arc<Acl>>,
    /// sha256(kind|user|secret) → (user_id, via, verified_at) for Basic auth (WebDAV clients
    /// send credentials on every request; Argon2 per request would be far too slow).
    basic_cache: Mutex<HashMap<String, (i64, &'static str, Instant)>>,
    gate_pw_cache: Mutex<HashMap<String, bool>>,
}

impl Auth {
    pub async fn load(db: &sqlx::SqlitePool) -> anyhow::Result<Self> {
        let secret = match std::env::var("DRIVEHUB_JWT_SECRET")
            .ok()
            .filter(|s| s.len() >= 16)
        {
            Some(s) => s,
            None => match crate::settings::get_meta(db, "auth.jwt_secret").await? {
                Some(s) => s,
                None => {
                    let s = random_token(48);
                    crate::settings::set_meta(db, "auth.jwt_secret", &s).await?;
                    s
                }
            },
        };
        let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(db)
            .await?;
        let ttl = |k: &str, d: i64| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d)
        };
        let mailer: Arc<dyn Mailer> = match SmtpConfig::from_env() {
            Some(cfg) => Arc::new(SmtpMailer { cfg }),
            None => Arc::new(LogMailer::default()),
        };
        let mut oauth = HashMap::new();
        for n in ["google", "github"] {
            if let Some(p) = OAuthProvider::from_env(n) {
                oauth.insert(n.to_string(), p);
            }
        }
        let a = Self {
            jwt_secret: secret.into_bytes(),
            access_ttl: ttl("DRIVEHUB_ACCESS_TTL_SECS", 900),
            refresh_ttl: ttl("DRIVEHUB_REFRESH_TTL_SECS", 30 * 86400),
            limiter: RateLimiter::from_env(),
            mailer: RwLock::new(mailer),
            oauth: RwLock::new(oauth),
            oauth_states: Mutex::new(HashMap::new()),
            totp_tickets: Mutex::new(HashMap::new()),
            public_url: std::env::var("DRIVEHUB_PUBLIC_URL")
                .ok()
                .map(|s| s.trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty()),
            initialized: AtomicBool::new(users > 0),
            acl: RwLock::new(Arc::new(Acl::default())),
            basic_cache: Mutex::new(HashMap::new()),
            gate_pw_cache: Mutex::new(HashMap::new()),
        };
        a.reload_acl(db).await?;
        Ok(a)
    }

    pub fn initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    pub fn mailer(&self) -> Arc<dyn Mailer> {
        self.mailer.read().unwrap().clone()
    }
    pub fn set_mailer(&self, m: Arc<dyn Mailer>) {
        *self.mailer.write().unwrap() = m;
    }
    pub fn set_oauth_provider(&self, p: OAuthProvider) {
        self.oauth.write().unwrap().insert(p.name.clone(), p);
    }

    pub fn acl(&self) -> Arc<Acl> {
        self.acl.read().unwrap().clone()
    }

    pub async fn reload_acl(&self, db: &sqlx::SqlitePool) -> anyhow::Result<()> {
        let rows: Vec<(i64, String, String, Option<i64>, i64, i64)> = sqlx::query_as(
            "SELECT id, path, subject_type, subject_id, allow_bits, deny_bits FROM acl_rules",
        )
        .fetch_all(db)
        .await?;
        let mut rules: Vec<acl::Rule> = rows
            .into_iter()
            .filter_map(|(id, path, st, sid, a, d)| {
                Some(acl::Rule {
                    id,
                    path,
                    subject: acl::Subject::parse(&st, sid)?,
                    allow: a as u32,
                    deny: d as u32,
                })
            })
            .collect();
        // RBAC (DEPTAI-485 r3): every role assignment becomes a synthetic root-level allow
        // rule (negative id, hidden from the rules API). Deeper explicit rules still win.
        let role_rows: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT 'user', ur.user_id, r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id \
             UNION ALL SELECT 'group', gr.group_id, r.permissions FROM group_roles gr JOIN roles r ON r.id = gr.role_id",
        )
        .fetch_all(db)
        .await?;
        for (i, (kind, sid, bits)) in role_rows.into_iter().enumerate() {
            if let Some(subject) = acl::Subject::parse(&kind, Some(sid)) {
                rules.push(acl::Rule {
                    id: -(i as i64) - 1,
                    path: String::new(),
                    subject,
                    allow: bits as u32,
                    deny: 0,
                });
            }
        }
        let gates: Vec<(String, i64, Option<String>)> =
            sqlx::query_as("SELECT path, modes, password_hash FROM acl_gates")
                .fetch_all(db)
                .await?;
        let gates = gates
            .into_iter()
            .map(|(path, modes, password_hash)| Gate {
                path,
                modes: modes as u32,
                password_hash,
            })
            .collect();
        *self.acl.write().unwrap() = Arc::new(Acl::new(rules, gates));
        self.gate_pw_cache.lock().unwrap().clear();
        Ok(())
    }

    pub fn gate_password_ok(&self, g: &Gate, supplied: Option<&str>) -> bool {
        let (Some(h), Some(pw)) = (&g.password_hash, supplied) else {
            return false;
        };
        let key = sha256_hex(&format!("{h}\0{pw}"));
        if let Some(v) = self.gate_pw_cache.lock().unwrap().get(&key) {
            return *v;
        }
        let ok = verify_password(pw, h);
        self.gate_pw_cache.lock().unwrap().insert(key, ok);
        ok
    }

    pub fn issue_access(&self, uid: i64, sid: &str) -> String {
        let t = now();
        jwt_sign(
            &self.jwt_secret,
            &Claims {
                sub: uid,
                sid: sid.into(),
                typ: "access".into(),
                iat: t,
                exp: t + self.access_ttl,
            },
        )
    }

    fn basic_cached(&self, key: &str) -> Option<(i64, &'static str)> {
        let mut c = self.basic_cache.lock().unwrap();
        match c.get(key) {
            Some((u, v, t)) if t.elapsed() < Duration::from_secs(120) => Some((*u, *v)),
            Some(_) => {
                c.remove(key);
                None
            }
            None => None,
        }
    }
    pub fn forget_basic(&self) {
        self.basic_cache.lock().unwrap().clear();
    }
}

// ---------------------------------------------------------------- Principal

#[derive(Debug, Clone, Serialize)]
pub struct UserCtx {
    pub id: i64,
    pub username: String,
    pub email: Option<String>,
    pub role: Role,
    pub groups: Vec<i64>,
    /// Normalized jail root ("" = whole tree).
    pub root: String,
    pub visible_mounts: Option<Vec<String>>,
    pub quota_bytes: Option<i64>,
    pub used_bytes: i64,
    pub totp_enabled: bool,
}

#[derive(Debug, Clone)]
pub struct Principal {
    pub user: Option<UserCtx>,
    /// System not initialized yet (no users): legacy open mode, everything allowed.
    pub setup: bool,
    pub session_id: Option<String>,
    /// anonymous | setup | jwt | api_token | app_password | password
    pub via: &'static str,
    /// Password for password-gated directories (`x-drivehub-path-password`).
    pub path_password: Option<String>,
    pub ip: String,
    /// User-Agent (truncated), for audit records.
    pub ua: String,
    /// web | android | webdav | api (from `x-drivehub-client`, path and UA).
    pub client: &'static str,
}

impl Principal {
    pub fn anonymous(setup: bool, ip: String) -> Self {
        Self {
            user: None,
            setup,
            session_id: None,
            via: if setup { "setup" } else { "anonymous" },
            path_password: None,
            ip,
            ua: String::new(),
            client: "api",
        }
    }
    pub fn is_admin(&self) -> bool {
        self.setup || self.user.as_ref().is_some_and(|u| u.role == Role::Admin)
    }
    pub fn uid(&self) -> Option<i64> {
        self.user.as_ref().map(|u| u.id)
    }
    pub fn name(&self) -> String {
        self.user
            .as_ref()
            .map(|u| u.username.clone())
            .unwrap_or_else(|| self.via.to_string())
    }
    pub fn require_user(&self) -> ApiResult<&UserCtx> {
        self.user
            .as_ref()
            .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "login required".into()))
    }
    pub fn require_admin(&self) -> ApiResult<()> {
        if self.is_admin() {
            return Ok(());
        }
        if self.user.is_none() {
            return Err(ApiError(StatusCode::UNAUTHORIZED, "login required".into()));
        }
        Err(ApiError::forbidden("admin only"))
    }
    pub fn identity(&self) -> Identity {
        match &self.user {
            None => Identity {
                superuser: self.setup,
                ..Identity::anonymous()
            },
            Some(u) => Identity {
                user_id: Some(u.id),
                role: Some(u.role),
                groups: u.groups.clone(),
                root: if u.role == Role::Admin {
                    String::new()
                } else {
                    u.root.clone()
                },
                visible_mounts: if u.role == Role::Admin {
                    None
                } else {
                    u.visible_mounts.clone()
                },
                superuser: u.role == Role::Admin,
            },
        }
    }
    fn root(&self) -> &str {
        match &self.user {
            Some(u) if u.role != Role::Admin => &u.root,
            _ => "",
        }
    }
    /// User-visible virtual path → real normalized virtual path (jail applied).
    pub fn map_in(&self, user_path: &str) -> ApiResult<String> {
        let p = drivehub_storage::norm(user_path)?;
        let r = self.root();
        Ok(match (r.is_empty(), p.is_empty()) {
            (true, _) => p,
            (false, true) => r.to_string(),
            (false, false) => format!("{r}/{p}"),
        })
    }
    /// Real normalized path → user-visible "/..." path (None when outside the jail).
    pub fn map_out(&self, real: &str) -> Option<String> {
        let real = real.trim_matches('/');
        let r = self.root();
        if r.is_empty() {
            return Some(format!("/{real}"));
        }
        if real == r {
            return Some("/".into());
        }
        real.strip_prefix(&format!("{r}/")).map(|s| format!("/{s}"))
    }
}

/// What the client tried to do, for audit records.
pub const CH_API: &str = "api";
pub const CH_DAV: &str = "webdav";
pub const CH_AUTH: &str = "auth";
pub const CH_SHARE: &str = "share";
pub const CH_ADMIN: &str = "admin";

impl AppState {
    /// Effective permissions of `p` on the real normalized path. Single entry point used by
    /// the HTTP API, WebDAV and search.
    pub fn perms(&self, p: &Principal, real: &str) -> Effective {
        let acl = self.auth.acl();
        let pw = p.path_password.clone();
        let real =
            drivehub_storage::norm(real).unwrap_or_else(|_| real.trim_matches('/').to_string());
        acl.effective(&p.identity(), &real, &|g| {
            self.auth.gate_password_ok(g, pw.as_deref())
        })
    }

    pub fn can_see_mount(&self, p: &Principal, mount: &str) -> bool {
        let acl = self.auth.acl();
        let pw = p.path_password.clone();
        acl.can_see_mount(&p.identity(), mount, &|g| {
            self.auth.gate_password_ok(g, pw.as_deref())
        })
    }

    /// Checks `need` bits on `real`; denials are audited and mapped to 401 (anonymous) or 403.
    pub fn authorize(
        &self,
        p: &Principal,
        real: &str,
        need: u32,
        channel: &str,
        action: &str,
    ) -> ApiResult<()> {
        let e = self.perms(p, real);
        if e.has(need) {
            return Ok(());
        }
        let missing = acl::bits_to_names(need & !e.bits).join(",");
        self.audit(
            p,
            channel,
            action,
            real,
            false,
            &format!("missing {missing}; {}", e.reason),
        );
        if p.user.is_none() && !p.setup {
            return Err(ApiError(
                StatusCode::UNAUTHORIZED,
                format!("login required ({missing})"),
            ));
        }
        Err(ApiError::forbidden(format!("permission denied: {missing}")))
    }

    pub fn audit(
        &self,
        p: &Principal,
        channel: &str,
        action: &str,
        path: &str,
        allowed: bool,
        detail: &str,
    ) {
        self.audit_log.log(crate::audit::AuditEvent::new(
            p, channel, action, path, allowed, detail,
        ));
    }

    /// Full-featured audit record (bytes, share id, …).
    pub fn audit_ev(&self, e: crate::audit::AuditEvent) {
        self.audit_log.log(e);
    }

    pub async fn load_user(&self, uid: i64) -> ApiResult<Option<UserCtx>> {
        #[allow(clippy::type_complexity)]
        let row: Option<(i64, String, Option<String>, String, i64, String, Option<String>, Option<i64>, i64, Option<String>)> =
            sqlx::query_as(
                "SELECT id, username, email, role, disabled, root_path, visible_mounts, quota_bytes, used_bytes, totp_secret FROM users WHERE id = ?",
            )
            .bind(uid)
            .fetch_optional(&self.db)
            .await?;
        let Some((id, username, email, role, disabled, root, vis, quota, used, totp)) = row else {
            return Ok(None);
        };
        if disabled != 0 {
            return Err(ApiError::forbidden("account disabled"));
        }
        let groups: Vec<i64> =
            sqlx::query_scalar("SELECT group_id FROM user_groups WHERE user_id = ?")
                .bind(id)
                .fetch_all(&self.db)
                .await?;
        Ok(Some(UserCtx {
            id,
            username,
            email,
            role: Role::parse(&role).unwrap_or(Role::User),
            groups,
            root: drivehub_storage::norm(&root).unwrap_or_default(),
            visible_mounts: vis.and_then(|v| serde_json::from_str(&v).ok()),
            quota_bytes: quota,
            used_bytes: used,
            totp_enabled: totp.is_some(),
        }))
    }

    /// Resolves credentials from headers / query into a principal.
    /// Errors: 401 for invalid/expired credentials, 429 when Basic auth is rate limited.
    pub async fn authenticate(
        &self,
        headers: &HeaderMap,
        query: Option<&str>,
        ip: &str,
    ) -> ApiResult<Principal> {
        let setup = !self.auth.initialized();
        let mut p = Principal::anonymous(setup, ip.to_string());
        p.path_password = headers
            .get("x-drivehub-path-password")
            .and_then(|v| v.to_str().ok())
            .map(String::from)
            .or_else(|| query_param(query, "path_password"));
        let authz = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bearer = authz
            .as_deref()
            .and_then(|a| a.strip_prefix("Bearer ").map(|s| s.trim().to_string()))
            .or_else(|| query_param(query, "access_token"));
        let unauth = |m: &str| ApiError(StatusCode::UNAUTHORIZED, m.into());
        if let Some(tok) = bearer {
            let (uid, via, sid) = self
                .resolve_bearer(&tok)
                .await?
                .ok_or_else(|| unauth("invalid or expired token"))?;
            let u = self
                .load_user(uid)
                .await?
                .ok_or_else(|| unauth("user not found"))?;
            p.user = Some(u);
            p.via = via;
            p.session_id = sid;
            p.setup = false;
            return Ok(p);
        }
        if let Some(b64) = authz.as_deref().and_then(|a| a.strip_prefix("Basic ")) {
            let raw = data_encoding::BASE64
                .decode(b64.trim().as_bytes())
                .ok()
                .and_then(|v| String::from_utf8(v).ok())
                .ok_or_else(|| unauth("bad basic auth"))?;
            let (login, secret) = raw
                .split_once(':')
                .ok_or_else(|| unauth("bad basic auth"))?;
            if self.auth.limiter.blocked(login, ip) {
                return Err(ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "too many failed logins".into(),
                ));
            }
            match self.resolve_basic(login, secret).await? {
                Some((uid, via)) => {
                    let u = self
                        .load_user(uid)
                        .await?
                        .ok_or_else(|| unauth("user not found"))?;
                    p.user = Some(u);
                    p.via = via;
                    p.setup = false;
                    return Ok(p);
                }
                None => {
                    self.auth.limiter.fail(login, ip);
                    self.audit(
                        &p,
                        CH_AUTH,
                        "basic_login",
                        "",
                        false,
                        &format!("login={login}"),
                    );
                    return Err(unauth("invalid credentials"));
                }
            }
        }
        Ok(p)
    }

    /// Bearer: `dh_pat_…` API token or JWT access token (session must be live).
    async fn resolve_bearer(
        &self,
        tok: &str,
    ) -> ApiResult<Option<(i64, &'static str, Option<String>)>> {
        if tok.starts_with("dh_pat_") {
            return Ok(self
                .api_token_user(tok)
                .await?
                .map(|u| (u, "api_token", None)));
        }
        let Some(c) = jwt_verify(&self.auth.jwt_secret, tok) else {
            return Ok(None);
        };
        if c.typ != "access" {
            return Ok(None);
        }
        let live: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND revoked = 0 AND expires_at > ?",
        )
        .bind(&c.sid)
        .bind(c.sub)
        .bind(now())
        .fetch_optional(&self.db)
        .await?;
        Ok(live.map(|_| (c.sub, "jwt", Some(c.sid))))
    }

    pub async fn api_token_user(&self, tok: &str) -> ApiResult<Option<i64>> {
        let row: Option<(i64, i64)> = sqlx::query_as(
            "SELECT id, user_id FROM api_tokens WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)",
        )
        .bind(sha256_hex(tok))
        .bind(now())
        .fetch_optional(&self.db)
        .await?;
        if let Some((id, _)) = row {
            let _ = sqlx::query("UPDATE api_tokens SET last_used = ? WHERE id = ?")
                .bind(now())
                .bind(id)
                .execute(&self.db)
                .await;
        }
        Ok(row.map(|r| r.1))
    }

    /// Basic credentials (WebDAV): app password, API token, or account password
    /// (account password is refused when TOTP is enabled — use an app password).
    async fn resolve_basic(
        &self,
        login: &str,
        secret: &str,
    ) -> ApiResult<Option<(i64, &'static str)>> {
        let key = sha256_hex(&format!("{login}\0{secret}"));
        if let Some(hit) = self.auth.basic_cached(&key) {
            return Ok(Some(hit));
        }
        let user: Option<(i64, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT id, password_hash, totp_secret FROM users WHERE (username = ? OR lower(email) = lower(?)) AND disabled = 0",
        )
        .bind(login)
        .bind(login)
        .fetch_optional(&self.db)
        .await?;
        let Some((uid, pw_hash, totp)) = user else {
            return Ok(None);
        };
        let mut found: Option<&'static str> = None;
        let app: Option<i64> =
            sqlx::query_scalar("SELECT id FROM app_passwords WHERE user_id = ? AND pw_hash = ?")
                .bind(uid)
                .bind(sha256_hex(secret))
                .fetch_optional(&self.db)
                .await?;
        if let Some(id) = app {
            let _ = sqlx::query("UPDATE app_passwords SET last_used = ? WHERE id = ?")
                .bind(now())
                .bind(id)
                .execute(&self.db)
                .await;
            found = Some("app_password");
        } else if secret.starts_with("dh_pat_") {
            if self.api_token_user(secret).await? == Some(uid) {
                found = Some("api_token");
            }
        } else if totp.is_none()
            && pw_hash
                .as_deref()
                .is_some_and(|h| verify_password(secret, h))
        {
            found = Some("password");
        }
        if let Some(via) = found {
            self.auth
                .basic_cache
                .lock()
                .unwrap()
                .insert(key, (uid, via, Instant::now()));
            self.auth.limiter.success(login);
            return Ok(Some((uid, via)));
        }
        Ok(None)
    }
}

pub fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    url::form_urlencoded::parse(query?.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

pub fn client_ip(req: &Request) -> String {
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|c| c.0.ip());
    let fwd = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string());
    match (peer, fwd) {
        (Some(ip), Some(f)) if ip.is_loopback() => f,
        (Some(ip), _) => ip.to_string(),
        (None, Some(f)) => f,
        (None, None) => "local".into(),
    }
}

/// The unified authentication middleware for /api and /dav: every request gets a
/// [`Principal`] extension; authorization decisions use [`AppState::authorize`].
pub async fn authn(State(st): State<AppState>, mut req: Request, next: Next) -> Response {
    let ip = client_ip(&req);
    let q = req.uri().query().map(str::to_string);
    match st.authenticate(req.headers(), q.as_deref(), &ip).await {
        Ok(mut p) => {
            p.ua = req
                .headers()
                .get(header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .chars()
                .take(200)
                .collect();
            p.client = client_kind(req.headers(), req.uri().path());
            req.extensions_mut().insert(p);
            next.run(req).await
        }
        Err(e) => {
            if req.uri().path().starts_with("/dav") && e.0 == StatusCode::UNAUTHORIZED {
                return dav_challenge();
            }
            e.into_response()
        }
    }
}

/// Client type for audit: web | android | webdav | api.
pub fn client_kind(h: &HeaderMap, path: &str) -> &'static str {
    if path.starts_with("/dav") {
        return "webdav";
    }
    match h
        .get(crate::HDR_CLIENT)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split('/').next())
    {
        Some("web") => "web",
        Some("app") => "android",
        _ => {
            let ua = h
                .get(header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if ua.contains("Mozilla/") {
                "web"
            } else {
                "api"
            }
        }
    }
}

pub fn dav_challenge() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(
            header::WWW_AUTHENTICATE,
            "Basic realm=\"DriveHub\", charset=\"UTF-8\"",
        )],
        "authentication required",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totp_rfc6238_vector() {
        // RFC 6238 SHA1 test secret "12345678901234567890", T=59 → 94287082 (8 digits) → 287082
        let secret = BASE32_NOPAD.encode(b"12345678901234567890");
        assert_eq!(totp_at(&secret, 59).unwrap(), "287082");
        assert_eq!(totp_at(&secret, 1111111109).unwrap(), "081804");
    }

    #[test]
    fn jwt_roundtrip_and_tamper() {
        let c = Claims {
            sub: 7,
            sid: "s".into(),
            typ: "access".into(),
            iat: now(),
            exp: now() + 60,
        };
        let t = jwt_sign(b"k1234567890123456", &c);
        assert_eq!(jwt_verify(b"k1234567890123456", &t).unwrap().sub, 7);
        assert!(jwt_verify(b"other-secret-xxxxx", &t).is_none());
        let expired = jwt_sign(
            b"k",
            &Claims {
                exp: now() - 1,
                ..c
            },
        );
        assert!(jwt_verify(b"k", &expired).is_none());
    }

    #[test]
    fn argon2id_hash_verify() {
        let h = hash_password("correct horse").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password("correct horse", &h));
        assert!(!verify_password("wrong", &h));
    }

    #[test]
    fn jail_mapping() {
        let mut p = Principal::anonymous(false, "x".into());
        p.user = Some(UserCtx {
            id: 1,
            username: "u".into(),
            email: None,
            role: Role::User,
            groups: vec![],
            root: "local/home/u".into(),
            visible_mounts: None,
            quota_bytes: None,
            used_bytes: 0,
            totp_enabled: false,
        });
        assert_eq!(p.map_in("/").unwrap(), "local/home/u");
        assert_eq!(p.map_in("/a/b").unwrap(), "local/home/u/a/b");
        assert_eq!(p.map_out("local/home/u/a").unwrap(), "/a");
        assert_eq!(p.map_out("local/home/u").unwrap(), "/");
        assert!(p.map_out("local/other").is_none());
        assert!(p.map_in("/../x").is_err());
    }
}
