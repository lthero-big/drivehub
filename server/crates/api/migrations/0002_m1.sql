-- M1 (DEPTAI-468/469/470): mount points, file metadata index, background tasks.
CREATE TABLE IF NOT EXISTS mounts (
    name          TEXT PRIMARY KEY NOT NULL,
    kind          TEXT NOT NULL,              -- fs | s3 | webdav
    options       TEXT NOT NULL DEFAULT '{}', -- JSON object of driver options
    read_only     INTEGER NOT NULL DEFAULT 0,
    hidden        INTEGER NOT NULL DEFAULT 0,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    transfer_mode TEXT NOT NULL DEFAULT 'auto', -- direct | proxy | auto
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    mount         TEXT NOT NULL,
    path          TEXT NOT NULL,
    name          TEXT NOT NULL,
    ext           TEXT NOT NULL,
    size          INTEGER NOT NULL,
    is_dir        INTEGER NOT NULL,
    modified_unix INTEGER,
    indexed_at    INTEGER NOT NULL,
    PRIMARY KEY (mount, path)
);
CREATE INDEX IF NOT EXISTS files_ext ON files(ext);
CREATE INDEX IF NOT EXISTS files_size ON files(size);

CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,                  -- copy | move
    src         TEXT NOT NULL,
    dst         TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
    done_bytes  INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
UPDATE meta SET value = '2' WHERE key = 'schema_version';
