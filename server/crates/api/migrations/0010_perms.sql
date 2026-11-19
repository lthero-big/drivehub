-- DEPTAI-485 r5: finer-grained permissions. Keep existing behaviour for stored rules / roles:
--   read  -> + copy(512) + tag(2048)
--   edit  -> + rename(128) + move(256)            (edit used to cover rename / move)
--   share & upload -> + share_upload(1024)
-- The same mapping is applied to deny masks so existing denials stay effective.
UPDATE acl_rules SET allow_bits = allow_bits
    | (CASE WHEN allow_bits & 1  != 0 THEN 512 | 2048 ELSE 0 END)
    | (CASE WHEN allow_bits & 16 != 0 THEN 128 | 256 ELSE 0 END)
    | (CASE WHEN allow_bits & 64 != 0 AND allow_bits & 4 != 0 THEN 1024 ELSE 0 END),
  deny_bits = deny_bits
    | (CASE WHEN deny_bits & 1  != 0 THEN 512 | 2048 ELSE 0 END)
    | (CASE WHEN deny_bits & 16 != 0 THEN 128 | 256 ELSE 0 END)
    | (CASE WHEN deny_bits & 64 != 0 THEN 1024 ELSE 0 END)
    | (CASE WHEN deny_bits & 127 = 127 THEN 1048575 ELSE 0 END);
UPDATE roles SET permissions = permissions
    | (CASE WHEN permissions & 1  != 0 THEN 512 | 2048 ELSE 0 END)
    | (CASE WHEN permissions & 16 != 0 THEN 128 | 256 ELSE 0 END)
    | (CASE WHEN permissions & 64 != 0 AND permissions & 4 != 0 THEN 1024 ELSE 0 END);
UPDATE roles SET description = '管理：全部文件与分享权限（不含管理后台）' WHERE name = 'manager' AND builtin = 1;
