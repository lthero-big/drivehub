-- M2 (DEPTAI-471/472/473): users, auth, ACL, audit.
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    email          TEXT UNIQUE,
    password_hash  TEXT,                       -- argon2id PHC string; NULL = OAuth-only
    role           TEXT NOT NULL DEFAULT 'user', -- admin | user | guest
    disabled       INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0,
    totp_secret    TEXT,                       -- base32, set once 2FA is enabled
    totp_pending   TEXT,                       -- base32 during enrolment
    root_path      TEXT NOT NULL DEFAULT '',   -- jail root (virtual path, '' = whole tree)
    visible_mounts TEXT,                       -- JSON array, NULL = all
    quota_bytes    INTEGER,                    -- NULL = unlimited
    used_bytes     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_groups (
    user_id  INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, group_id)
);

-- External login methods linked to a user (google / github ...).
CREATE TABLE IF NOT EXISTS identities (
    provider   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    user_id    INTEGER NOT NULL,
    email      TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
);

CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY NOT NULL,
    user_id      INTEGER NOT NULL,
    refresh_hash TEXT NOT NULL,
    user_agent   TEXT NOT NULL DEFAULT '',
    ip           TEXT NOT NULL DEFAULT '',
    method       TEXT NOT NULL DEFAULT 'password',
    created_at   INTEGER NOT NULL,
    last_used    INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used  INTEGER,
    expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS app_passwords (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    pw_hash    TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used  INTEGER
);

CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_id    INTEGER NOT NULL,
    kind       TEXT NOT NULL,     -- verify | reset
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS acl_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT NOT NULL,           -- normalized virtual dir, '' = root
    subject_type TEXT NOT NULL,           -- anonymous | logged_in | group | user
    subject_id   INTEGER,
    allow_bits   INTEGER NOT NULL DEFAULT 0,
    deny_bits    INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acl_gates (
    path          TEXT PRIMARY KEY NOT NULL,
    modes         INTEGER NOT NULL,       -- 1 anonymous | 2 logged-in | 4 password
    password_hash TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    user_id  INTEGER,
    username TEXT NOT NULL DEFAULT '',
    channel  TEXT NOT NULL,               -- api | webdav | auth
    action   TEXT NOT NULL,
    path     TEXT NOT NULL DEFAULT '',
    allowed  INTEGER NOT NULL,
    detail   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts);
UPDATE meta SET value = '3' WHERE key = 'schema_version';
