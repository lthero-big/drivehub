# DriveHub · 多网盘管理

Monorepo（DEPTAI-464）：

| 目录 | 内容 |
|---|---|
| `server/crates/api` | axum HTTP 服务（二进制 `drivehub`）、迁移、OpenAPI（utoipa） |
| `server/crates/core` | 配置加载（TOML + DRIVEHUB_* 环境变量）、版本契约与协商 |
| `server/crates/storage` | 存储驱动 trait（M1 接 OpenDAL / rclone 桥） |
| `server/crates/search` | 搜索；Embedder / VectorStore Noop 占位 |
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
