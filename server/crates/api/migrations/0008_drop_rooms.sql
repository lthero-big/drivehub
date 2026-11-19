-- DEPTAI-464r: temporary folder share ("drop room" / 快传房间). A room is a share of kind
-- 'room' backed by a dedicated folder (<parent>/.droprooms/<code>) that is deleted when the room
-- expires or is deleted.
ALTER TABLE shares ADD COLUMN kind TEXT NOT NULL DEFAULT 'share';  -- share | room
ALTER TABLE shares ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shares ADD COLUMN max_uploads INTEGER;                  -- file count cap
ALTER TABLE shares ADD COLUMN max_bytes INTEGER;                    -- total uploaded size cap
ALTER TABLE shares ADD COLUMN up_bytes INTEGER NOT NULL DEFAULT 0;  -- bytes uploaded so far
CREATE INDEX IF NOT EXISTS shares_kind ON shares(kind, expires_at);
