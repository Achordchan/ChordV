# ChordV

私有项目。客户端、管理后台、服务端和节点 Agent 在同一仓库维护，不授权再分发。

当前实现为 **MyGo + Go 服务端 + React 管理后台**，已完成本次本地重构与隔离验收。正式 macOS 签名与重启恢复、Windows 实机安装升级和 GitHub 线上发布仍未验收。默认入口仅运行独立本地环境，不读取根 `.env`，不连接线上数据库，不自动发布或部署。旧 NestJS、Node Agent、Tauri 可执行源码及旧部署链已精确退役；Prisma 结构快照仅保留作迁移审计，用户已有的忽略资产与本地数据没有递归删除。线上版本尚未迁移。

## 项目结构

| 目录 | 职责 |
| --- | --- |
| `apps/desktop/src` | 保留现有 React/Mantine 客户端界面 |
| `apps/desktop/native` | MyGo 窗口、托盘、内核进程、代理恢复、会话、下载和更新 |
| `apps/admin` | 浏览器管理后台，不再提供发布中心 |
| `apps/server` | Go 业务服务、PostgreSQL、鉴权、节点与计量、订阅团队、事件推送 |
| `apps/agent` | Go 节点 Agent |
| `packages/shared` | 前端接口类型与共享规则 |
| `docs/migration` | 功能对照、发布协议和验收记录 |

界面通过统一 MyGo 桥接调用 Go，服务端不转发旧 Node.js 服务；版本和运行组件以 GitHub Releases 签名清单为来源，不维护第二套后台发布记录。

## 本地运行

需要 Node.js（仓库基线见 `.nvmrc`）、pnpm 9.15.3、Go 和 PostgreSQL 服务端工具。MyGo 固定版本和 Go 工具链要求见 `apps/desktop/native/go.mod`，Go 自动下载工具链需要联网；本地打包不需要 Rust。

```bash
pnpm install --frozen-lockfile
node scripts/mygo-local.mjs --create-admin admin@chordv.local
bash ./start.sh
```

创建管理员时按提示输入密码（不回显）；非交互运行用 `CHORDV_LOCAL_ADMIN_PASSWORD` 提供密码，不写入命令参数、代码或 Git。管理员登录后创建本地用户、套餐、订阅和测试节点，没有自动生成的演示业务数据。

PostgreSQL 工具优先从 Homebrew PostgreSQL 17 或 Postgres.app 查找；其他位置用 `CHORDV_LOCAL_PG_BIN` 指定工具目录。脚本不启动 Homebrew 后台服务，不使用 Docker，不复用其他数据库。

| 服务 | 默认地址 |
| --- | --- |
| Go API | `http://127.0.0.1:3100/api` |
| 管理后台 | `http://127.0.0.1:5174` |
| 客户端开发页面 | `http://127.0.0.1:5173` |
| 独立数据库 | `127.0.0.1:55437/chordv_mygo_local` |

另开终端构建并启动真实 MyGo 客户端：

```bash
bash ./start-app.sh
```

需要前端热更新时用 `pnpm dev:desktop`。`start-app.sh --check` 仅检查工具，`--build-only` 仅构建；macOS 的 `--skip-dmg` 用于本地快速检查。`--e2e` 只为本地验收启用测试 Socket，正式构建禁止使用。

### 本地隔离

- 凭据保存在权限 `600` 的 `.data/mygo/local-env.json`；数据库、服务数据和客户端会话均放 `.data/mygo`，不进入 Git。
- 开发入口固定 `CHORDV_MODE=local`，忽略继承的生产模式和旧数据库变量；远端数据库、旧库名及连接参数覆盖会被拒绝。
- `Ctrl+C` 只停止脚本本次启动的进程。端口属于其他进程或其他数据库实例时直接报错，不杀进程、不覆盖数据。
- 本地客户端使用独立应用标识和数据目录。只有显式连接才请求系统代理权限；查看界面、构建和登录不改系统代理。

## 构建与验证

```bash
pnpm check
pnpm test
pnpm test:browser
pnpm test:e2e:agent
pnpm build:server
pnpm build:desktop
```

完整测试使用独立 PostgreSQL，执行 Go 单元和真实数据库集成、前端回归、发布协议及浏览器布局检查。本机已有 Chrome 时使用独立 Chrome 会话；也可用 `PLAYWRIGHT_CHANNEL` 选择已安装浏览器，或先用 `pnpm exec playwright install chromium` 安装测试浏览器。

仅验客户端时，运行 `node scripts/mygo-verify.mjs --desktop-ui`：自动发现桌面回归和浏览器布局用例，不启动数据库。GitHub 桌面代码验证与手动发布共用这条命令；离线安装协议用例还需要预缓存 `apps/desktop/native` 的 Go 依赖。 管理后台使用 `node scripts/mygo-verify.mjs --admin-ui`，服务端发布打包前必须同时通过后台回归与 Go 数据库测试。

`test:e2e:agent` 只需现有独立 PostgreSQL 和本地配置 JSON；每轮从当前源码构建独立 Go 后台、生产 Agent 和真实 Xray 测试节点，使用随机回环端口、私有 schema 和临时数据目录，不复用主 API 或旧二进制。它验证真实 Reality 传输、计量重放幂等、停用尾流量结算与连接撤销，并核对自有进程/schema 清理和现有 public 表摘要；不改系统代理，具体范围见 [隔离验收说明](tests/e2e/README.md)。旧 Prisma 库的显式基线接管及其拒绝条件见 `apps/server/README.md`，不得把本地迁移通过当成已接管线上数据。

产物在 `output/mygo/<Go平台>-<Go架构>` 和 `output/backend/<平台>-<架构>`；Go 服务端包不携带 Node.js 运行时或生产依赖。默认构建不自动提交、推送、发布或部署。

## GitHub 发布

协议见 [GitHub 发布说明](docs/migration/github-releases.md)。仓库必须显式配置；未配置时明确提示，不默认访问原线上后台。

Release 包含安装包、校验过的运行组件、清单及 Ed25519 分离签名。渠道分支只保存同一清单的原字节副本；镜像仅传输，不能改写版本真相或绕过签名、SHA256 校验。

正式构建必须显式使用 `--release`，提供服务地址、仓库、公钥、构建号和平台签名配置；macOS 还需公证。默认本地产物不用于覆盖线上安装或服务。旧 1.1.x 过渡升级单独规划，不把 Tauri 更新签名冒充新清单签名；本轮不向线上发布过渡版本。

## 迁移验收

总清单：[MyGo 重构验收](docs/migration/mygo-rebuild.md)。专项：[原生运行层](docs/migration/native-parity.md)、[Go 服务端](docs/migration/server-parity.md)、[界面和交互](docs/migration/ui-qa.md)。

数据库集成、内核传输、跨进程恢复、窗口截图和跨平台安装分别记录证据；没有实际验证的项目保持未完成，不以路由存在、编译成功或页面可打开替代完整验收。
