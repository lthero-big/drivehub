-- DEPTAI-485 round 4: personal file / folder tags.
CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL DEFAULT 0,   -- users.id (0 = setup / no-auth mode)
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT 'gray',
    created_at INTEGER NOT NULL,
    UNIQUE (owner_id, name)
);
CREATE TABLE IF NOT EXISTS path_tags (
    tag_id     INTEGER NOT NULL,
    path       TEXT NOT NULL,                -- real normalized path (no leading slash)
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tag_id, path)
);
CREATE INDEX IF NOT EXISTS path_tags_path ON path_tags(path);
