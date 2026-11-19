# 第三方来源说明 / Third-party notices

DriveHub 整体以 AGPL-3.0-only 发布（见 `LICENSE`、`NOTICE`）。

## 移植的源码

| 组件 | 来源 | 许可证 | DriveHub 中的位置 |
|---|---|---|---|
| OpenList `drivers/pikpak` | https://github.com/OpenListTeam/OpenList （参考提交 `7c26f10`） | AGPL-3.0 | `server/crates/storage/src/drivers/pikpak.rs` |
| OpenList `drivers/115`（依赖 SheltonZhu/115driver 协议） | 同上；115driver: https://github.com/SheltonZhu/115driver （MIT） | AGPL-3.0 / MIT | `server/crates/storage/src/drivers/p115.rs` |

OpenList 版权归 OpenList 贡献者（OpenListTeam）及其前身 AList 贡献者（alist-org）所有。
移植文件的文件头注明上游文件路径；协议常量（client_id、签名算法、接口路径等）与上游一致，
逻辑以 Rust 重写。

## 依赖库

Rust crate（见 `Cargo.lock`）、npm 包（见 `web/package-lock.json`）、Android 依赖（见 `android/app/build.gradle.kts`）
各自按其许可证分发（MIT / Apache-2.0 / BSD 等，均与 AGPL-3.0 兼容）。
可用 `cargo about` / `npx license-checker` 生成完整清单。
