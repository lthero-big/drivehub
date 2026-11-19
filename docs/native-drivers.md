# 原生网盘驱动（DEPTAI-481）

移植自 [OpenList](https://github.com/OpenListTeam/OpenList)（AGPL-3.0，参考提交 `7c26f10`），代码位于
`server/crates/storage/src/drivers/`，版权与来源见 `NOTICE` / `THIRD_PARTY.md`。
挂载时 `kind` 分别为 `pikpak`、`p115`（别名 `115`）；Web 管理页「存储挂载」里可直接选择。

## PikPak（`kind = "pikpak"`）

| 选项 | 说明 |
|---|---|
| `username` / `password` | 账号（邮箱或手机号）与密码 |
| `platform` | `web`（默认）/ `android` / `pc`，决定 client_id 与 captcha 签名算法 |
| `refresh_token` | 可选；有则先刷新，失效（4126）时回退到密码登录 |
| `captcha_token` | 触发人机验证时，从官方客户端取得后填入 |
| `device_id` | 可选，默认 `md5(username+password)`（与 OpenList 一致，便于复用其设备） |
| `root_id` | 可选，挂载的根目录 ID，默认网盘根 |
| `skip_verification` | `true` 时忽略 captcha 返回的人机验证链接（同 OpenList，可能触发风控） |

已实现：登录 / token 自动刷新（16、4121、4122）/ captcha_token 初始化与过期（9）重取、分页列目录、stat、
直链（`web_content_link`）与 Range 下载、`mkdir -p`、重命名 / 移动（batchMove + PATCH）、复制（batchCopy）、
删除（batchTrash，进回收站）、上传（GCID 秒传判定 + 阿里云 OSS 单次 PUT，STS 签名）。

限制：上传前需整文件进内存计算 GCID（大文件建议走后台任务）；未做 OSS 分片上传（>5 GB 会失败）；
刷新后的 refresh_token 暂不回写挂载配置（重启后用密码重新登录）；离线下载等扩展接口未移植。

## 115（`kind = "p115"`，预览）

| 选项 | 说明 |
|---|---|
| `cookie` | `UID=…; CID=…; SEID=…; KID=…`（浏览器登录 115 后获取） |
| `root_id` | 可选，默认 `0` |
| `user_agent` | 可选，默认 `Mozilla/5.0 115Browser/27.0.5.7`；下载链接与 UA/Cookie 绑定 |
| `page_size` | 可选，默认 1000（上限 1150） |

已实现：Cookie 登录校验（check/sso）、分页列目录、stat、下载（`proapi` downurl，m115 RSA+XOR 信封）与 Range、
`mkdir -p`、重命名 / 移动、复制、删除。`link()` 返回 None（115 直链绑定 UA/Cookie，Auto 模式会走服务端代理）。

未实现：上传（initupload 签名 + ec115 + OSS 分片）、扫码登录、离线下载。

## 测试

`cargo test -p drivehub-storage`：`tests/pikpak_mock.rs`、`tests/p115_mock.rs` 用进程内 mock 服务器
（PikPak user/drive/OSS 接口；115 webapi/proapi/passport，m115 用测试 RSA 密钥）跑与 fs/s3/webdav 相同的
驱动一致性用例。真实账号测试需要 PikPak 账号密码、115 Cookie。
