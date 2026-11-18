-- DEPTAI-485 round 3: RBAC roles. A role is a named bundle of permission bits that is
-- granted at the root ("") for every user / group it is assigned to. Explicit ACL rules on
-- deeper directories still override it (deny wins as before), so existing behaviour is kept.
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    permissions INTEGER NOT NULL DEFAULT 0,
    builtin     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, role_id)
);
CREATE TABLE IF NOT EXISTS group_roles (
    group_id INTEGER NOT NULL,
    role_id  INTEGER NOT NULL,
    PRIMARY KEY (group_id, role_id)
);
INSERT OR IGNORE INTO roles (name, description, permissions, builtin, created_at) VALUES
  ('viewer',  '只读：浏览与下载', 3, 1, strftime('%s','now')),
  ('editor',  '读写：上传、新建、编辑', 31, 1, strftime('%s','now')),
  ('manager', '管理：全部文件权限（含删除、分享）', 127, 1, strftime('%s','now'));
