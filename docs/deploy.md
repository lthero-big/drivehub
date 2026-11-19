# DriveHub 部署与发布

DriveHub 由 **server**（Rust 单二进制 `drivehub`，axum）、**web**（React + Vite，产物由服务端通过 `DRIVEHUB_WEB_DIR` 托管）、
**Android App**、**Docker 镜像**（base + runtime）组成，四者 **同一个版本号同版本发布**。

## 1. 版本号

- 唯一来源：仓库根目录 [`VERSION`](../VERSION)（semver `X.Y.Z[-pre]`）。
- `scripts/bump-version.sh X.Y.Z` 写入 `VERSION` 并同步：
  `Cargo.toml [workspace.package].version`（及 `Cargo.lock` 中 `drivehub-*`）、`web/package.json` / `package-lock.json`、
  `android/app/build.gradle(.kts)` 的 `versionName` 与 `versionCode = X*10000 + Y*100 + Z`（存在 `android/` 时）、
  `deploy/docker-compose.yml` 默认镜像 tag。
- `scripts/check-version.sh [vX.Y.Z]`：任一处不一致即失败；CI 每次 push 都跑，发布时还要求 tag 与 `VERSION` 相同。
  `server/crates/core/tests/version_file.rs` 也会在 `cargo test` 中校验 `VERSION == CARGO_PKG_VERSION`。
- Docker 镜像 tag = 版本号 + `latest`；base 镜像 tag = `deploy/base.Dockerfile` 内容哈希（只在依赖变化时重建）。

### 版本匹配（DEPTAI-466）

| 字段（`GET /api/version`） | 含义 |
|---|---|
| `server_version` | 服务端发布版本（= `VERSION`） |
| `api_version` | API 大版本，只有破坏性变更才加 1 |
| `min_app_version` / `min_web_version` | 服务端仍支持的最旧 App / Web 版本（`server/crates/core/src/version.rs`） |

客户端在 `/api/v1/*` 请求上带 `x-drivehub-client: app/X.Y.Z`（或 `web/X.Y.Z`）与 `x-drivehub-api: N`：
客户端低于最低版本 → `426 {"status":"client_too_old","min_version":…}`（提示升级 App / 刷新页面）；
客户端 API 大版本高于服务端 → `426 {"status":"server_too_old"}`（需要升级服务端）。
Web 与服务端总是同包发布（web 产物随服务端一起替换），因此正常部署下 web 永远匹配；Android App 需与服务端同版本或在 `min_app_version` 之上。
发版时若引入了旧客户端无法使用的变更，同时上调 `MIN_APP_VERSION` / `MIN_WEB_VERSION`；破坏性 API 变更上调 `API_VERSION`。

## 2. 发布流程

```bash
scripts/bump-version.sh 0.2.0
# 编辑 CHANGELOG.md：把 [Unreleased] 改成 [0.2.0] - YYYY-MM-DD
git commit -am "release: v0.2.0"
git tag v0.2.0 && git push origin main --tags
```

`v*` tag 触发 `.github/workflows/release.yml`（GitLab 等价模板：`deploy/ci/gitlab-ci.yml`，复制为 `/.gitlab-ci.yml` 并挂 runner 后启用）：

| job | 产物 |
|---|---|
| `version` | 校验 tag == `VERSION` == 各处版本 |
| `test` | `cargo test --workspace --locked` |
| `web` | `web/dist` |
| `server`（linux amd64；arm64 用 `ubuntu-24.04-arm` runner，矩阵里已注释） | `drivehub-linux-amd64`、`web.tar.gz`、`drivehub-X.Y.Z-linux-amd64.tar.gz`、`SHA256SUMS`，并冒烟 `/api/version` |
| `docker` | 构建 base → runtime（`drivehub:X.Y.Z` + `drivehub:latest`），容器冒烟，`drivehub-X.Y.Z-docker-amd64.tar.gz` + sha256 |
| `checksums` | 汇总所有构件与总 `SHA256SUMS` |

构件只上传为 workflow artifacts；推送镜像（ghcr）和创建 GitHub Release 的步骤已写好但注释掉，确定仓库后再打开。
本地打包同一套构件：`scripts/package-release.sh`（输出 `dist/vX.Y.Z/`）；本地镜像：`deploy/build.sh`。

## 3. Docker Compose 部署

```bash
mkdir drivehub && cd drivehub
curl -O <仓库>/deploy/docker-compose.yml          # 或从发布包里取
# 离线镜像：docker load < drivehub-X.Y.Z-docker-amd64.tar.gz
echo "DRIVEHUB_TAG=X.Y.Z" > .env                   # 可选：DRIVEHUB_IMAGE / DRIVEHUB_PORT
docker compose up -d
curl -fsS http://127.0.0.1:8470/api/version
```

- 数据：`./data`（SQLite 数据库、索引、任务等）；配置：`./config/drivehub.toml`（可选，环境变量优先）。
- 容器内以 uid 10001 运行，首次需 `sudo chown -R 10001 data config`。
- 环境变量（SMTP、OAuth、`DRIVEHUB_PUBLIC_URL` 等）见 README「环境变量」，在 compose 里加 `environment:` 即可。
- 可选 Postgres：`docker compose --profile pg up -d`。

## 4. 二进制部署

```bash
tar xzf drivehub-X.Y.Z-linux-amd64.tar.gz && cd drivehub-X.Y.Z-linux-amd64
sha256sum -c ../SHA256SUMS --ignore-missing
sudo install -m755 drivehub /opt/drivehub/drivehub && sudo cp -r web /opt/drivehub/web
DRIVEHUB_BIND=0.0.0.0:8470 DRIVEHUB_DATA_DIR=/var/lib/drivehub DRIVEHUB_WEB_DIR=/opt/drivehub/web /opt/drivehub/drivehub
```

运行时依赖：`rclone`（rclone 挂载桥）、`ffmpeg`（视频缩略图/转码），与 base 镜像一致。systemd 示例：

```ini
[Unit]
Description=DriveHub
After=network-online.target
[Service]
User=drivehub
Environment=DRIVEHUB_BIND=0.0.0.0:8470 DRIVEHUB_DATA_DIR=/var/lib/drivehub DRIVEHUB_WEB_DIR=/opt/drivehub/web
ExecStart=/opt/drivehub/drivehub
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

pm2 亦可：`pm2 start /opt/drivehub/drivehub --name drivehub`（环境变量同上）。

## 5. 升级与回滚

数据库迁移在启动时自动执行且 **只进不退**，所以回滚 = 旧程序 + 升级前的数据备份。

**升级**

1. 阅读 CHANGELOG（注意 `min_app_version` 是否上调——旧 App 会收到 426）。
2. 停服务并备份整个数据目录：
   `systemctl stop drivehub && cp -a /var/lib/drivehub /var/lib/drivehub.bak-$(date +%Y%m%d%H%M)`
   （compose：`docker compose stop && cp -a data data.bak-$(date +%Y%m%d%H%M)`）。
3. 替换二进制 + web 目录（保留旧文件为 `drivehub.prev` / `web.prev`），或 compose 中改 `DRIVEHUB_TAG` 后 `docker compose pull/up -d`。
4. 启动并检查 `GET /api/version` 的 `server_version`、`GET /api/v1/health` 返回 200、登录与列表正常。

**回滚**

1. 停服务。
2. 恢复旧二进制 / web（或把 `DRIVEHUB_TAG` 改回旧版本）。
3. 用升级前备份 **整体替换** 数据目录（新版本可能已执行迁移，旧程序不能直接读新库）：
   `rm -rf /var/lib/drivehub && mv /var/lib/drivehub.bak-<时间> /var/lib/drivehub`。
4. 启动并核对版本号。备份之后产生的数据会丢失，请在维护窗口内操作。

> DEPTAI-484（自动更新）合入后，服务端可自行下载、校验、备份数据库并在健康检查失败时自动回滚；以上手动流程仍是兜底方案。
