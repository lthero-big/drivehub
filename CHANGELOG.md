# Changelog

本项目所有组件（server / web / Android App / Docker 镜像）共用一个版本号，见 `VERSION` 与 [docs/deploy.md](docs/deploy.md)。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.2] - 2026-11-26

### Web
- 左上角图标更新提示与一键更新弹窗（RHEA-276）：侧栏展开与折叠态的品牌图标均支持弹出轻量更新面板，展示当前/最新版本、更新状态、检查更新与一键升级全流程（含确认、进度条、重启重连与刷新提示）；非管理员仅查看版本信息或页面过期刷新提示。
- Dropit Paper 四层设计系统与多皮肤框架（RHEA-277）：统一暖纸配色阶梯与语义 Design Tokens，新增多皮肤切换框架与统一设置页原语组件。
- 挂载点、角色权限与侧栏视觉重构（RHEA-278）：重构挂载管理、角色/权限/ACL 页面交互与视觉层次，优化侧栏布局与信息密度。

### Android
- 模块化拆分与缩略图管线（RHEA-279）：将 `Screens.kt` 拆分到 `ui/screens/` 与 `ui/components/`；接入 Coil 图片/视频缩略图加载（15 MB 以内，可在设置中关闭），支持图片双指缩放与媒体控制条重做，补充 `UiModelTest` 与 Roborazzi 截图测试。
- 方案 C 暖纸极简视觉与交互重构（RHEA-280）：改用与 Web Paper 皮肤同源的 Dropit 暖纸配色，收敛为「跟随系统 / 浅色暖纸 / 深色暖炭」三档主题（旧的暗夜流光、深海极光自动回退为跟随系统）；改为实底 4 Tab 底栏，首页采用 Apple Files 式「浏览」（Large Title、搜索框、「位置」「最近」分组列表）并记住上次打开的网盘；目录页支持分组列表与 3 列纯净画廊；预览页采用纯黑背景，操作抽屉/分享/登录/传输/「我的」统一为分组卡片与 0.5dp 发丝线，传输进度条改为 4dp 品牌红细条；移除 `androidx.palette` 依赖。

### Server & CI
- SQLite 并发稳定性优化（RHEA-282）：`connect()` 改为通过 `SqliteConnectOptions` 显式配置 `busy_timeout = 10s`，并对文件型数据库开启 `journal_mode = WAL` 与 `synchronous = NORMAL`（兼容内存测试库与 `VACUUM INTO` 热备份），并补充单元测试验证。
- 修复 `main` 既有 `cargo fmt` CI 格式检查问题（RHEA-282）。
- 修复 `.github/workflows/release.yml` 中 `android` job 因 `android-actions/setup-android@v3` 请求已废弃的 `tools` 包导致的构建失败，升级为 `android-actions/setup-android@v4`（RHEA-282）。

## [0.1.1] - 2026-11-20

### Android
- 按 PikPak App 风格重做界面：深色主题与绿色强调色、底部四栏导航、彩色圆角文件图标、类型筛选与列表/网格切换、搜索胶囊、传输与「我的」卡片化（DEPTAI-498）。取件码入口改到「我的」和分享页，功能保留。

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
- 统一发布（DEPTAI-478）：根目录 `VERSION` 单一版本来源，`scripts/bump-version.sh` / `scripts/check-version.sh`，CI 版本一致性检查，`v*` tag 触发的发布流水线（server 二进制、web dist、docker 镜像、SHA256SUMS），`scripts/package-release.sh` 本地打包，部署文档 `docs/deploy.md`。
- Android App 一期（DEPTAI-477）：`android/`（Kotlin + Compose M3），版本协商 / 登录（密码、2FA、OAuth）/ 浏览搜索预览 / WorkManager 断点续传上传下载 / 分享与取件码 / 离线目录缓存，release.yml 产出 APK，bump/check-version 覆盖 android；见 `docs/android.md`。
- 原生网盘驱动（DEPTAI-481，移植 OpenList）：`pikpak`（登录/刷新/captcha、列目录、Range 下载、mkdir/rename/move/copy/delete、GCID+OSS 上传）与 `p115` 预览版（Cookie、列目录、m115 下载+Range、mkdir/rename/move/copy/delete、秒传/OSS 上传）；PikPak/115 上传支持 OSS 分片与流式落盘（不整体进内存），PikPak 刷新后的 refresh_token 回写挂载配置，Web 挂载页可选，见 `docs/native-drivers.md`；挂载列表同时隐藏 `cookie` 类选项。
- 挂载点支持启用/停用（DEPTAI-464）：停用后保留配置，但不出现在侧栏、「全部文件」根目录、搜索和 WebDAV 中，直接访问返回 403；管理页卡片和编辑表单都可以开关。新建默认启用。
- Android 应用内更新（DEPTAI-484）：检查 `GET /api/client/android/latest`、下载 APK、SHA-256 校验后走系统 PackageInstaller；普通新版本提示与 `ClientTooOld` 强制升级页均可安装。安装未知来源权限和系统确认都不会被跳过。覆盖安装必须与已安装应用使用同一签名证书。
- `scripts/make-release.sh --android` 与 `scripts/emit-release-manifest.sh` 把 APK 纳入发布清单；CI 在提供 `DRIVEHUB_RELEASE_KEY` 时签名，未提供时只写未签名清单。

### Changed
- **许可证由 MIT 改为 AGPL-3.0-only**（DEPTAI-481）：LICENSE 全文替换，Cargo workspace / 各 crate、web/package.json、Android、Docker 镜像 label 同步；新增 `NOTICE` 与 `THIRD_PARTY.md`，保留 OpenList（AGPL-3.0）版权与来源说明，为移植其 115 / PikPak 驱动做准备。
- 挂载编辑里原「在根目录隐藏」改为「在侧栏和根目录显示」（DEPTAI-464）。
- 115 挂载改为 UID / CID / SEID / KID 分栏输入，保存时拼成 Cookie（DEPTAI-464）。
- 添加/编辑挂载的「传输方式」改用全站统一的分段选择器（自动 / 直链 / 中转）（DEPTAI-464）。

### Fixed
- `/api/client/android/latest` 与 `/download` 不再被版本门控 426 拦住，过旧客户端仍能发现并下载升级包（鉴权边界不变）。
- 本地托管 APK 按版本 / `versionCode` 选择，并能解析 CI 文件名 `drivehub-<ver>-android-<signing>.apk`。
- 添加、保存或删除挂载后，左侧「全部文件」侧栏会立即刷新（DEPTAI-464）。
- 打开 PikPak 挂载编辑时，密码框焦点不再跳到「名称」（DEPTAI-464）。
- 原生 115 / PikPak 驱动真实账号验证中发现的问题（DEPTAI-481）：
  - 115 gettoken 的 STS 字段是 `AccessKeyId`（先前只读 `AccessKeyID`，OSS 签名变成 `OSS :...` 导致 400）；
  - 115 下载直链与 CDN 使用桌面 Chrome UA（`115Browser` UA 会让 CDN 返回 403 no cookie value）；API 仍用 115Browser UA，避免 initupload 提示「请升级到最新版本」；
  - 115 / PikPak 同目录复制先进入临时目录再改名移回（115 会静默空操作，PikPak 返回 `file_move_or_copy_to_cur`）；115 复制后轮询直到对象可见；
  - PikPak OSS 虚拟主机去掉 endpoint 上多余的节点标签（`upload-a10b.mypikpak.com` → `{bucket}.mypikpak.com`，否则 NXDOMAIN）；瞬时 TLS/代理错误自动重试。
- `p115_live_if_configured` 补上上传、Range 下载与跨盘复制（不再依赖 `DRIVEHUB_TEST_115_FILE`）。
