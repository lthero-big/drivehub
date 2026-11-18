-- M3 (DEPTAI-474/475): shares, audit v2 (rich fields + hash chain, append-only), alerts.
ALTER TABLE audit_log ADD COLUMN ip TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_log ADD COLUMN ua TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_log ADD COLUMN client TEXT NOT NULL DEFAULT '';   -- web | android | webdav | api
ALTER TABLE audit_log ADD COLUMN storage TEXT NOT NULL DEFAULT '';  -- mount name
ALTER TABLE audit_log ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audit_log ADD COLUMN share_id INTEGER;
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_log ADD COLUMN hash TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS audit_user ON audit_log(username, ts);
CREATE INDEX IF NOT EXISTS audit_action ON audit_log(action, ts);
CREATE INDEX IF NOT EXISTS audit_share ON audit_log(share_id);

-- Append-only: sealed rows can never be updated; rows can only be deleted by the retention
-- purge, which first moves the chain anchor (meta audit.anchor_id) past them.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
WHEN OLD.hash != ''
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
WHEN OLD.id > COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'audit.anchor_id'), 0)
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE IF NOT EXISTS shares (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE,
    owner_id      INTEGER,
    owner_name    TEXT NOT NULL DEFAULT '',
    name          TEXT NOT NULL,
    items         TEXT NOT NULL,               -- JSON array of normalized real virtual paths
    perm          TEXT NOT NULL DEFAULT 'download', -- preview | download | upload
    pin           TEXT,
    require_login INTEGER NOT NULL DEFAULT 0,
    expires_at    INTEGER,
    max_visits    INTEGER,
    max_downloads INTEGER,
    visits        INTEGER NOT NULL DEFAULT 0,
    downloads     INTEGER NOT NULL DEFAULT 0,
    uploads       INTEGER NOT NULL DEFAULT 0,
    bytes         INTEGER NOT NULL DEFAULT 0,
    revoked       INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_access   INTEGER
);
CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_id);

CREATE TABLE IF NOT EXISTS alert_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,                 -- burst | new_ip_login
    actions     TEXT NOT NULL DEFAULT '',      -- comma list for burst (download,delete,…)
    threshold   INTEGER NOT NULL DEFAULT 0,
    window_secs INTEGER NOT NULL DEFAULT 60,
    sink        TEXT NOT NULL DEFAULT 'log',   -- log | webhook | email
    target      TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    rule_id   INTEGER NOT NULL,
    rule_name TEXT NOT NULL,
    username  TEXT NOT NULL DEFAULT '',
    ip        TEXT NOT NULL DEFAULT '',
    message   TEXT NOT NULL,
    sink      TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    error     TEXT NOT NULL DEFAULT ''
);
UPDATE meta SET value = '4' WHERE key = 'schema_version';
