# ChordV

ChordV 是一套面向团队订阅、节点接入、客户端分发与流量计量的专有网络服务平台。系统以 `3x-ui` 直连为唯一接入模式，由 ChordV 负责账户、套餐、授权、发布与审计，由 3x-ui / Xray 负责真实连接与流量累计。

本仓库为 ChordV 单仓工程，覆盖运营后台、业务 API、桌面客户端、共享类型与发布中心，适用于自有订阅业务的生产部署、版本发布和持续运维。

## 产品能力

- 订阅与团队管理：支持个人订阅、团队成员、套餐额度、到期状态、并发会话与节点授权。
- 节点与连接控制：通过 3x-ui 面板管理客户端身份，客户端连接配置由服务端按订阅权限实时下发。
- 流量计量：以 3x-ui / Xray client 累计流量为权威来源，ChordV 负责套餐额度、账本记录与异常追踪。
- 运营后台：提供用户、团队、套餐、订阅、节点、策略、公告、工单和发布中心管理。
- 多端客户端：当前覆盖 macOS、Windows，并保留 Android 工程链路；客户端支持登录、节点选择、连接、断开、服务端强制事件和应用内更新。
- 发布中心：支持按平台维护版本、上传安装包、计算文件大小与 SHA-256、校验产物可用性，并向客户端提供更新检查。

## 系统架构

| 模块 | 技术栈 | 职责 |
| --- | --- | --- |
| `apps/api` | NestJS、Prisma、PostgreSQL | 认证、订阅、节点、计量、发布中心与客户端 API |
| `apps/admin` | React、Mantine、Vite | 运营后台与业务管理界面 |
| `apps/desktop` | Tauri、React、Rust | macOS / Windows 客户端、运行时控制、安装包构建 |
| `packages/shared` | TypeScript | 前后端共享 DTO、枚举、版本与运行时类型 |

接入模式固定为 `3x-ui 直连`。中心服务负责业务控制、授权下发与计量同步，不承担流量中转职责。

## 本地开发

### 环境要求

- Node.js 22 LTS
- pnpm 9.15.3
- PostgreSQL
- Rust 与 Tauri 构建依赖
- macOS 打包需 Xcode Command Line Tools

### 初始化

```bash
pnpm setup:mac
```

该命令会安装依赖、启动本地 PostgreSQL、生成 Prisma Client、同步数据库结构并写入基础数据。初始化完成后即可启动 API、运营后台和桌面客户端。

### 启动运营后台与 API

```bash
pnpm dev:ops
```

默认启动：

- API 服务：`http://localhost:3000`
- 运营后台：Vite 本地开发服务

### 启动桌面客户端

```bash
pnpm dev:mac
```

仅启动桌面前端：

```bash
pnpm dev:desktop
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `CHORDV_API_PORT` | API 服务端口，默认 `3000` |
| `CHORDV_API_BASE_URL` | 前端和客户端访问 API 的基础地址 |
| `CHORDV_PUBLIC_BASE_URL` | 对外公开域名，用于生成下载地址 |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `CHORDV_JWT_SECRET` | JWT 签名密钥，生产环境必须单独配置 |
| `CHORDV_RELEASE_STORAGE_ROOT` | 发布中心安装包存储目录 |
| `CHORDV_RELEASE_MAX_UPLOAD_BYTES` | 发布中心单文件上传上限 |
| `CHORDV_SESSION_HEARTBEAT_INTERVAL_SECONDS` | 客户端会话心跳周期 |
| `CHORDV_SESSION_GRACE_SECONDS` | 会话失联宽限时间 |

生产环境不得使用仓库示例密钥，数据库、JWT、面板凭据与发布目录必须由部署环境单独提供。

## 版本与发布

桌面端版本按平台独立维护，配置文件为：

[`apps/desktop/config/platform-versions.json`](apps/desktop/config/platform-versions.json)

查看平台版本：

```bash
pnpm --filter @chordv/desktop version:platform macos
pnpm --filter @chordv/desktop version:platform windows
pnpm --filter @chordv/desktop version:platform android
```

构建 macOS 安装包：

```bash
pnpm --filter @chordv/desktop tauri:build:platform macos
```

构建 Windows 安装包：

```bash
pnpm --filter @chordv/desktop tauri:build:platform windows
```

构建产物默认整理到：

- macOS：`output/release/macos`
- Windows：`output/release/windows`
- Android：`output/release/android`

发布流程：

1. 更新目标平台版本号。
2. 执行对应平台构建。
3. 在发布中心创建草稿版本。
4. 上传主安装包并完成文件校验。
5. 确认客户端下载地址、更新日志、最低版本与强制升级策略。
6. 由运营人员在后台执行发布。

## Android 调试

```bash
pnpm --filter @chordv/desktop android:doctor
pnpm --filter @chordv/desktop android:build
pnpm --filter @chordv/desktop android:install -- --launch
pnpm --filter @chordv/desktop android:logcat -- --clear
pnpm --filter @chordv/desktop android:smoke
```

命令说明：

- `android:doctor`：检查 JDK、SDK、NDK、adb 与真机连接状态。
- `android:build`：构建 arm64 调试包。
- `android:install`：安装到已连接设备并可直接启动。
- `android:logcat`：过滤客户端运行日志。
- `android:smoke`：输出真机联调检查步骤。

## 发布中心

发布中心用于管理客户端版本和安装包交付，核心能力包括：

- 按平台和稳定渠道维护版本。
- 上传完整安装包。
- 自动生成下载地址。
- 自动记录文件大小与 SHA-256。
- 发布前校验主安装包是否可读取、大小是否一致、Hash 是否匹配。
- 为客户端提供应用内更新检查。

客户端更新策略：

- macOS / Windows：应用内检查更新，展示更新日志，下载完整安装包，由用户手动安装。
- Android：应用内检查更新，下载或跳转 APK，由用户手动安装。
- iOS：保留版本提示与下载说明入口。

推荐生产变量：

```bash
CHORDV_PUBLIC_BASE_URL=https://v.baymaxgroup.com
CHORDV_RELEASE_STORAGE_ROOT=/data/releases
CHORDV_RELEASE_MAX_UPLOAD_BYTES=1073741824
```

准备发布目录：

```bash
pnpm prepare:release-storage /data/releases
```

安装包目录应与代码部署目录分离，避免应用更新或回滚时影响历史发布产物。

## 质量检查

提交前建议执行：

```bash
pnpm --filter @chordv/shared check
pnpm --filter @chordv/api check
pnpm --filter @chordv/admin check
pnpm --filter @chordv/desktop check
```

客户端发布前至少验证：

- 登录、节点列表、连接、心跳续租、断开。
- 到期、流量耗尽、取消节点授权、后台强制断开。
- macOS 关闭窗口后隐藏到后台。
- Windows 安装后无控制台黑窗，断开后系统代理恢复。
- 应用内更新能够返回正确版本、下载地址、文件大小与更新日志。

## 部署说明

生产部署以宝塔 Node 项目为主，代码目录、环境变量、启动命令和域名绑定应在面板中可见。安装包存储目录由 `CHORDV_RELEASE_STORAGE_ROOT` 指定，建议放在代码目录之外，并纳入服务器备份策略。

推送 `main` 后如触发自动部署，应同时确认 GitHub Actions、服务器同步、宝塔项目重启与线上健康检查，不能只以 Git 推送成功作为上线完成依据。
