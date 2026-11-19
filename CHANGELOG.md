# Changelog

本项目所有组件（server / web / Android App / Docker 镜像）共用一个版本号，见 `VERSION` 与 [docs/deploy.md](docs/deploy.md)。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- **许可证由 MIT 改为 AGPL-3.0-only**（DEPTAI-481）：LICENSE 全文替换，Cargo workspace / 各 crate、web/package.json、Android、Docker 镜像 label 同步；新增 `NOTICE` 与 `THIRD_PARTY.md`，保留 OpenList（AGPL-3.0）版权与来源说明，为移植其 115 / PikPak 驱动做准备。

### Added
- 原生网盘驱动（DEPTAI-481，移植 OpenList）：`pikpak`（登录/刷新/captcha、列目录、Range 下载、mkdir/rename/move/copy/delete、GCID+OSS 上传）与 `p115` 预览版（Cookie、列目录、m115 下载+Range、mkdir/rename/move/copy/delete；上传未支持），Web 挂载页可选，见 `docs/native-drivers.md`；挂载列表同时隐藏 `cookie` 类选项。
- Android App 一期（DEPTAI-477）：`android/`（Kotlin + Compose M3），版本协商 / 登录（密码、2FA、OAuth）/ 浏览搜索预览 / WorkManager 断点续传上传下载 / 分享与取件码 / 离线目录缓存，release.yml 产出 APK，bump/check-version 覆盖 android；见 `docs/android.md`。
- 统一发布（DEPTAI-478）：根目录 `VERSION` 单一版本来源，`scripts/bump-version.sh` / `scripts/check-version.sh`，
  CI 版本一致性检查，`v*` tag 触发的发布流水线（server 二进制、web dist、docker 镜像、SHA256SUMS），
  `scripts/package-release.sh` 本地打包，部署文档 `docs/deploy.md`。

## [0.1.0] - 2026-11-19

首个内部版本（DEPTAI-464 Epic）。

### Added
- Monorepo：Rust workspace（api / core / storage / search / webdav）、React + Vite Web、base + runtime 分层 Docker 镜像与 compose。
- 版本协商：`GET /api/version`、`x-drivehub-client` / `x-drivehub-api` 头、426 `client_too_old` / `server_too_old`（DEPTAI-466）。
- 存储挂载（fs / S3 / WebDAV / rclone / OpenList 桥）、虚拟目录树、上传下载（Range、直链）、跨存储后台任务（DEPTAI-468/469/470）。
- 关键词搜索（tantivy + jieba）。
- 账户与认证：初始管理员、注册开关、邮箱验证/找回密码（SMTP 或 log 通道）、TOTP、会话管理、API Token、应用专用密码、Google / GitHub OAuth（DEPTAI-471）。
- 权限：子树 ACL 规则、目录访问 gate、有效权限查看器、审计日志；角色统一与至少一名管理员保护（DEPTAI-472/464）。
- WebDAV（DEPTAI-473）、分享与收件夹（drop room）。
- Web UI 重设计：文件标签、命令面板、媒体播放器、访问统计等（DEPTAI-485）。
