# DriveHub · 多网盘管理

Monorepo（DEPTAI-464）：

| 目录 | 内容 |
|---|---|
| `server/crates/api` | axum HTTP 服务（二进制 `drivehub`）、迁移、OpenAPI（utoipa） |
| `server/crates/core` | 配置加载（TOML + DRIVEHUB_* 环境变量）、版本契约与协商、ACL 引擎（`acl.rs`，纯逻辑） |
| `server/crates/storage` | `StorageDriver` trait + OpenDAL 实现（fs / s3 / webdav；rclone serve webdav、OpenList /dav 走 webdav 桥） |
| `server/crates/search` | tantivy + jieba 关键词索引、`ext: size: mount:` 语法；Embedder / VectorStore Noop 占位；AclFilter 钩子 |
| `server/crates/webdav` | WebDAV：dav-server `GuardedFileSystem` over per-request `Backend`（M2） |
| `web/` | React + TS + Vite + Tailwind |
| `deploy/` | base / runtime 分层 Dockerfile、compose、build.sh |
| `api/openapi.json` | 提交的 API 契约，CI 校验 |

## 本地运行

```bash
cargo test --workspace
(cd web && npm install && npm run build)
DRIVEHUB_BIND=0.0.0.0:8470 DRIVEHUB_WEB_DIR=web/dist cargo run --bin drivehub
```

## 版本协商

- `GET /api/version` → `server_version / api_version / min_app_version / min_web_version`
- 客户端请求 `/api/v1/*` 时带 `x-drivehub-client: app/0.1.0`（或 `web/…`）和 `x-drivehub-api: 1`。
- 客户端过旧 → 426 `{"status":"client_too_old","min_version":…}`；客户端 API 大版本更高 → 426 `{"status":"server_too_old"}`。

## M1 API（DEPTAI-468/469/470）

虚拟目录树：`/` 列出挂载点，`/<挂载名>/<路径>` 映射到对应存储。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/mounts` | 挂载点列表 / 新增或更新（`name kind options read_only hidden sort_order transfer_mode=direct\|proxy\|auto`），凭据字段返回时打码 |
| DELETE | `/api/mounts/{name}` | 删除挂载点（不动后端文件） |
| GET | `/api/fs/list?path=&page=&per_page=&sort=name\|size\|modified&order=asc\|desc&refresh=` | 分页排序列表，目录 TTL 缓存（`DRIVEHUB_LIST_TTL_SECS`，默认 30s） |
| GET | `/api/fs/stat?path=` | 元数据 |
| GET | `/api/fs/download?path=` | 支持 `Range`；direct/auto 且后端有直链（S3 预签名）时 302 |
| PUT/POST | `/api/fs/upload?path=&overwrite=` | 请求体即文件内容（流式） |
| POST | `/api/fs/mkdir` `/rename` `/copy` `/move` `/delete` | 同存储同步执行；跨存储 copy/move 进后台任务 |
| GET | `/api/tasks` `/api/tasks/{id}` | 任务进度（SQLite 持久化，重启后 running→pending 自动续跑） |
| GET | `/api/search?q=&mode=keyword\|semantic\|hybrid` | 关键词搜索；semantic/hybrid 返回 `enabled:false` |
| POST | `/api/search/reindex?mount=` | 扫描挂载点重建 `files` 表与索引（变更后也会后台自动重建） |

搜索基准：`scripts/bench-search.sh [N]`（默认 10 万条合成元数据）。
S3 / WebDAV 实测：设置 `DRIVEHUB_TEST_S3_ENDPOINT/KEY/SECRET[/BUCKET]`、`DRIVEHUB_TEST_DAV_ENDPOINT` 后 `cargo test -p drivehub-storage`。

## M2：账户 / 权限 / WebDAV（DEPTAI-471/472/473）

**首次启动**：库里没有用户时处于 setup 模式（兼容 M1，全部放行），`GET /api/auth/status` 返回 `initialized:false`；
`POST /api/auth/init {username,email,password}` 创建唯一的初始管理员（之后 409），并写入默认规则「已登录用户 根目录 read+download」。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/status` | 初始化状态、是否开放注册、邮件通道（smtp/log）、OAuth 提供方、当前用户 |
| POST | `/api/auth/register` | 自助注册（管理员关闭「开放注册」时 403） |
| POST | `/api/auth/login` `{login,password,totp_code?}` | Argon2id 校验；开启 TOTP 时先回 401 `{totp_required:true}`；账号/IP 失败次数限流 → 429 |
| POST | `/api/auth/refresh` / `logout` | JWT(HS256) access 15min + 轮换 refresh 30d；旧 refresh 复用 → 吊销会话 |
| GET/DELETE | `/api/auth/sessions[/{id}]` | 设备/会话列表、下线单个设备；管理员 `POST /api/admin/users/{id}/logout` 强制下线 |
| POST | `/api/auth/totp/setup` `enable` `disable` | TOTP 两步验证（RFC 6238，otpauth URL） |
| POST | `/api/auth/password/forgot` `reset` `change`、`/api/auth/email/verify` `resend` | 邮件 token（SMTP 或 log 通道） |
| GET/POST/DELETE | `/api/auth/tokens` | 个人 API Token（`Bearer dh_pat_…`，也可作 WebDAV 密码） |
| GET/POST/DELETE | `/api/auth/app-passwords` | WebDAV 应用专用密码 |
| GET | `/api/auth/oauth/{google\|github}/start[?link=true&format=json]` → `/callback` | 授权码流程；按 provider subject / 已验证邮箱关联，一个用户可绑定多种登录方式（`/api/auth/identities`） |
| GET/PUT | `/api/admin/settings` | `open_registration` / `require_email_verification` |
| CRUD | `/api/admin/users[/{id}]`、`/api/admin/groups` | 角色 admin/user/guest、禁用、用户组、`root_path`（用户根目录）、`visible_mounts`、`quota_bytes` |
| GET | `/api/admin/audit?denied=true&channel=api\|webdav\|auth` | 审计日志（拒绝的操作全部记录，写操作成功也记录） |
| GET/POST/DELETE | `/api/acl/rules` | 子树规则：subject anonymous/logged_in/group/user，allow/deny 位 read download upload create edit delete share |
| GET/PUT | `/api/acl/gates` | 目录访问方式 anonymous / logged_in / password（可组合；密码经 `x-drivehub-path-password` 头或 `?path_password=`） |
| GET | `/api/acl/effective?path=&user_id=` | 有效权限查看器（含命中的 gate 与规则轨迹） |
| * | `/dav/` | WebDAV（Basic：账户密码〔开 TOTP 后拒绝〕/ 应用密码 / API Token；Bearer 亦可） |

ACL 规则：从根到目标逐层应用，同层按 anonymous < logged_in < group < user 的顺序 `bits = (bits | allow) & !deny`，深层覆盖浅层；最近的 gate 决定能否进入；admin 全部放行，guest 最多 read+download。
Web/API、WebDAV、搜索全部走同一个 `AppState::perms/authorize`（`server/crates/api/src/auth.rs`），`tests/m2.rs::permissions_consistent_across_api_webdav_search` 校验三者一致。

**环境变量**

| 变量 | 说明 |
|---|---|
| `DRIVEHUB_PUBLIC_URL` | 对外地址（OAuth 回调、邮件链接），如 `https://drive.example.com`；缺省取请求 Host |
| `DRIVEHUB_JWT_SECRET` | 可选；缺省自动生成并存入 meta 表 |
| `DRIVEHUB_ACCESS_TTL_SECS` / `DRIVEHUB_REFRESH_TTL_SECS` | 默认 900 / 2592000 |
| `DRIVEHUB_LOGIN_MAX_FAILS` / `_IP` / `DRIVEHUB_LOGIN_WINDOW_SECS` | 限流：默认每账号 5 次、每 IP 30 次 / 900 秒 |
| `DRIVEHUB_SMTP_HOST` `_PORT` `_USERNAME` `_PASSWORD` `_FROM` `_SECURITY=starttls\|tls\|none` | SMTP；未设置 HOST 时用 log 通道（邮件内容写日志） |
| `DRIVEHUB_OAUTH_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` | Google 登录；回调 `<PUBLIC_URL>/api/auth/oauth/google/callback` |
| `DRIVEHUB_OAUTH_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` | GitHub 登录；回调 `<PUBLIC_URL>/api/auth/oauth/github/callback` |
| `DRIVEHUB_OAUTH_<P>_AUTH_URL` `_TOKEN_URL` `_USERINFO_URL` `_EMAILS_URL` `_SCOPE` | 可选端点覆盖（测试 / 自建） |
| `DRIVEHUB_DAV_SPOOL` | WebDAV 上传暂存目录（默认系统 tmp） |

冒烟：`BASE=http://127.0.0.1:8473 FILES=<fs root> ADMIN_PW=… scripts/smoke-m2.sh`（curl + rclone webdav）。
