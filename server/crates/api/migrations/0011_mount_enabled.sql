-- DEPTAI-464: mounts can be disabled without deleting their config.
ALTER TABLE mounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
