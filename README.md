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

- Node.js 20.19.x（Windows Git Bash 下会自动使用 NVM 中已安装的兼容版本）
- pnpm 9.15.3
- PostgreSQL（未配置时由 `start.sh` 在项目目录自动准备）
- Rust 与 Tauri 构建依赖
- macOS 打包需 Xcode Command Line Tools

### 初始化

```bash
pnpm setup:mac
```

该命令会安装依赖、启动本地 PostgreSQL、生成 Prisma Client、同步数据库结构并写入基础数据。初始化完成后即可启动 API 和桌面客户端。

如果你当前使用的是远端数据库和现成后台，不要执行这个命令。只需要把根目录 `.env` 里的 `DATABASE_URL` 指向远端 PostgreSQL，然后直接启动桌面端即可。

### 启动完整本地测试环境

```bash
./start.sh
```

脚本会自动选择 NVM 中已安装的 Node.js 20.19.x，不修改系统全局 Node。首次运行时会安装缺失的 pnpm 依赖；未配置 `DATABASE_URL` 时，会把官方 PostgreSQL 16 解压到 `.data/local-runtime/`，初始化本地数据库、执行迁移并仅在首次写入开发数据，然后以前台方式启动：

- API 服务：`http://localhost:3000`
- 运营后台：`http://127.0.0.1:5174`
- Tauri 桌面客户端（开发页面端口：`http://localhost:5173`）

使用自定义 API 端口：

```bash
./start.sh 3100
```

本地 Direct/Shadow 联调默认关闭。只有在 `.env` 显式设置 `CHORDV_LOCAL_AGENT_ENABLED=true`，并提供 `CHORDV_AGENT_ID`、`CHORDV_NODE_ID`、`CHORDV_AGENT_TOKEN`、`CHORDV_LOCAL_XRAY_BINARY`、`CHORDV_LOCAL_XRAY_CONFIG` 时，`start.sh` 才会额外以前台方式启动隔离 Xray 与 Node Agent；`XRAY_API_ADDRESS` 必须绑定 `127.0.0.1` 或 `localhost`。按 `Ctrl+C` 会随其余本地服务一并退出，不需要额外关闭脚本。

位置参数优先于 `.env` 中的 `CHORDV_API_PORT`。首次准备 PostgreSQL 需要下载约 311 MiB；后续会直接复用项目本地运行时和数据。API 就绪后，脚本会准备 Xray 运行组件并打开 Tauri 客户端；运营后台可用于添加节点和维护本地测试数据。日志显示在当前终端，按 `Ctrl+C` 会同时停止运营后台、桌面客户端、API 和本次启动的项目本地 PostgreSQL，因此不需要关闭脚本。显式配置外部 `DATABASE_URL` 时，脚本只检查连接，不会迁移、Seed 或替换外部数据库。

### 启动桌面客户端

```bash
PATH=/opt/homebrew/bin:/usr/local/bin:$PATH VITE_API_BASE_URL=https://v.baymaxgroup.com pnpm dev:mac
```

仅启动桌面前端：

```bash
PATH=/opt/homebrew/bin:/usr/local/bin:$PATH VITE_API_BASE_URL=https://v.baymaxgroup.com pnpm dev:desktop
```

如果 `tauri dev` 报 native binding / code signature 错误，先确认当前终端优先使用的是 Homebrew 的 Node，而不是 Codex.app 自带的 Node。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `CHORDV_API_PORT` | API 服务端口，默认 `3000` |
| `CHORDV_API_BASE_URL` | 前端和客户端访问 API 的基础地址 |
| `CHORDV_RUNTIME_COMPONENT_API_BASE_URL` | 本地 API 未配置 Xray 组件时使用的组件服务，默认 `https://v.baymaxgroup.com` |
| `CHORDV_PUBLIC_BASE_URL` | 对外公开域名，用于生成下载地址 |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `CHORDV_JWT_SECRET` | JWT 签名密钥，生产环境必须单独配置 |
| `CHORDV_DEV_BOOTSTRAP` | 开发数据自动初始化开关，生产环境应关闭 |
| `CHORDV_ALLOW_REMOTE_DEV_SEED` | 允许对非本机数据库执行开发 seed，仅用于一次性测试环境 |
| `CHORDV_ALLOW_REMOTE_DEV_BOOTSTRAP` | 允许对非本机数据库执行开发数据自举，仅用于一次性测试环境 |
| `CHORDV_RELEASE_STORAGE_ROOT` | 发布中心安装包存储目录 |
| `CHORDV_RELEASE_MAX_UPLOAD_BYTES` | 发布中心单文件上传上限 |
| `CHORDV_SESSION_HEARTBEAT_INTERVAL_SECONDS` | 客户端会话心跳周期 |
| `CHORDV_SESSION_GRACE_SECONDS` | 会话失联宽限时间 |

安全默认值：未配置 `CHORDV_JWT_SECRET` 时，API 只会在 `NODE_ENV=development`、`NODE_ENV=test` 或显式设置 `CHORDV_ALLOW_INSECURE_DEV_SECRET=true` 时使用开发密钥。`CHORDV_DEV_BOOTSTRAP` 默认不会自动执行，确需写入开发数据时必须显式设为 `true`。

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

后台系统（`apps/api` + `apps/admin`）作为一个整体发布单元，运行在 1Panel 管理的 Docker 容器上，支持在运营后台内“一键更新 / 失败自动回滚”，上线后除极少数异常场景外不再需要 SSH 到服务器操作。详见 [`docs/prd/backend-self-update.md`](docs/prd/backend-self-update.md)。

### 容器部署（`deploy/1panel/chordv/`）

```bash
# 在仓库根目录执行（compose 的 build.context 指向仓库根）
docker compose -f deploy/1panel/chordv/docker-compose.yml up -d --build
```

- `chordv-api`：入口是监督者脚本 `entrypoint.sh`，代码运行在可写的 `api-releases` 卷中，按版本目录存放并用 `current` 软链接指向当前版本；自更新时应用只“下载→校验→暂存→停止接单并排空工作→Nest 关闭→写 pending 标记→退出”，由监督者提升新版本、按需执行迁移前快照与迁移、健康门控、失败自动回滚。`restart: unless-stopped` 是监督者自身异常时的兜底。
- `chordv-admin`：nginx 只读挂载 `api-releases` / `api-public-state`，**不挂载 `api-state` 或 `api-backups`**；网页根指向通过健康门控的版本的 `apps/admin/dist`，随 api 自更新自动跟随，同时把 `/api` 反代到 `chordv-api`。公开标记目录只由监督者在健康门控和私有 last-good 写入成功后原子发布 `last-good-version`，不复制私有状态或从 desired-version 初始化；首次启动等待该标记。
- 前置 openresty（TLS 终止）将域名反代到 `chordv-admin`；生产强制 HTTPS，内部健康探活带 `X-Forwarded-Proto: https`。
- 数据库快照（迁移前 `pg_dump`）落在 **API 独占**的 `./api-backups:/app/backups`；私有状态 `./api-state:/app/state`、公开健康版本标记 `./api-public-state:/app/public-state`、代码 `api-releases` 和安装包 `./releases:/data/releases` 分开持久化。admin 只读挂载公开标记到 `/usr/share/nginx/public-state`。各目录需分别纳入磁盘监控与备份策略；数据库快照仍含敏感数据，不应上传、打包到发布产物或放进 nginx 可读目录。

#### 旧部署升级与快照迁移（必须重建容器）

这是 **compose 挂载及镜像入口脚本**的安全修复，仅在后台“一键更新”应用代码不会生效。维护窗口内停止旧 api/admin，保留 PostgreSQL 及所有持久数据；部署新的 compose、Dockerfile 与入口脚本后，在仓库根执行：

```bash
docker compose -f deploy/1panel/chordv/docker-compose.yml stop admin api
# 不输出含数据库口令的展开配置
docker compose -f deploy/1panel/chordv/docker-compose.yml config --quiet
docker compose -f deploy/1panel/chordv/docker-compose.yml up -d --build --force-recreate api admin
```

- **保留现有 `.env` 和密钥，不覆盖或重新生成。** 新 compose 的 `environment` 明确固定 `CHORDV_SYSTEM_STATE_DIR=/app/state`、`CHORDV_SYSTEM_PUBLIC_STATE_DIR=/app/public-state`、`CHORDV_SYSTEM_UPDATE_BACKUP_DIR=/app/backups`，优先于旧 `.env`（包括旧 `/app/state/backups` 值）；以后可人工清理过时项，不是安全修复生效的前提。自定义 compose 覆盖文件、`docker run -e` 不受该固定配置保护，必须同步调整环境变量和挂载，确保三个宿主目录真实独立、不是彼此的子目录或指向同一位置的符号链接。
- **旧 `api-state/backups` 不自动移动、不自动删除。** 重建 admin 后整个私有 state 都不再挂入 nginx，因此遗留快照即使留在原处也不可被 admin 读取。不要为了兼容再挂载旧 state，更不要把它复制进 `api-public-state`。旧 admin 容器仍在运行时这一边界尚未修复，必须重建而非只重启。
- 需要迁移旧快照时，先在停机状态将原目录做一份管理员专用离线归档（保留权限及时间戳），对每份压缩包执行 `gzip -t` 并比较源/目标 SHA-256；恢复验证应在隔离数据库进行。若希望新保留策略接管，可再将确认后的文件**复制**至独占 `api-backups`，遇到同名文件先比较、不得覆盖未知内容；保留原件直到恢复演练和保留周期确认完成。新目录的 `pre-migrate-*.sql.gz` 会参与 `CHORDV_SYSTEM_UPDATE_SNAPSHOT_KEEP` 清理，长期归档应放在另一个仅管理员可读的目录。
- 不手工生成公开 `last-good-version`，尤其不要复制 `desired-version`。API 通过实际 readiness/稳定期后才发布公开标记；公开目录不可写会阻止操作终态确认并重试，admin 保持上次已批准版本或等待。上线后检查 admin 只有 `api-releases` 与 `api-public-state` 两个只读 bind；不得包含 `api-state`、`api-backups` 或其他备份目录。该边界隔离的是 admin 文件系统读取权限，不防护 API、宿主机或 Docker 管理员被攻破。

### 后台系统版本发布

后台系统版本号维护在仓库根 [`SYSTEM_VERSION`](SYSTEM_VERSION)（独立于各 `package.json`，从 `0.0.1` 起）。发布由 GitHub Actions [`release-backend.yml`](.github/workflows/release-backend.yml) 完成：先跑回归测试，再构建可迁移的发布压缩包 + `checksums.txt` + `manifest.json`，发布到 `backend-v*` 的 GitHub Release，并把清单推送到 `backend-manifest` 分支（稳定 raw 地址，供实例检查更新）。运营后台在“全局加速镜像”里配置好 `https://ghfast.top/` 之类前缀后，实例即可通过左上角版本入口检查并一键更新。

容器部署默认使用稳定清单地址：

```dotenv
CHORDV_SYSTEM_UPDATE_MANIFEST_URL=https://raw.githubusercontent.com/Achordchan/ChordV/backend-manifest/latest.json
```

Compose 已设置上述默认值，因此保留旧 `.env` 且缺少此变量时仍有明确更新源；新环境模板也包含该项。使用 fork 或独立发布源时，在部署目录 `.env`（或 Compose 的 `--env-file`）中设置自定义完整 HTTPS 地址，重新创建 API 容器后生效；空值会回到默认地址。该地址需先由 `release-backend.yml` 成功发布稳定版本，尚无清单时会显示读取失败，配置地址不等于已完成首次发布。仅运行本地 API 时，仍按本地环境变量决定是否配置更新源。

**更新包的信任边界（重要）**：清单里的 SHA-256 是整个更新的信任锚，因此**清单本身不能只经加速镜像获取**（被拼接的镜像是第三方服务，若被污染可返回“自己的压缩包 + 匹配哈希”导致容器内执行任意代码）。两种模式：

- **配置了签名公钥**（`CHORDV_SYSTEM_UPDATE_MANIFEST_PUBLIC_KEY`，base64 的 DER/SPKI ed25519 公钥）：清单可走加速镜像（保证可用性），但会用该公钥校验随清单发布的分离签名 `manifest.json.sig`，校验不过直接拒绝。**国内 + 镜像部署请用这种模式。**
- **未配置公钥**：清单只走**直连**拉取（不经镜像），镜像仅用于体积较大的产物下载，其完整性由可信 SHA-256 保证。

签名清单必须包含 `"channel": "stable"`；工作流会为预发布写入 `"channel": "prerelease"`，两者一起参与签名，生产更新入口拒绝预发布或缺少渠道的签名清单。自定义发布源需同步此字段；旧不可变资产不得补写/重签，应发布新版本。

启用签名：本地生成一次密钥对，私钥填到仓库 secret `CHORDV_MANIFEST_SIGNING_KEY`（CI 用它签名），公钥填到实例环境变量 `CHORDV_SYSTEM_UPDATE_MANIFEST_PUBLIC_KEY`：

```bash
openssl genpkey -algorithm ed25519 -out manifest_ed25519.pem            # 私钥 -> GitHub secret
openssl pkey -in manifest_ed25519.pem -pubout -outform DER | base64 -w0 # 公钥(base64 DER) -> 实例 env
```

### 首次从宝塔切到容器部署的一次性基线

线上库若原先由 `prisma db push` 维护（无迁移历史），首次用容器部署时它既不匹配最终 schema 也不匹配 init 快照，严格基线助手会拒绝自动执行。需先做一次**受控基线**（见 `.env.example` 中 `CHORDV_PRISMA_FORCE_BASELINE` / `CHORDV_SKIP_MIGRATION_BASELINE_CHECK` 与 `scripts/prisma-migrate-with-baseline.mjs` 说明），确认基线正确后再切流量；此后 `release-backend.yml` 产出的迁移即可正常增量应用。

> 桌面客户端发布（`release-desktop.yml`）不受影响，维持原流程。宝塔 pm2 流水线（`deploy-baota.yml` / `scripts/deploy-baota.sh`）已停用自动触发，仅保留手动 `workflow_dispatch` 作为迁移期兜底，确认容器部署稳定后可整体删除。
