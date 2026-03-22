# ChordV

ChordV 是一个面向自有订阅体系的代理平台单仓工程。

## Apps

- `apps/api`: NestJS 业务 API，已接入 PostgreSQL。
- `apps/admin`: React 运营后台。
- `apps/desktop`: Tauri + React 的 macOS 桌面客户端。
- `apps/edge-gateway`: 中心侧 `ChordV Edge Gateway`，负责暴露统一入口、转发到真实节点并上报中心计费。
- `packages/shared`: 共享 DTO、状态枚举与运行时类型。

## Getting started

```bash
pnpm setup:mac
pnpm dev:ops
pnpm dev:mac
```

`pnpm setup:mac` 会自动下载 macOS 对应的 `xray` 内核到 `apps/desktop/src-tauri/bin`。

## Environment

- `CHORDV_API_PORT`: API 端口，默认 `3000`
- `CHORDV_API_BASE_URL`: 前端请求的 API 地址，默认 `http://localhost:3000`
- `CHORDV_EDGE_INTERNAL_BASE_URL`: API 调用中心中转服务的内部地址，默认 `http://127.0.0.1:3011`
- `CHORDV_EDGE_INTERNAL_TOKEN`: API 与中心中转服务之间的内部鉴权令牌
- `CHORDV_EDGE_PUBLIC_HOST`: 客户端连接的中心入口地址，默认 `127.0.0.1`
- `CHORDV_EDGE_PUBLIC_PORT`: 客户端连接的中心入口端口，默认 `8443`
- `CHORDV_EDGE_SERVER_NAME`: 中心入口 Reality 的服务名
- `CHORDV_EDGE_REALITY_PUBLIC_KEY`: 中心入口 Reality 公钥
- `CHORDV_EDGE_REALITY_PRIVATE_KEY`: 中心入口 Reality 私钥
- `CHORDV_EDGE_REALITY_SHORT_ID`: 中心入口 Reality shortId
- `CHORDV_JWT_SECRET`: JWT 签名密钥（生产必须配置）
- `CHORDV_JWT_ISSUER`: JWT 发行方，默认 `chordv-api`
- `CHORDV_ACCESS_TOKEN_TTL_SECONDS`: Access Token 有效期，默认 `900`
- `CHORDV_REFRESH_TOKEN_TTL_SECONDS`: Refresh Token 有效期，默认 `2592000`
- `CHORDV_API_FORCE_HTTPS`: 生产环境是否强制 HTTPS，默认 `true`
- `DATABASE_URL`: Prisma 使用的 PostgreSQL 连接串
- `CHORDV_XRAY_BIN`: 可选，自定义本地 `xray` 可执行文件路径
- `CHORDV_SESSION_LEASE_TTL_SECONDS`: 节点会话租约时长，默认 `600`
- `CHORDV_SESSION_HEARTBEAT_INTERVAL_SECONDS`: 客户端续租心跳间隔，默认 `5`，后续作为服务端推送断开时的低频兜底
- `CHORDV_SESSION_GRACE_SECONDS`: 续租失败断线宽限，默认 `60`
- `CHORDV_DESKTOP_FORCE_HTTPS`: 桌面端是否强制 HTTPS API，默认生产开启
- `CHORDV_API_CERT_SHA256`: 桌面端 API 证书 SHA256 指纹（可选，启用证书钉扎）

## Notes

- API 已通过 Prisma 接入 PostgreSQL，并自带演示数据初始化。
- 登录态改为 JWT + 可吊销 Refresh Token，旧版可推导 token 不再可用。
- 客户端连接现在只拿中心入口参数，真实节点参数仅保存在服务端。
- 真实扣量以中心中转层看到的上下行字节为准，由 `edge-gateway` 主动上报到中心 API。
- `pnpm dev:ops` 会启动 `api + edge-gateway + admin`，作为本地后台整套开发入口。
- `pnpm dev:mac` 只拉起 Tauri 原生 macOS 桌面窗口，默认依赖已经运行中的后台服务。
- 只有单独调试中心中转时，才需要手动执行 `pnpm dev:edge`。
- 桌面端现在会真正拉起 `xray` 进程，并显示 PID、配置路径和运行日志。
- 桌面端协议层已预留 `/api/client/events` 事件通道客户端，后端接好后可用于后台断网、撤权、到期、耗尽等场景的即时推送。

## Android 调试

```bash
pnpm --filter @chordv/desktop android:doctor
pnpm --filter @chordv/desktop android:build
pnpm --filter @chordv/desktop android:install -- --launch
pnpm --filter @chordv/desktop android:logcat -- --clear
pnpm --filter @chordv/desktop android:smoke
```

- `android:doctor`：检查 JDK、Android SDK、NDK、adb 和已连接设备。
- `android:build`：构建 arm64 调试包，并同步到 `output/release/android`。
- `android:install`：把最新 APK 安装到真机，`--launch` 会顺手拉起应用。
- `android:logcat`：过滤 Android 运行时、VPN、`libv2ray` 相关日志。
- `android:smoke`：输出真机联调清单，方便按步骤排查联网、断开和后台强制事件。
