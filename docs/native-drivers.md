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
| `upload_part_size` | 可选，OSS 分片大小（字节，默认 16 MiB）；不超过它走单次 PUT，超过走分片（≤10000 片） |

已实现：登录 / token 自动刷新（16、4121、4122）/ captcha_token 初始化与过期（9）重取、分页列目录、stat、
直链（`web_content_link`）与 Range 下载、`mkdir -p`、重命名 / 移动（batchMove + PATCH）、复制（batchCopy）、
删除（batchTrash，进回收站）、上传（GCID 秒传判定 + 阿里云 OSS，STS 签名；小文件单次 PUT，大文件
Initiate/UploadPart/Complete 分片，单片失败重试 2 次，无 5 GB 上限）。

流式上传（write_stream）先落临时文件（系统临时目录，结束即删）再算 GCID、按片读回上传，不整体进内存；
需要临时目录有与文件等大的空间。刷新/登录得到的新 refresh_token 通过 `StorageDriver::set_option_sink`
回写到 `mounts.options`（重启后直接用新 token）。

限制：离线下载等扩展接口未移植；分片上传不支持断点续传（失败后整文件重传）。

## 115（`kind = "p115"`，预览）

| 选项 | 说明 |
|---|---|
| `cookie` | `UID=…; CID=…; SEID=…; KID=…`（浏览器登录 115 后获取） |
| `root_id` | 可选，默认 `0` |
| `user_agent` | 可选，用于 API（登录/列目录/上传），默认 115Browser UA。下载直链与 CDN 固定使用桌面 Chrome UA（115Browser 会令 CDN 返回 403 no cookie value） |
| `page_size` | 可选，默认 1000（上限 1150） |
| `upload_part_size` | 可选，OSS 分片大小（字节，默认 16 MiB） |

已实现：Cookie 登录校验（check/sso）、分页列目录、stat、下载（`proapi` downurl，m115 RSA+XOR 信封）与 Range、
`mkdir -p`、重命名 / 移动、复制、删除。`link()` 返回 None（115 直链绑定 UA/Cookie，Auto 模式会走服务端代理）。

上传（移植 115driver v1.3.5 `RapidUploadOrByOSS`）：`app/uploadinfo` 取 user_id/userkey → 整文件 sha1 →
`uplb.115.com/4.0/initupload.php`（ec115 信封：P-224 ECDH + AES-CBC 请求体、LZ4 响应、`k_ec` 令牌；sig/token
同上游）；status 7 时按 `sign_check` 区间算 sha1 带 `sign_key/sign_val` 重试；status 2 即秒传成功；status 1 则
`gettoken.php` 取 STS，按大小单次 PUT 或 OSS 分片上传（带 `x-oss-callback` / `x-oss-callback-var`），最后列目录确认。
流式上传同样先落临时文件。

未实现：扫码登录、离线下载；上传未经真实账号验证（分片 + 回调的组合以 OSS 规范实现，上游 SDK 走法未逐字核对）。

## 测试

`cargo test -p drivehub-storage`：`tests/pikpak_mock.rs`、`tests/p115_mock.rs` 用进程内 mock 服务器
（PikPak user/drive/OSS 接口；115 webapi/proapi/passport/uplb/OSS，m115 用测试 RSA 密钥、ec115 用测试 P-224 密钥，
OSS V1 签名逐字校验）跑与 fs/s3/webdav 相同的
驱动一致性用例。真实账号测试（列目录 / Range 下载 / 上传 / 跨盘复制到本地 fs）在设置
`DRIVEHUB_TEST_PIKPAK_USER` / `DRIVEHUB_TEST_PIKPAK_PASS` 与 `DRIVEHUB_TEST_115_COOKIE` 时自动跑：
`cargo test -p drivehub-storage`。115 下载走桌面 Chrome UA；不要把 `user_agent` 设成 115Browser，CDN 会 403。
