# ChordV

ChordV 是一个面向自有订阅体系的代理平台单仓工程。

## Apps

- `apps/api`: NestJS 业务 API，已接入 PostgreSQL 与 3x-ui 同步。
- `apps/admin`: React 运营后台。
- `apps/desktop`: Tauri + React 的 macOS 桌面客户端。
- `packages/shared`: 共享 DTO、状态枚举与运行时类型。

## Getting started

```bash
pnpm setup:mac
pnpm dev:mac
```

## Environment

- `CHORDV_API_PORT`: API 端口，默认 `3000`
- `CHORDV_API_BASE_URL`: 前端请求的 API 地址，默认 `http://localhost:3000`
- `DATABASE_URL`: Prisma 使用的 PostgreSQL 连接串
- `CHORDV_PANEL_DEFAULT_URL`: 默认 3x-ui 面板地址
- `CHORDV_PANEL_DEFAULT_USERNAME`: 默认 3x-ui 面板用户名
- `CHORDV_PANEL_DEFAULT_PASSWORD`: 默认 3x-ui 面板密码
- `CHORDV_PANEL_DEFAULT_API_BASE_PATH`: 默认 3x-ui API 基础路径，通常是 `/panel`
- `CHORDV_PANEL_ALLOW_INSECURE_TLS`: 开发环境是否允许自签证书
- `CHORDV_DEMO_PANEL_CLIENT_EMAIL`: 演示订阅对应的 3x-ui client email
- `CHORDV_PANEL_SYNC_AUTOSTART`: 是否自动启动定时同步
- `CHORDV_PANEL_SYNC_INTERVAL_MS`: 定时同步间隔
- `CHORDV_PANEL_SYNC_BOOT_DELAY_MS`: 启动后首次同步延迟

## Notes

- API 已通过 Prisma 接入 PostgreSQL，并自带演示数据初始化。
- 面板同步优先使用 `Subscription.panelClientEmail`；为空时才回退到 `User.email`。
- `pnpm dev:mac` 会启动后端并拉起 Tauri 原生 macOS 桌面窗口，不是单纯网页预览。
