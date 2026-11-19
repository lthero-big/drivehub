# Android App（DEPTAI-477 一期）

Kotlin + Jetpack Compose（Material 3）客户端，代码在 `android/`，版本号与服务端同源（根 `VERSION`）。

## 功能（一期）
- 服务器地址配置；启动时**版本协商**：`GET /api/version` → App 低于 `min_app_version` 提示「请升级 App」，App 的 API 大版本高于服务端提示「服务器过旧」，
  非 DriveHub 地址 / 无法连接也有明确提示；之后所有请求都带 `x-drivehub-client: app/<ver>` + `x-drivehub-api: 1`，服务端 426 同样会被转成升级提示。
- 登录：密码、TOTP 两步验证（`totp_required` → 验证码）、OAuth（WebView 走 `/api/auth/oauth/<provider>/start`，截获回跳的 `#/oauth?access_token=…` / `totp_ticket=…`；
  provider 列表来自 `/api/auth/status`，需服务端已配置 client id）。Access token 过期自动 refresh。
- 浏览、搜索、预览（图片 / 视频与音频 ExoPlayer 边下边播 / PDF `PdfRenderer` / 文本）、新建文件夹、重命名、删除。
- 上传 / 下载走 WorkManager：上传用 `/api/fs/uploads` 会话（会话 id 持久化，进程被杀后从服务端 `offset` 续传），下载用 HTTP `Range` 续传 `.part`；前台通知、网络约束、指数退避重试；下载目录 = `Android/data/com.drivehub.app/files/Download`。
- 分享创建（预览 / 下载 / 收集上传、有效期、随机 PIN）与管理（列表、复制取件码、撤销、删除）；取件码领取（含 PIN 与文件夹浏览、下载）。
- 离线缓存：目录列表按 服务器+路径 缓存，断网时显示缓存（带「离线」提示）；预览文件缓存在 cacheDir；已下载文件保留在下载目录。
- 不做（二期）：相册自动备份。

## API 客户端
未使用 OpenAPI 代码生成器：`android/app/.../data/ApiClient.kt` 是基于 `api/openapi.json` 手写的 OkHttp + kotlinx-serialization 客户端（只覆盖 App 用到的接口），
模型见 `Models.kt`。服务端 `version`/`min_app_version` 能力在 DEPTAI-466 已存在，本任务未改服务端。

## 构建
```bash
# 需要 JDK 17+、Android SDK（platforms;android-35, build-tools;35.0.0），android/local.properties 写 sdk.dir=…
cd android
./gradlew testDebugUnitTest assembleDebug assembleRelease
# APK: app/build/outputs/apk/{debug,release}/
```
- 版本：`scripts/bump-version.sh X.Y.Z` 同步 `versionName` 与 `versionCode = X*10000+Y*100+Z`，`scripts/check-version.sh` 校验（含 android）。
- 签名：CI 配置 secrets `ANDROID_KEYSTORE_B64`（base64 的 .jks）、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 后用发布密钥签名；
  未配置时 release APK 用 debug 密钥签名（文件名含 `debug-key`），可安装测试，**不能用于商店 / 覆盖升级正式签名的包**。
- 发布流水线 `.github/workflows/release.yml` 的 `android` job 跑单测并产出 `drivehub-<ver>-android-<signing>.apk` + SHA256SUMS，汇总进 release 构件。

## 测试
- `ApiClientTest`（MockWebServer：版本协商、426 映射、登录 / 2FA、refresh、Range 续传、续传上传、取件码 PIN）与 `VersionTest`（semver、协商规则）。
- `LiveServerTest`：设置 `DRIVEHUB_TEST_BASE / _USER / _PW`（挂载 `/phone`）后对真实服务端跑核心流程与「不兼容版本」；未设置时自动跳过。
- `scripts/smoke-android-api.sh`：对任意服务端实例用 App 的请求头跑 38 项 API 冒烟（版本协商含 426、登录 + 2FA、列目录、搜索、分块上传与续传、下载 Range、分享、取件码）。

## 许可证

Android App 与 DriveHub 其它部分一样以 AGPL-3.0-only 发布（见仓库根目录 `LICENSE` / `NOTICE`）。
