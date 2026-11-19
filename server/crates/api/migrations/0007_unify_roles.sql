-- DEPTAI-464r: unify "account type" (users.role) with RBAC roles. Builtin roles admin / user /
-- guest carry an account `level`; a user's effective level is derived from the roles assigned to
-- them directly or via their groups (admin > user > guest). users.role is kept as a derived cache
-- for backward compatibility and is no longer edited directly.
ALTER TABLE roles ADD COLUMN level TEXT;
INSERT OR IGNORE INTO roles (name, description, permissions, builtin, created_at) VALUES
  ('admin', '管理员：全部权限，可管理系统', 127, 1, strftime('%s','now')),
  ('user',  '普通用户：在自己的空间内读写', 0, 1, strftime('%s','now')),
  ('guest', '访客：最多只读 + 下载', 0, 1, strftime('%s','now'));
UPDATE roles SET level = name, builtin = 1 WHERE name IN ('admin', 'user', 'guest');
INSERT OR IGNORE INTO user_roles (user_id, role_id)
  SELECT u.id, r.id FROM users u JOIN roles r ON r.level = u.role;
