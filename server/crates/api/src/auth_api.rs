//! Auth HTTP API (DEPTAI-471): init / register / login (+TOTP) / refresh / logout /
//! sessions / password reset / e-mail verification / API tokens / app passwords / OAuth.
#![allow(clippy::type_complexity)]
use crate::auth::*;
use crate::error::{ApiError, ApiResult};
use crate::settings::Settings;
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Extension, Json,
};
use drivehub_core::acl::{self, Role};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub session_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AuthStatus {
    /// false until the first admin is created via POST /api/auth/init
    pub initialized: bool,
    pub open_registration: bool,
    pub require_email_verification: bool,
    /// smtp | log
    pub mail_transport: String,
    pub oauth_providers: Vec<String>,
    #[schema(value_type = Object)]
    pub me: Option<Value>,
}

fn ua(h: &HeaderMap) -> String {
    h.get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect()
}

fn public_base(st: &AppState, h: &HeaderMap) -> String {
    if let Some(u) = &st.auth.public_url {
        return u.clone();
    }
    let host = h
        .get("x-forwarded-host")
        .or_else(|| h.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    let proto = h
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    format!("{proto}://{host}")
}

pub async fn user_json(st: &AppState, uid: i64) -> ApiResult<Value> {
    #[allow(clippy::type_complexity)]
    let r: (i64, String, Option<String>, String, i64, i64, Option<String>, String, Option<String>, Option<i64>, i64, i64, Option<String>) = sqlx::query_as(
        "SELECT id, username, email, role, disabled, email_verified, totp_secret, root_path, visible_mounts, quota_bytes, used_bytes, created_at, password_hash FROM users WHERE id = ?",
    )
    .bind(uid)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| ApiError::not_found("no such user"))?;
    let groups: Vec<(i64, String)> = sqlx::query_as(
        "SELECT g.id, g.name FROM groups g JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = ? ORDER BY g.name",
    )
    .bind(uid)
    .fetch_all(&st.db)
    .await?;
    let roles: Vec<(i64, String)> = sqlx::query_as(
        "SELECT r.id, r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? ORDER BY r.name",
    )
    .bind(uid)
    .fetch_all(&st.db)
    .await?;
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT provider FROM identities WHERE user_id = ? ORDER BY provider")
            .bind(uid)
            .fetch_all(&st.db)
            .await?;
    Ok(json!({
        "id": r.0, "username": r.1, "email": r.2, "role": r.3, "disabled": r.4 != 0,
        "email_verified": r.5 != 0, "totp_enabled": r.6.is_some(),
        "root_path": format!("/{}", r.7.trim_matches('/')),
        "visible_mounts": r.8.and_then(|v| serde_json::from_str::<Value>(&v).ok()),
        "quota_bytes": r.9, "used_bytes": r.10, "created_at": r.11,
        "has_password": r.12.is_some(),
        "groups": groups.into_iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
        "identities": ids,
        "roles": roles.into_iter().map(|(id, name)| json!({"id": id, "name": name})).collect::<Vec<_>>(),
    }))
}

pub async fn create_user(
    st: &AppState,
    username: &str,
    email: Option<&str>,
    password: Option<&str>,
    role: Role,
    verified: bool,
) -> ApiResult<i64> {
    let username = username.trim();
    if username.is_empty() || username.len() > 64 || username.contains(['/', ':', ' ']) {
        return Err(ApiError::bad("invalid username"));
    }
    if let Some(e) = email {
        if !e.contains('@') || e.len() > 254 {
            return Err(ApiError::bad("invalid email"));
        }
    }
    let hash = match password {
        Some(p) => {
            check_password_policy(p)?;
            Some(hash_password(p)?)
        }
        None => None,
    };
    let r = sqlx::query(
        "INSERT INTO users (username, email, password_hash, role, email_verified, created_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(username)
    .bind(email.map(|e| e.trim().to_lowercase()))
    .bind(hash)
    .bind(role.as_str())
    .bind(verified as i64)
    .bind(now())
    .execute(&st.db)
    .await;
    match r {
        Ok(r) => Ok(r.last_insert_rowid()),
        Err(sqlx::Error::Database(e)) if e.message().contains("UNIQUE") => Err(ApiError(
            StatusCode::CONFLICT,
            "username or email already registered".into(),
        )),
        Err(e) => Err(e.into()),
    }
}

pub async fn create_session(
    st: &AppState,
    uid: i64,
    ua: &str,
    ip: &str,
    method: &str,
) -> ApiResult<TokenPair> {
    let sid = random_token(16);
    let secret = random_token(32);
    let t = now();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, refresh_hash, user_agent, ip, method, created_at, last_used, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(&sid)
    .bind(uid)
    .bind(sha256_hex(&secret))
    .bind(ua)
    .bind(ip)
    .bind(method)
    .bind(t)
    .bind(t)
    .bind(t + st.auth.refresh_ttl)
    .execute(&st.db)
    .await?;
    Ok(TokenPair {
        access_token: st.auth.issue_access(uid, &sid),
        refresh_token: format!("{sid}.{secret}"),
        token_type: "Bearer",
        expires_in: st.auth.access_ttl,
        session_id: sid,
    })
}

/// Auth status: initialization, registration policy, providers, current user.
#[utoipa::path(get, path = "/api/auth/status", responses((status = 200, body = AuthStatus)))]
pub async fn status(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<AuthStatus>> {
    let s = Settings::load(&st.db).await?;
    let me = match p.uid() {
        Some(u) => Some(user_json(&st, u).await?),
        None => None,
    };
    let mut providers: Vec<String> = st.auth.oauth.read().unwrap().keys().cloned().collect();
    providers.sort();
    Ok(Json(AuthStatus {
        initialized: st.auth.initialized(),
        open_registration: s.open_registration,
        require_email_verification: s.require_email_verification,
        mail_transport: st.auth.mailer().kind().into(),
        oauth_providers: providers,
        me,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct InitBody {
    pub username: String,
    pub email: Option<String>,
    pub password: String,
}

/// First start: creates the single initial admin (only while no user exists).
#[utoipa::path(post, path = "/api/auth/init", request_body = InitBody, responses((status = 200, body = TokenPair), (status = 409, description = "already initialized")))]
pub async fn init(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Json(b): Json<InitBody>,
) -> ApiResult<Json<TokenPair>> {
    static INIT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _g = INIT.lock().await; // serialize concurrent inits
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&st.db)
        .await?;
    if n > 0 {
        return Err(ApiError(StatusCode::CONFLICT, "already initialized".into()));
    }
    let uid = create_user(
        &st,
        &b.username,
        b.email.as_deref(),
        Some(&b.password),
        Role::Admin,
        true,
    )
    .await?;
    // Default policy: logged-in users may browse + download everything; admins edit.
    sqlx::query("INSERT INTO acl_rules (path, subject_type, subject_id, allow_bits, deny_bits, created_at) VALUES ('', 'logged_in', NULL, ?, 0, ?)")
        .bind((acl::READ | acl::DOWNLOAD) as i64)
        .bind(now())
        .execute(&st.db)
        .await?;
    st.auth.reload_acl(&st.db).await?;
    st.auth
        .initialized
        .store(true, std::sync::atomic::Ordering::SeqCst);
    st.audit(&p, CH_AUTH, "init_admin", "", true, &b.username);
    Ok(Json(
        create_session(&st, uid, &ua(&headers), &p.ip, "password").await?,
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RegisterBody {
    pub username: Option<String>,
    pub email: String,
    pub password: String,
}

/// Self-service registration (only when the admin enabled open registration).
#[utoipa::path(post, path = "/api/auth/register", request_body = RegisterBody, responses((status = 200, description = "user created"), (status = 403, description = "registration closed")))]
pub async fn register(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Json(b): Json<RegisterBody>,
) -> ApiResult<Response> {
    let s = Settings::load(&st.db).await?;
    if !st.auth.initialized() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "not initialized; create the admin via /api/auth/init".into(),
        ));
    }
    if !s.open_registration {
        st.audit(
            &p,
            CH_AUTH,
            "register",
            "",
            false,
            &format!("closed; email={}", b.email),
        );
        return Err(ApiError::forbidden("registration is closed"));
    }
    let username = b
        .username
        .clone()
        .unwrap_or_else(|| b.email.split('@').next().unwrap_or("").to_string());
    let uid = create_user(
        &st,
        &username,
        Some(&b.email),
        Some(&b.password),
        Role::User,
        false,
    )
    .await?;
    st.audit(&p, CH_AUTH, "register", "", true, &username);
    if s.require_email_verification {
        send_email_token(&st, uid, &b.email, "verify", &public_base(&st, &headers)).await?;
        return Ok(
            Json(json!({"ok": true, "user_id": uid, "verification_required": true}))
                .into_response(),
        );
    }
    let tp = create_session(&st, uid, &ua(&headers), &p.ip, "password").await?;
    Ok(
        Json(json!({"ok": true, "user_id": uid, "verification_required": false, "tokens": tp}))
            .into_response(),
    )
}

async fn send_email_token(
    st: &AppState,
    uid: i64,
    email: &str,
    kind: &str,
    base: &str,
) -> ApiResult<()> {
    let tok = random_token(32);
    let ttl = if kind == "reset" { 3600 } else { 86400 };
    sqlx::query(
        "INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?,?,?,?)",
    )
    .bind(sha256_hex(&tok))
    .bind(uid)
    .bind(kind)
    .bind(now() + ttl)
    .execute(&st.db)
    .await?;
    let (subject, body) = if kind == "reset" {
        (
            "DriveHub 密码重置 / Password reset",
            format!("打开以下链接重置密码（1 小时内有效）:\n{base}/#/reset?token={tok}\n\ntoken: {tok}\n"),
        )
    } else {
        (
            "DriveHub 邮箱验证 / Verify your e-mail",
            format!("打开以下链接验证邮箱（24 小时内有效）:\n{base}/#/verify?token={tok}\n\ntoken: {tok}\n"),
        )
    };
    st.auth
        .mailer()
        .send(Mail {
            to: email.into(),
            subject: subject.into(),
            body,
        })
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, format!("mail: {e}")))
}

async fn take_email_token(st: &AppState, tok: &str, kind: &str) -> ApiResult<i64> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT user_id FROM email_tokens WHERE token_hash = ? AND kind = ? AND used = 0 AND expires_at > ?",
    )
    .bind(sha256_hex(tok))
    .bind(kind)
    .bind(now())
    .fetch_optional(&st.db)
    .await?;
    let uid = row
        .ok_or_else(|| ApiError::bad("invalid or expired token"))?
        .0;
    sqlx::query("UPDATE email_tokens SET used = 1 WHERE token_hash = ?")
        .bind(sha256_hex(tok))
        .execute(&st.db)
        .await?;
    Ok(uid)
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TokenBody {
    pub token: String,
}

/// Confirms an e-mail address with the token from the verification mail.
#[utoipa::path(post, path = "/api/auth/email/verify", request_body = TokenBody, responses((status = 200, description = "verified")))]
pub async fn verify_email(
    State(st): State<AppState>,
    Json(b): Json<TokenBody>,
) -> ApiResult<Json<Value>> {
    let uid = take_email_token(&st, &b.token, "verify").await?;
    sqlx::query("UPDATE users SET email_verified = 1 WHERE id = ?")
        .bind(uid)
        .execute(&st.db)
        .await?;
    Ok(Json(json!({"ok": true})))
}

/// Re-sends the verification mail for the current user.
#[utoipa::path(post, path = "/api/auth/email/resend", responses((status = 200, description = "sent")))]
pub async fn resend_verification(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let email = u
        .email
        .clone()
        .ok_or_else(|| ApiError::bad("no email on account"))?;
    send_email_token(&st, u.id, &email, "verify", &public_base(&st, &headers)).await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ForgotBody {
    pub email: String,
}

/// Sends a password-reset mail (always 200, so it can't be used to probe accounts).
#[utoipa::path(post, path = "/api/auth/password/forgot", request_body = ForgotBody, responses((status = 200, description = "accepted")))]
pub async fn forgot_password(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<ForgotBody>,
) -> ApiResult<Json<Value>> {
    let uid: Option<i64> =
        sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower(?) AND disabled = 0")
            .bind(b.email.trim())
            .fetch_optional(&st.db)
            .await?;
    if let Some(uid) = uid {
        if let Err(e) = send_email_token(
            &st,
            uid,
            b.email.trim(),
            "reset",
            &public_base(&st, &headers),
        )
        .await
        {
            tracing::warn!(error = %e.1, "password reset mail failed");
        }
    }
    Ok(Json(json!({"ok": true})))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ResetBody {
    pub token: String,
    pub new_password: String,
}

/// Sets a new password with a reset token; revokes all sessions of that user.
#[utoipa::path(post, path = "/api/auth/password/reset", request_body = ResetBody, responses((status = 200, description = "password changed")))]
pub async fn reset_password(
    State(st): State<AppState>,
    Json(b): Json<ResetBody>,
) -> ApiResult<Json<Value>> {
    check_password_policy(&b.new_password)?;
    let uid = take_email_token(&st, &b.token, "reset").await?;
    set_password(&st, uid, &b.new_password).await?;
    // a reset link proves mailbox ownership
    sqlx::query("UPDATE users SET email_verified = 1 WHERE id = ?")
        .bind(uid)
        .execute(&st.db)
        .await?;
    Ok(Json(json!({"ok": true})))
}

pub async fn set_password(st: &AppState, uid: i64, pw: &str) -> ApiResult<()> {
    check_password_policy(pw)?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(hash_password(pw)?)
        .bind(uid)
        .execute(&st.db)
        .await?;
    sqlx::query("UPDATE sessions SET revoked = 1 WHERE user_id = ?")
        .bind(uid)
        .execute(&st.db)
        .await?;
    st.auth.forget_basic();
    Ok(())
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ChangePwBody {
    pub old_password: Option<String>,
    pub new_password: String,
}

/// Changes the current user's password (old password required if one is set).
/// All sessions are revoked; a fresh token pair for this device is returned.
#[utoipa::path(post, path = "/api/auth/password/change", request_body = ChangePwBody, responses((status = 200, body = TokenPair)))]
pub async fn change_password(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Json(b): Json<ChangePwBody>,
) -> ApiResult<Json<TokenPair>> {
    let u = p.require_user()?;
    let cur: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(u.id)
        .fetch_one(&st.db)
        .await?;
    if let Some(h) = cur {
        if !b
            .old_password
            .as_deref()
            .is_some_and(|o| verify_password(o, &h))
        {
            return Err(ApiError(
                StatusCode::UNAUTHORIZED,
                "old password incorrect".into(),
            ));
        }
    }
    set_password(&st, u.id, &b.new_password).await?;
    Ok(Json(
        create_session(&st, u.id, &ua(&headers), &p.ip, "password").await?,
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct LoginBody {
    /// username or e-mail
    pub login: String,
    pub password: String,
    pub totp_code: Option<String>,
}

fn totp_required(ticket: Option<String>) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": "totp code required", "totp_required": true, "ticket": ticket})),
    )
        .into_response()
}

/// Password login. Rate limited per account and per IP (429). With TOTP enabled the first
/// call without `totp_code` answers 401 `{"totp_required": true}`.
#[utoipa::path(post, path = "/api/auth/login", request_body = LoginBody, responses((status = 200, body = TokenPair), (status = 401, description = "bad credentials / totp required"), (status = 429, description = "rate limited")))]
pub async fn login(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Json(b): Json<LoginBody>,
) -> ApiResult<Response> {
    let ip = p.ip.clone();
    if st.auth.limiter.blocked(&b.login, &ip) {
        st.audit(
            &p,
            CH_AUTH,
            "login",
            "",
            false,
            &format!("rate limited login={}", b.login),
        );
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "too many failed logins, try again later".into(),
        ));
    }
    let row: Option<(i64, Option<String>, i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT id, password_hash, disabled, email_verified, totp_secret FROM users WHERE username = ? OR lower(email) = lower(?)",
    )
    .bind(b.login.trim())
    .bind(b.login.trim())
    .fetch_optional(&st.db)
    .await?;
    let ok = row
        .as_ref()
        .and_then(|r| r.1.as_deref())
        .is_some_and(|h| verify_password(&b.password, h));
    let fail = |why: &str| {
        st.auth.limiter.fail(&b.login, &ip);
        st.audit(
            &p,
            CH_AUTH,
            "login",
            "",
            false,
            &format!("{why} login={}", b.login),
        );
        ApiError(StatusCode::UNAUTHORIZED, "invalid credentials".into())
    };
    let Some((uid, _, disabled, verified, totp)) = row.filter(|_| ok) else {
        return Err(fail("bad password"));
    };
    if disabled != 0 {
        return Err(ApiError::forbidden("account disabled"));
    }
    if verified == 0 && Settings::load(&st.db).await?.require_email_verification {
        return Err(ApiError::forbidden("email not verified"));
    }
    if let Some(secret) = totp {
        match b.totp_code.as_deref() {
            None | Some("") => return Ok(totp_required(None)),
            Some(c) if !totp_check(&secret, c) => return Err(fail("bad totp")),
            _ => {}
        }
    }
    st.auth.limiter.success(&b.login);
    let tp = create_session(&st, uid, &ua(&headers), &ip, "password").await?;
    Ok(Json(tp).into_response())
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TicketBody {
    pub ticket: String,
    pub code: String,
}

/// Second step for OAuth logins on TOTP-enabled accounts.
#[utoipa::path(post, path = "/api/auth/login/totp", request_body = TicketBody, responses((status = 200, body = TokenPair)))]
pub async fn login_totp(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Json(b): Json<TicketBody>,
) -> ApiResult<Json<TokenPair>> {
    let entry = st.auth.totp_tickets.lock().unwrap().get(&b.ticket).cloned();
    let (uid, method, t) =
        entry.ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "invalid ticket".into()))?;
    if t.elapsed() > Duration::from_secs(300) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "ticket expired".into()));
    }
    let key = format!("uid:{uid}");
    if st.auth.limiter.blocked(&key, &p.ip) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts".into(),
        ));
    }
    let secret: Option<String> = sqlx::query_scalar("SELECT totp_secret FROM users WHERE id = ?")
        .bind(uid)
        .fetch_one(&st.db)
        .await?;
    if !secret.as_deref().is_some_and(|s| totp_check(s, &b.code)) {
        st.auth.limiter.fail(&key, &p.ip);
        return Err(ApiError(StatusCode::UNAUTHORIZED, "invalid code".into()));
    }
    st.auth.totp_tickets.lock().unwrap().remove(&b.ticket);
    Ok(Json(
        create_session(&st, uid, &ua(&headers), &p.ip, &method).await?,
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RefreshBody {
    pub refresh_token: String,
}

/// Rotates the refresh token and issues a new access token. Re-use of an old refresh
/// token revokes the session (theft detection).
#[utoipa::path(post, path = "/api/auth/refresh", request_body = RefreshBody, responses((status = 200, body = TokenPair), (status = 401, description = "invalid")))]
pub async fn refresh(
    State(st): State<AppState>,
    Json(b): Json<RefreshBody>,
) -> ApiResult<Json<TokenPair>> {
    let bad = || ApiError(StatusCode::UNAUTHORIZED, "invalid refresh token".into());
    let (sid, secret) = b.refresh_token.split_once('.').ok_or_else(bad)?;
    let row: Option<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT user_id, refresh_hash, revoked, expires_at FROM sessions WHERE id = ?",
    )
    .bind(sid)
    .fetch_optional(&st.db)
    .await?;
    let (uid, hash, revoked, exp) = row.ok_or_else(bad)?;
    if revoked != 0 || exp <= now() {
        return Err(bad());
    }
    if hash != sha256_hex(secret) {
        sqlx::query("UPDATE sessions SET revoked = 1 WHERE id = ?")
            .bind(sid)
            .execute(&st.db)
            .await?;
        return Err(bad());
    }
    st.load_user(uid).await?.ok_or_else(bad)?;
    let new_secret = random_token(32);
    sqlx::query("UPDATE sessions SET refresh_hash = ?, last_used = ?, expires_at = ? WHERE id = ?")
        .bind(sha256_hex(&new_secret))
        .bind(now())
        .bind(now() + st.auth.refresh_ttl)
        .bind(sid)
        .execute(&st.db)
        .await?;
    Ok(Json(TokenPair {
        access_token: st.auth.issue_access(uid, sid),
        refresh_token: format!("{sid}.{new_secret}"),
        token_type: "Bearer",
        expires_in: st.auth.access_ttl,
        session_id: sid.into(),
    }))
}

/// Revokes the current session.
#[utoipa::path(post, path = "/api/auth/logout", responses((status = 200, description = "ok")))]
pub async fn logout(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    if let Some(sid) = &p.session_id {
        sqlx::query("UPDATE sessions SET revoked = 1 WHERE id = ?")
            .bind(sid)
            .execute(&st.db)
            .await?;
    }
    Ok(Json(json!({"ok": true})))
}

/// Current user.
#[utoipa::path(get, path = "/api/auth/me", responses((status = 200, description = "user"), (status = 401, description = "not logged in")))]
pub async fn me(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let mut v = user_json(&st, u.id).await?;
    v["auth_via"] = json!(p.via);
    v["session_id"] = json!(p.session_id);
    Ok(Json(v))
}

pub async fn list_sessions_of(
    st: &AppState,
    uid: i64,
    current: Option<&str>,
) -> ApiResult<Vec<Value>> {
    let rows: Vec<(String, String, String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT id, user_agent, ip, method, created_at, last_used, expires_at FROM sessions WHERE user_id = ? AND revoked = 0 AND expires_at > ? ORDER BY last_used DESC",
    )
    .bind(uid)
    .bind(now())
    .fetch_all(&st.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, ua, ip, method, c, l, e)| {
            json!({"id": id, "user_agent": ua, "ip": ip, "method": method, "created_at": c, "last_used": l, "expires_at": e, "current": Some(id.as_str()) == current})
        })
        .collect())
}

/// Active sessions / devices of the current user.
#[utoipa::path(get, path = "/api/auth/sessions", responses((status = 200, description = "sessions")))]
pub async fn sessions(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Value>>> {
    let u = p.require_user()?;
    Ok(Json(
        list_sessions_of(&st, u.id, p.session_id.as_deref()).await?,
    ))
}

/// Logs out one device (own sessions; admins any).
#[utoipa::path(delete, path = "/api/auth/sessions/{id}", params(("id" = String, Path)), responses((status = 200, description = "revoked")))]
pub async fn revoke_session(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let r = if u.role == Role::Admin {
        sqlx::query("UPDATE sessions SET revoked = 1 WHERE id = ?")
            .bind(&id)
            .execute(&st.db)
            .await?
    } else {
        sqlx::query("UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?")
            .bind(&id)
            .bind(u.id)
            .execute(&st.db)
            .await?
    };
    if r.rows_affected() == 0 {
        return Err(ApiError::not_found("no such session"));
    }
    Ok(Json(json!({"ok": true})))
}

// ------------------------------------------------------------------ TOTP

/// Starts TOTP enrolment: returns a new secret + otpauth:// URL (confirm with /enable).
#[utoipa::path(post, path = "/api/auth/totp/setup", responses((status = 200, description = "secret")))]
pub async fn totp_setup(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let secret = totp_new_secret();
    sqlx::query("UPDATE users SET totp_pending = ? WHERE id = ?")
        .bind(&secret)
        .bind(u.id)
        .execute(&st.db)
        .await?;
    let label = u.email.clone().unwrap_or_else(|| u.username.clone());
    let url = format!(
        "otpauth://totp/DriveHub:{}?secret={secret}&issuer=DriveHub&algorithm=SHA1&digits=6&period=30",
        url::form_urlencoded::byte_serialize(label.as_bytes()).collect::<String>()
    );
    Ok(Json(json!({"secret": secret, "otpauth_url": url})))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CodeBody {
    pub code: String,
}

/// Confirms enrolment with a valid code and enables TOTP 2FA.
#[utoipa::path(post, path = "/api/auth/totp/enable", request_body = CodeBody, responses((status = 200, description = "enabled")))]
pub async fn totp_enable(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<CodeBody>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let pending: Option<String> = sqlx::query_scalar("SELECT totp_pending FROM users WHERE id = ?")
        .bind(u.id)
        .fetch_one(&st.db)
        .await?;
    let s = pending.ok_or_else(|| ApiError::bad("call /api/auth/totp/setup first"))?;
    if !totp_check(&s, &b.code) {
        return Err(ApiError::bad("invalid code"));
    }
    sqlx::query("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL WHERE id = ?")
        .bind(u.id)
        .execute(&st.db)
        .await?;
    st.auth.forget_basic();
    st.audit(&p, CH_AUTH, "totp_enable", "", true, "");
    Ok(Json(json!({"ok": true})))
}

/// Disables TOTP (requires a current code).
#[utoipa::path(post, path = "/api/auth/totp/disable", request_body = CodeBody, responses((status = 200, description = "disabled")))]
pub async fn totp_disable(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<CodeBody>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let s: Option<String> = sqlx::query_scalar("SELECT totp_secret FROM users WHERE id = ?")
        .bind(u.id)
        .fetch_one(&st.db)
        .await?;
    let s = s.ok_or_else(|| ApiError::bad("totp not enabled"))?;
    if !totp_check(&s, &b.code) {
        return Err(ApiError::bad("invalid code"));
    }
    sqlx::query("UPDATE users SET totp_secret = NULL WHERE id = ?")
        .bind(u.id)
        .execute(&st.db)
        .await?;
    Ok(Json(json!({"ok": true})))
}

// ------------------------------------------------------------------ API tokens / app passwords

#[derive(Debug, Deserialize, ToSchema)]
pub struct NewTokenBody {
    pub name: String,
    /// Optional lifetime in days.
    pub expires_in_days: Option<i64>,
}

/// Personal API tokens (`Authorization: Bearer dh_pat_…`; also accepted as WebDAV password).
#[utoipa::path(get, path = "/api/auth/tokens", responses((status = 200, description = "tokens")))]
pub async fn list_tokens(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Value>>> {
    let u = p.require_user()?;
    let rows: Vec<(i64, String, String, i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT id, name, prefix, created_at, last_used, expires_at FROM api_tokens WHERE user_id = ? ORDER BY id",
    )
    .bind(u.id)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, n, pre, c, l, e)| json!({"id": id, "name": n, "prefix": pre, "created_at": c, "last_used": l, "expires_at": e}))
            .collect(),
    ))
}

/// Creates an API token; the plaintext is only returned once.
#[utoipa::path(post, path = "/api/auth/tokens", request_body = NewTokenBody, responses((status = 200, description = "token")))]
pub async fn create_token(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<NewTokenBody>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    if p.via == "api_token" {
        return Err(ApiError::forbidden("API tokens cannot mint API tokens"));
    }
    let tok = format!("dh_pat_{}", random_token(32));
    let prefix: String = tok.chars().take(12).collect();
    let exp = b.expires_in_days.map(|d| now() + d * 86400);
    let r = sqlx::query("INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at, expires_at) VALUES (?,?,?,?,?,?)")
        .bind(u.id)
        .bind(&b.name)
        .bind(sha256_hex(&tok))
        .bind(&prefix)
        .bind(now())
        .bind(exp)
        .execute(&st.db)
        .await?;
    st.audit(&p, CH_AUTH, "token_create", "", true, &b.name);
    Ok(Json(
        json!({"id": r.last_insert_rowid(), "name": b.name, "token": tok, "expires_at": exp}),
    ))
}

/// Revokes an API token.
#[utoipa::path(delete, path = "/api/auth/tokens/{id}", params(("id" = i64, Path)), responses((status = 200, description = "deleted")))]
pub async fn delete_token(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let r = sqlx::query("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(u.id)
        .execute(&st.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::not_found("no such token"));
    }
    st.auth.forget_basic();
    Ok(Json(json!({"ok": true})))
}

/// WebDAV app-specific passwords (Basic auth `username:app-password`).
#[utoipa::path(get, path = "/api/auth/app-passwords", responses((status = 200, description = "list")))]
pub async fn list_app_passwords(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Value>>> {
    let u = p.require_user()?;
    let rows: Vec<(i64, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, name, created_at, last_used FROM app_passwords WHERE user_id = ? ORDER BY id",
    )
    .bind(u.id)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, n, c, l)| json!({"id": id, "name": n, "created_at": c, "last_used": l}))
            .collect(),
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct NameBody {
    pub name: String,
}

/// Creates an app password; the plaintext is only returned once.
#[utoipa::path(post, path = "/api/auth/app-passwords", request_body = NameBody, responses((status = 200, description = "created")))]
pub async fn create_app_password(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(b): Json<NameBody>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let raw = random_token(18).replace(['-', '_'], "x");
    let pw = format!(
        "{}-{}-{}-{}",
        &raw[0..6],
        &raw[6..12],
        &raw[12..18],
        &raw[18..24]
    );
    let r = sqlx::query(
        "INSERT INTO app_passwords (user_id, name, pw_hash, created_at) VALUES (?,?,?,?)",
    )
    .bind(u.id)
    .bind(&b.name)
    .bind(sha256_hex(&pw))
    .bind(now())
    .execute(&st.db)
    .await?;
    st.audit(&p, CH_AUTH, "app_password_create", "", true, &b.name);
    Ok(Json(
        json!({"id": r.last_insert_rowid(), "name": b.name, "password": pw, "username": u.username}),
    ))
}

/// Deletes an app password.
#[utoipa::path(delete, path = "/api/auth/app-passwords/{id}", params(("id" = i64, Path)), responses((status = 200, description = "deleted")))]
pub async fn delete_app_password(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let r = sqlx::query("DELETE FROM app_passwords WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(u.id)
        .execute(&st.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::not_found("no such app password"));
    }
    st.auth.forget_basic();
    Ok(Json(json!({"ok": true})))
}

// ------------------------------------------------------------------ OAuth

/// Linked external login methods of the current user.
#[utoipa::path(get, path = "/api/auth/identities", responses((status = 200, description = "identities")))]
pub async fn identities(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Value>>> {
    let u = p.require_user()?;
    let rows: Vec<(String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT provider, subject, email, created_at FROM identities WHERE user_id = ?",
    )
    .bind(u.id)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(p, s, e, c)| json!({"provider": p, "subject": s, "email": e, "created_at": c}))
            .collect(),
    ))
}

/// Unlinks a provider (refused if it is the only remaining login method).
#[utoipa::path(delete, path = "/api/auth/identities/{provider}", params(("provider" = String, Path)), responses((status = 200, description = "unlinked")))]
pub async fn unlink_identity(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(provider): Path<String>,
) -> ApiResult<Json<Value>> {
    let u = p.require_user()?;
    let has_pw: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(u.id)
        .fetch_one(&st.db)
        .await?;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM identities WHERE user_id = ?")
        .bind(u.id)
        .fetch_one(&st.db)
        .await?;
    if has_pw.is_none() && n <= 1 {
        return Err(ApiError::bad(
            "cannot remove the last login method; set a password first",
        ));
    }
    sqlx::query("DELETE FROM identities WHERE user_id = ? AND provider = ?")
        .bind(u.id)
        .bind(&provider)
        .execute(&st.db)
        .await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Debug, Deserialize)]
pub struct StartQuery {
    /// link the provider to the logged-in account instead of logging in
    pub link: Option<bool>,
    /// `json` → return `{"url": …}` instead of a 302 (for SPAs that send a Bearer token)
    pub format: Option<String>,
}

/// Starts the OAuth authorization-code flow (302 to the provider).
#[utoipa::path(get, path = "/api/auth/oauth/{provider}/start", params(("provider" = String, Path)), responses((status = 302, description = "redirect to provider")))]
pub async fn oauth_start(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Path(provider): Path<String>,
    Query(q): Query<StartQuery>,
) -> ApiResult<Response> {
    let prov = st
        .auth
        .oauth
        .read()
        .unwrap()
        .get(&provider)
        .cloned()
        .ok_or_else(|| ApiError::not_found("oauth provider not configured"))?;
    let link_user = if q.link.unwrap_or(false) {
        Some(p.require_user()?.id)
    } else {
        None
    };
    let state = random_token(24);
    let redirect_uri = format!(
        "{}/api/auth/oauth/{provider}/callback",
        public_base(&st, &headers)
    );
    {
        let mut m = st.auth.oauth_states.lock().unwrap();
        m.retain(|_, v| v.created.elapsed() < Duration::from_secs(600));
        m.insert(
            state.clone(),
            OAuthState {
                provider: provider.clone(),
                link_user,
                redirect_uri: redirect_uri.clone(),
                created: Instant::now(),
            },
        );
    }
    let mut u = url::Url::parse(&prov.auth_url).map_err(|e| ApiError::bad(e.to_string()))?;
    u.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &prov.client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", &prov.scope)
        .append_pair("state", &state);
    if q.format.as_deref() == Some("json") {
        return Ok(Json(json!({"url": u.to_string()})).into_response());
    }
    Ok(Redirect::to(u.as_str()).into_response())
}

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

struct ExtUser {
    subject: String,
    email: Option<String>,
    email_verified: bool,
    login: Option<String>,
}

async fn fetch_ext_user(
    prov: &OAuthProvider,
    code: &str,
    redirect_uri: &str,
) -> anyhow::Result<ExtUser> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("DriveHub")
        .build()?;
    let tok: Value = http
        .post(&prov.token_url)
        .header("accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", &prov.client_id),
            ("client_secret", &prov.client_secret),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let at = tok["access_token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("token endpoint returned no access_token: {tok}"))?;
    let info: Value = http
        .get(&prov.userinfo_url)
        .bearer_auth(at)
        .header("accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let subject = match (&info["sub"], &info["id"]) {
        (Value::String(s), _) => s.clone(),
        (_, Value::Number(n)) => n.to_string(),
        (_, Value::String(s)) => s.clone(),
        _ => anyhow::bail!("userinfo has no subject"),
    };
    let mut email = info["email"].as_str().map(|s| s.to_lowercase());
    let mut verified = info["email_verified"].as_bool().unwrap_or(false);
    if let Some(eu) = &prov.emails_url {
        if let Ok(r) = http
            .get(eu)
            .bearer_auth(at)
            .header("accept", "application/json")
            .send()
            .await
        {
            if let Ok(list) = r.json::<Vec<Value>>().await {
                if let Some(e) = list
                    .iter()
                    .find(|e| {
                        e["primary"].as_bool() == Some(true)
                            && e["verified"].as_bool() == Some(true)
                    })
                    .or_else(|| list.iter().find(|e| e["verified"].as_bool() == Some(true)))
                {
                    email = e["email"].as_str().map(|s| s.to_lowercase());
                    verified = true;
                }
            }
        }
    }
    Ok(ExtUser {
        subject,
        email,
        email_verified: verified,
        login: info["login"].as_str().map(String::from),
    })
}

fn front_redirect(st: &AppState, headers: &HeaderMap, frag: &str) -> Response {
    let base = st
        .auth
        .public_url
        .clone()
        .unwrap_or_else(|| public_base(st, headers));
    Redirect::to(&format!("{base}/#/oauth?{frag}")).into_response()
}

/// OAuth callback: exchanges the code, then logs in / links / registers, and redirects to
/// the web app with `#/oauth?access_token=…&refresh_token=…` (or `totp_ticket=…`).
#[utoipa::path(get, path = "/api/auth/oauth/{provider}/callback", params(("provider" = String, Path)), responses((status = 302, description = "redirect to web app")))]
pub async fn oauth_callback(
    State(st): State<AppState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Path(provider): Path<String>,
    Query(q): Query<CallbackQuery>,
) -> ApiResult<Response> {
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let err = |m: &str| front_redirect(&st, &headers, &format!("error={}", enc(m)));
    if let Some(e) = q.error {
        return Ok(err(&e));
    }
    let (Some(code), Some(state)) = (q.code, q.state) else {
        return Ok(err("missing code/state"));
    };
    let Some(s) = st.auth.oauth_states.lock().unwrap().remove(&state) else {
        return Ok(err("invalid or expired state"));
    };
    if s.provider != provider || s.created.elapsed() > Duration::from_secs(600) {
        return Ok(err("invalid state"));
    }
    let prov = st.auth.oauth.read().unwrap().get(&provider).cloned();
    let Some(prov) = prov else {
        return Ok(err("provider not configured"));
    };
    let ext = match fetch_ext_user(&prov, &code, &s.redirect_uri).await {
        Ok(x) => x,
        Err(e) => {
            tracing::warn!(%provider, error = %e, "oauth exchange failed");
            return Ok(err("oauth exchange failed"));
        }
    };
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT user_id FROM identities WHERE provider = ? AND subject = ?")
            .bind(&provider)
            .bind(&ext.subject)
            .fetch_optional(&st.db)
            .await?;
    let link = |uid: i64| {
        let st = st.clone();
        let (provider, subject, email) = (provider.clone(), ext.subject.clone(), ext.email.clone());
        async move {
            sqlx::query("INSERT OR IGNORE INTO identities (provider, subject, user_id, email, created_at) VALUES (?,?,?,?,?)")
                .bind(provider)
                .bind(subject)
                .bind(uid)
                .bind(email)
                .bind(now())
                .execute(&st.db)
                .await
        }
    };
    let uid = match (existing, s.link_user) {
        (Some(owner), Some(me)) if owner != me => {
            return Ok(err("this account is already linked to another user"))
        }
        (Some(owner), _) => owner,
        (None, Some(me)) => {
            link(me).await?;
            st.audit(&p, CH_AUTH, "oauth_link", "", true, &provider);
            return Ok(front_redirect(
                &st,
                &headers,
                &format!("linked={}", enc(&provider)),
            ));
        }
        (None, None) => {
            let by_email: Option<i64> = match (&ext.email, ext.email_verified) {
                (Some(e), true) => {
                    sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower(?)")
                        .bind(e)
                        .fetch_optional(&st.db)
                        .await?
                }
                _ => None,
            };
            match by_email {
                Some(uid) => {
                    link(uid).await?;
                    uid
                }
                None => {
                    if !st.auth.initialized() || !Settings::load(&st.db).await?.open_registration {
                        return Ok(err("registration is closed"));
                    }
                    let base = ext
                        .login
                        .clone()
                        .or_else(|| {
                            ext.email
                                .as_ref()
                                .map(|e| e.split('@').next().unwrap_or("").to_string())
                        })
                        .unwrap_or_else(|| format!("{provider}-user"));
                    let mut name = base.clone();
                    let mut i = 1;
                    loop {
                        let taken: Option<i64> =
                            sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
                                .bind(&name)
                                .fetch_optional(&st.db)
                                .await?;
                        if taken.is_none() {
                            break;
                        }
                        i += 1;
                        name = format!("{base}{i}");
                    }
                    let email = if ext.email_verified {
                        ext.email.as_deref()
                    } else {
                        None
                    };
                    let uid = create_user(&st, &name, email, None, Role::User, ext.email_verified)
                        .await?;
                    link(uid).await?;
                    uid
                }
            }
        }
    };
    let row: (i64, Option<String>) =
        sqlx::query_as("SELECT disabled, totp_secret FROM users WHERE id = ?")
            .bind(uid)
            .fetch_one(&st.db)
            .await?;
    if row.0 != 0 {
        return Ok(err("account disabled"));
    }
    let method = format!("oauth:{provider}");
    if row.1.is_some() {
        let t = random_token(24);
        st.auth
            .totp_tickets
            .lock()
            .unwrap()
            .insert(t.clone(), (uid, method, Instant::now()));
        return Ok(front_redirect(&st, &headers, &format!("totp_ticket={t}")));
    }
    let tp = create_session(&st, uid, &ua(&headers), &p.ip, &method).await?;
    st.audit(&p, CH_AUTH, "oauth_login", "", true, &provider);
    Ok(front_redirect(
        &st,
        &headers,
        &format!(
            "access_token={}&refresh_token={}",
            enc(&tp.access_token),
            enc(&tp.refresh_token)
        ),
    ))
}
