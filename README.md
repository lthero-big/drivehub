# DriveHub · 多网盘管理

Monorepo（DEPTAI-464）：

| 目录 | 内容 |
|---|---|
| `server/crates/api` | axum HTTP 服务（二进制 `drivehub`）、迁移、OpenAPI（utoipa） |
| `server/crates/core` | 配置加载（TOML + DRIVEHUB_* 环境变量）、版本契约与协商 |
| `server/crates/storage` | `StorageDriver` trait + OpenDAL 实现（fs / s3 / webdav；rclone serve webdav、OpenList /dav 走 webdav 桥） |
| `server/crates/search` | tantivy + jieba 关键词索引、`ext: size: mount:` 语法；Embedder / VectorStore Noop 占位；AclFilter 钩子 |
| `server/crates/webdav` | WebDAV（M2） |
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
