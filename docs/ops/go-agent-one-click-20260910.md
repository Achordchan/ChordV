# Go agent 一键接入实现与验收记录

日期：2026-09-10。基线：`main / 8606eea`；工作分支：`achord-agent/go-one-click`。

本记录覆盖本地实现及隔离联调，提交与审查状态以对应 PR 为准；未执行合并、发布或生产操作。`SYSTEM_VERSION` 保持 `0.0.11`；该版本号的本地产物仅用于测试，不能覆盖已有正式 Release。

## 1. 用户入口与服务端行为

1. 在“添加节点”中粘贴 VLESS + Reality 分享链接，或展开手工参数表单。解析后才允许创建。分享 UUID 不保存；服务端再次规范化公共参数，拒绝不支持的参数。
2. 创建节点时，在同一事务中保存 `Node.onboardingSpec` 和一次性注册令牌。可用连接字段仍保持待接入状态，节点保持停用。
3. 后台生成一条命令：完整下载临时脚本成功后再执行，注册令牌位于 POST body。脚本包含该后台版本对应的二进制 SHA-256；下载失败、版本不匹配或校验失败不会执行下载内容。
4. 安装器只读识别运行中的原生 `x-ui.service`、实际面板二进制版本及 Xray 子进程使用的配置。检查本机 API、HandlerService/StatsService、level 0 上下行统计；再按端口、Reality 公钥、SNI、shortId 等参数唯一匹配真实入站。手工确认的 tag 不会被自动替换。
5. 通过 root 和服务用户两次只读预检后，安装 Go 二进制、受限环境文件和 `chordv-node-agent.service`。进程保持非 root；不安装 Node runtime、第二套 Xray，不重写面板入站或防火墙。
6. 首次注册携带真实 tag，服务端在注册事务中冻结该 tag 并建立一次只读校验任务。注册响应丢失后的重放不会重复创建身份或任务。
7. 后台通过现有 SSE 获取变更通知并读取一致的状态快照。界面分别显示等待注册、正在校验、失败和校验完成。只有本次任务 completed 且 applied revision 对应，才显示校验完成；不会自动激活。

### 真实联调发现并处理的差异

官方 3x-ui 3.7.0 的测试安装实际生成：API 协议名 `tunnel`、API 地址 `127.0.0.1:62789`，测试入站 tag 为 `in-18443-tcp`。交接中的 `dokodemo-door` 和 `inbound-端口` 不能作为唯一格式假设。现已同时识别 `tunnel` / `dokodemo-door`，并通过实际入站参数匹配 tag。

## 2. 安装与分发约束

- 支持 amd64 / arm64、原生 systemd、面板二进制 `/usr/local/x-ui/x-ui`、3.7.0 及以上的 3.x 稳定版；其他布局或版本明确失败，不猜测默认配置路径或 API 端口。
- `--inspect-panel` 由 root 读取面板配置，仅输出经过约束的公共连接信息；私钥仅在本地用于派生公钥。`--verify-inbound` 以服务用户再次检查权限；`--health` 检查已有身份、状态库及 API。
- 同一状态库由进程锁保护，拒绝并行注册和重复计量。安装器另有宿主安装锁；已接受任务通过 root 管理的 identity marker 识别重复执行。
- 现有 Node 身份、其他节点身份和额外 systemd 配置不会被接管。旧下载入口返回 HTTP 410；既有 VPS 上的服务和文件不会被远程停止或删除。
- 安装中断留下的部分发布文件、临时发布链接可由同一任务重试恢复。环境与服务提升失败时恢复已有服务文件、链接，保留凭据及未结算计量。
- 更换注册令牌、复用已有主机或已有身份迁移仍必须尊重本地身份边界；不会通过删除凭据或清空状态强行接入另一任务。
- 发行工作流构建双架构 Go 程序并写入版本、Git 提交、校验和；后台包内含 `agent-go-dist` 与安装脚本。下载目录从正在运行的发布树定位，避免读取旧容器挂载或可变 current 链接。
- 本地未提交构建使用实际 Go 源码的 SHA-256 指纹，不将其标记成干净 HEAD 对应的字节；正式 CI 的干净构建使用 Git 提交。
- 新建后台镜像同样构建并携带 Go 产物。可通过构建参数 `CHORDV_SOURCE_COMMIT` 指定 Git 提交；未提供 Git 元数据时，镜像明确使用 `source-sha256:...` 源码指纹，不冒充某次提交。
- 现有 1Panel 独立后台部署包也包含 Go 的 go.mod/go.sum、cmd、internal 及安装脚本；白名单不打包 agent 目录中的本地交接文档。这是后台构建输入，不要求节点 VPS 使用 1Panel。
- 原有后台包整体签名、自更新健康门控和回退流程保持不变。本次没有签发或发布正式更新清单。

## 3. 已执行验证

| 验证 | 结果与覆盖范围 |
| --- | --- |
| `corepack pnpm --filter @chordv/api db:generate` | Prisma 客户端生成成功 |
| `corepack pnpm --filter @chordv/shared build` | 共享类型编译成功 |
| `corepack pnpm --filter @chordv/api check` | API 编译通过 |
| `corepack pnpm --filter @chordv/admin build` | 管理端 TypeScript / Vite 构建通过 |
| `corepack pnpm --filter @chordv/api test:direct` | 接入、命令、注册、计量门禁及相关前端回归通过；新增 SSE 状态与关闭竞态测试 |
| `CHORDV_INSTALLER_E2E=1 corepack pnpm --filter @chordv/api test:agent-install-staging` | 隔离 Linux 文件系统测试通过：损坏下载、网络失败、预检失败、旧身份拒绝、部分文件恢复、重复执行、提升失败回退、面板文件保留 |
| `tsx --tsconfig tsconfig.json test/agent-onboarding-postgres.regression.ts` | 独立 PostgreSQL 16 测试库：规范化保存、原子注册/排队、插入失败回滚、并发重放、错误回报拒绝、真实 tag 冻结、人工激活边界通过 |
| `go test -race ./...` / `go vet ./...` | Go agent 全部测试、竞态检测与 vet 通过，含真实 Xray gRPC/VLESS 既有回归及新增探测、进程锁测试 |
| `node scripts/build-go-agent.mjs <临时产物目录>` | linux amd64 / arm64 静态编译通过；版本、源码提交及哈希写入产物 |
| `docker build --target agent-build -f deploy/1panel/chordv/Dockerfile.api -t chordv-go-seed-test .` | 新建镜像的 Go 构建阶段通过，双架构校验和通过，运行 arm64 `--build-info` 返回版本及源码指纹 |
| `tsx test/system-update-deployment.regression.ts` / `tsx test/runtime-release-contract.regression.ts` | 自更新部署与运行目录契约回归通过 |
| `CHORDV_TEST_BUNDLE_DOCKER=1 ... tsx test/system-update-deployment.regression.ts` | 从实际生成的独立部署包构建 agent-build 阶段通过，确认 Go 构建输入和安装模板齐全，私有交接文档未打包 |
| `git diff --check` | 无空白错误 |

本机 Node 为 20.20.2，项目声明 20.19.x，产生 engine 警告；真实隔离联调使用 Node 20.19.0。管理端保留原有大体积 chunk 提示，本次没有扩展做打包优化。

SSE 重连回归使用真实 AdminRuntimeEventsService 的初始事件、真实客户端 SSE 解析函数和接入 watcher：连接断开期间完成校验，在新服务实例（无回放缓存）重连后，仍由无 nodeId 的 node_access_updated 触发读取并显示完成。该事件本来就在服务端每次 stream() 建立时发送，不需要将 keepalive 转成轮询。

### 完整本地接入联调

使用**解压后的后台发布树**、独立 PostgreSQL 16、官方 3x-ui 3.7.0 arm64 发行包及真实 Go 二进制，运行 `apps/api/test/fixtures/go-onboarding-live-host.sh` 与 `go-onboarding-live.cjs`：

- 通过真实面板登录与新增入站 API 准备一次性测试入站。
- 调用后台解析、创建节点、安装脚本和 Go 下载路由；实际执行生成的脚本。
- 自动探测面板版本、API 和 tag；非 root agent 注册并通过真实 SSE 收到命令。
- 真实 Xray Reality 参数校验完成，连接字段写回，节点仍停用。
- 已消费令牌对应的同一安装命令再次执行：凭据文件哈希保持不变，数据库仍只有一个有效 agent 和一个初始校验任务。
- 面板二进制、Xray 二进制与生成配置的前后 SHA-256 相同；未创建第二套 Xray 服务。
- 通过真实 Xray `inbounduser` API 再次读取面板原有账号，确认它在接入和重启后仍存在于运行中的入站。

**验证边界**：隔离容器使用 systemctl 测试适配器模拟启停调度，管理员认证使用测试账户适配器；数据库、业务控制器、下载、Go agent、面板、Xray 和 agent SSE 协议均为真实实现。此结果不是原生 systemd 启动/主机重启验收，也不是生产发布验收。

### 反向行为验证

在独立临时副本中分别撤掉以下逻辑，再运行对应测试；六次都因**业务断言失败**被捕获，未把构建或测试框架错误计入通过：

- 去掉 `tunnel` 识别 → 实际面板监听测试失败。
- 去掉进程互斥锁 → 第二个 writer 被错误接受，测试失败。
- 禁用自动 tag 匹配 → 不同命名规则的实际入站无法匹配，测试失败。
- 去掉注册事务中的校验任务创建 → PostgreSQL 回滚测试发现注册不再随排队失败回滚，测试失败。
- 使用缺少 Go 输入的旧独立部署包生成器 → 必需构建文件断言失败。
- 去掉服务端连接建立时的节点刷新事件 → 断线期间完成任务的重连回归失败。

## 4. 尚未执行与发布门槛

- 未执行生产部署、后台真实自更新、正式签名清单发布、用户 VPS 安装或公网客户端订阅与计费验收：当前没有这些操作的授权。
- 未验收原生 systemd 和主机重启；需在用户指定的隔离 VPS 上补齐，包括进程重启后的身份、计量重传、权限与回退。
- 未自动改写或读取面板业务数据库来证明入站不限期/不限流量；安装前仍需管理员在面板中按界面要求准备。Go 的真实只读校验不应被解释成所有面板策略与公网可用性已验收。
- 未验证其他面板布局、容器面板或未来大版本，当前明确拒绝不支持环境。
- 布局检查为源码层面：沿用 Mantine Modal/Stack/Group，按状态显示输入、命令和结果；命令区域增加最小宽度及换行约束；没有改全局 CSS。未执行额外浏览器截图或响应式视觉验收。
- 未修改 Rust 桌面端、执行全站扫描或无关模块回归；没有新增生产依赖，没有使用 Python 修改代码。
- 未改变原有版本号、用户已有文档和运维资料；下一步合并、发布仍须按既定 PR / achord-review 与用户授权边界执行。

## 5. 逐文件变更

以下仅列本次工作；不包括工作区原有的 `apps/agent/README.md`、`PANEL-ONBOARDING.md`、`HANDOFF-ONE-CLICK.md`、`DEVLOG.md`、迁移记录与研究资料。

### 数据契约

| 文件 | 修改 |
| --- | --- |
| `apps/api/prisma/schema.prisma` | 新增可空 `Node.onboardingSpec`，与可用连接字段分离 |
| `apps/api/prisma/migrations/20260910090000_agent_onboarding_spec/migration.sql` | 仅追加 JSONB 列，保留现有数据 |
| `packages/shared/src/types.ts` | 创建节点请求增加必需的公共面板参数 |
| `apps/api/src/modules/agent/agent.dto.ts` | 注册请求接受经过格式约束的实际 Xray tag |

### 服务端接入与状态

| 文件 | 修改 |
| --- | --- |
| `apps/api/src/modules/agent/agent-admin.controller.ts` | 创建参数校验、接入状态读取、失败重试入口 |
| `apps/api/src/modules/agent/agent-register.service.ts` | 保存规范化参数、冻结实际 tag、原子注册及排队、SSE 变更通知、一致快照 |
| `apps/api/src/modules/agent/agent.service.ts` | 命令完成/入队时通知管理端，空 tag 重校验沿用已确认 tag，提前拒绝旧 Node agent |
| `apps/api/src/modules/agent/panel-inbound.ts` | 支持将面板版本核验明确交给安装器的 `auto` 模式 |
| `apps/api/src/modules/agent/agent-install.controller.ts` | 替换旧安装脚本，按运行中的发布版本渲染 Go 安装命令 |
| `apps/api/src/modules/agent/agent-download.controller.ts` | 提供版本绑定的 Go 下载，旧 Node/Xray 下载入口返回 410，保留安全流式读取 |
| `apps/api/src/modules/agent/agent-go-release.ts` | 定位当前发布树、检查版本和源码标识、读取双架构校验和 |
| `apps/api/src/modules/agent/agent-node-runtime.ts` | 删除不再调用的旧 Node runtime 安装逻辑 |

### Go agent

| 文件 | 修改 |
| --- | --- |
| `apps/agent/cmd/chordv-agent/main.go` | 增加面板探测、服务用户预检、构建信息入口；运行前取得状态库进程锁 |
| `apps/agent/internal/onboarding/inspect.go` | 读取真实面板进程和配置，校验版本、API、统计策略及入站，限制输出内容 |
| `apps/agent/internal/xray/panel.go` | 通过真实参数唯一匹配自动 tag；手工 tag 不替换 |
| `apps/agent/internal/durable/process_lock.go` | 状态库生命周期的跨进程互斥，拒绝锁路径符号链接 |
| `apps/agent/internal/credentials/credentials.go` | 注册时上报安装器确认的 tag，保留原有持久化和幂等规则 |
| `apps/agent/internal/protocol/types.go` | 注册协议增加可选实际 tag 字段 |
| `apps/agent/internal/version/version.go` | 增加构建源码标识 |

### 管理端界面

| 文件 | 修改 |
| --- | --- |
| `apps/admin/src/api/nodes.ts` | 接入状态快照及重试 API |
| `apps/admin/src/features/nodes/AgentNodeCreateModal.tsx` | 集成参数解析、完整下载后执行的命令、注册/校验分阶段展示与重试，约束命令换行 |
| `apps/admin/src/features/nodes/PanelInboundForm.tsx` | 提取共享解析表单，支持链接和手工参数，防止过期响应覆盖 |
| `apps/admin/src/features/nodes/PanelInboundSection.tsx` | 复用表单，切换节点时清除旧参数，保留 revision 与停用门禁 |
| `apps/admin/src/features/nodes/useAgentNodeOnboarding.ts` | SSE 驱动读取、一致的任务结果判定、事件合并、关闭/重开竞态隔离与 15 分钟退出 |

### 构建与安装

| 文件 | 修改 |
| --- | --- |
| `scripts/install-go-agent.sh` | root 预检、校验下载、服务用户预检、受限 systemd 服务、身份保护、重复执行及提升恢复 |
| `scripts/build-go-agent.mjs` | 双架构静态编译、版本和提交注入、哈希与清单生成 |
| `scripts/prepare-1panel-chordv-bundle.mjs` | 补齐独立后台部署包的 Go 构建输入和安装模板，继续排除本地交接资料 |
| `.github/workflows/release-backend.yml` | 后台发行中验证/构建 Go，并把 Go 产物与脚本纳入自更新包 |
| `deploy/1panel/chordv/Dockerfile.api` | 为新建 seed 镜像构建并携带同样的 Go 产物与脚本 |
| `.gitignore` | 排除本地生成的 `agent-go-dist` |

### 后端与安装回归

| 文件 | 修改 |
| --- | --- |
| `apps/api/package.json` | 将 Go 安装回归接入 test:direct，移除旧 runtime 测试入口 |
| `apps/api/test/agent-onboarding-postgres.regression.ts` | 新增真实 PostgreSQL 注册、回滚、并发及实际 tag 回归 |
| `apps/api/test/agent-install-staging.regression.ts` | 用 Go 渲染及隔离安装执行测试替换旧 Node 安装断言 |
| `apps/api/test/agent-onboarding-safety.regression.ts` | 安全文件读取改用测试路由，检查旧下载返回 410 |
| `apps/api/test/panel-inbound.regression.ts` | 适配复用已确认 tag 所需的节点读取，保留旧 agent/激活/revision 拒绝测试 |
| `apps/api/test/agent-register.regression.ts` | 移除已退役的 Node 安装渲染断言，保留注册、重放、凭据测试 |
| `apps/api/test/agent-inbound.regression.ts` | 移除已退役的第二套 Xray 安装断言，保留入站命令与并发回归 |
| `apps/api/test/agent-install-runtime.regression.ts` | 删除旧 Node runtime 专用测试 |
| `apps/api/test/system-update-deployment.regression.ts` | 检查生成部署包的必需 Go 文件及私有资料隔离，可直接构建该包的 agent-build 阶段 |

### 测试夹具、前端与 Go 回归

| 文件 | 修改 |
| --- | --- |
| `apps/api/test/fixtures/go-install-host.sh` | 离线隔离宿主文件与失败恢复测试夹具 |
| `apps/api/test/fixtures/go-onboarding-live-host.sh` | 官方面板、真实 Go agent 的隔离进程启动夹具，明确 systemctl 适配边界 |
| `apps/api/test/fixtures/go-onboarding-live.cjs` | 从发布目录启动真实 API，验证完整接入、SSE、重启及文件保留 |
| `apps/admin/test/agent-node-onboarding.regression.ts` | 保留请求竞态回归，增加 SSE 状态、结果对应、事件合并和关闭测试 |
| `apps/admin/test/panel-inbound.regression.ts` | 测试共享表单及过期解析响应，保留节点门禁检查 |
| `apps/agent/internal/onboarding/inspect_test.go` | 版本、统计策略、API 地址、tunnel 命名与 socket 注入拒绝测试 |
| `apps/agent/internal/durable/process_lock_test.go` | 第二进程拒绝、锁释放及符号链接拒绝测试 |
| `apps/agent/internal/xray/panel_test.go` | 实际参数自动匹配、手工 tag 不替换、公钥不一致拒绝测试 |

### 交付记录

| 文件 | 修改 |
| --- | --- |
| `docs/ops/go-agent-one-click-20260910.md` | 本文：实现、逐文件说明、验证证据和未验收边界 |
