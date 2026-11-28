# 本地 Agent / Reality 端到端验收

## 执行

只需现有独立 PostgreSQL 已运行，且 `.data/mygo/local-env.json` 已存在；不需要主 API 运行，也不会复用 `output/local` 的旧二进制。在仓库根目录执行：

```sh
node scripts/mygo-agent-e2e.mjs
```

脚本从当前源码重新构建生产 Agent、真实 Xray fixture 和仅 `e2e` 标签可构建的独立后台 host。host 复用当前生产 Config、API、Start 和迁移，监听 `127.0.0.1:0` 分配的独立端口；主 API 不会收到测试请求、被替换或重启。这证明实际生产 handler/runtime 整链，不代替生产服务端 CLI 启动与部署验收。

数据库再次核验回环地址、专用角色、数据库名和实际数据目录；随后只创建本次随机 `chordv_agent_e2e_<32位hex>` schema，并以随机归属标记双向复核。后台所有连接固定 `search_path=<本次schema>,pg_catalog`，没有 `public` 回退；默认 schema、错标记和非回环 DSN 均拒绝。管理员、JWT/Agent pepper、数据目录、构建目录和进程均为本次独立资源，密码只经环境变量传入。只读取已存在的本地配置 JSON，不自动生成配置、不读取根 `.env` 或依赖 QA 账号。

## 实际覆盖

独立编译并运行生产 Agent，真实注册、消费 `ENSURE_INBOUND` / `ENSURE_USER` / `DISABLE_USER`，由真实 Xray HandlerService 和 StatsService 返回结果。测试节点是空用户的本机 VLESS/Reality 入站；TLS 1.3 目标站、数据源、控制 API 和数据库均绑定本机。

客户端配置来自 Go API 的连接租约，通过 Xray Core 发起真实 Reality 握手，上下行各传输 262144 字节并核对内容。Agent 自行采样、持久化、上传，脚本核对 PostgreSQL 精确字节计数，并把透明代理捕获的真实请求原样重放，验证不重复计费。个人订阅审计依据为 `NodeUsageBatch`、`TrafficSnapshot`、`PanelClientBinding` 与 `Subscription`；`TrafficLedger` 按原模型只作团队分账，不假定个人记录也写入该表。

随后暂存原样的真实计量请求，再上下行各传输 65536 字节并停用独立用户，确保停用回执包含非空最终结算水位；放行原请求后检查水位已结算、最终扣费为 655360 字节，再验证租约撤销、Xray 账号删除和旧凭据的新连接失败。暂停期间既不向 Agent 合成回复，也不改写上传内容或命令回执。脚本没有直接添加 Xray 用户或手工提交命令结果的路径。

普通用户编辑另在同一真实链验证三次保存：明确相同 active、省略 status、含相同角色与空并发覆盖的完整表单。节点修订、命令清单、binding 修订和真实 Xray 用户必须不变，原 JWT 与租约心跳仍有效。停用结算后再次保存相同 disabled，认证版本、已撤销刷新凭据和供给清单也必须不变。最后真正重新启用，必须仅新增一次必要 ENSURE_USER，重新登录/连接后上下行各传输 2048 字节并核对内容，累计精确计费继续到 659456 字节；不能为了去重阻断真正恢复。

等待数据库状态由管理员 SSE 和真实上传事件驱动，有明确超时，不使用固定间隔的状态轮询。报告分别保存在 `output/e2e/agent/<本次run>/report.json`，包含源码/三份新构建 SHA、独立端口/schema、字节数、进程号和清理结果，不记录数据库 DSN、账号密码、注册令牌、Agent 令牌或 Reality 私钥。失败诊断保存为同目录 0600 文件，报告保留未清资源身份；清理失败会使整个验收失败，不静默忽略；SIGINT/SIGTERM也进入同一清理流程，已启动的自有进程被停止。数据库控制语句设20秒语句上限和5秒锁等待上限。成功后临时构建目录被删除，不覆盖已有产物。

## 隔离与限制

所有业务写入均在唯一私有 schema；退出时停止自有 Agent/Xray/后台进程，严格匹配 schema 名、当前角色和随机归属标记后删除整个 schema。归属变化时保留记录并失败，不按前缀批量清理。只读比较 `public` 表名和全行摘要，确认现有业务数据未改变；这不代表共享 PostgreSQL 锁/统计/通知或主进程内存完全无交互。后台初始迁移保留生产脚本已有的 `CREATE SCHEMA IF NOT EXISTS public` 幂等存在检查，没有 public 表写入。不操作现有节点、系统代理或证书。macOS 上真实 Agent 的结果不替代 Linux 节点、3x-ui 面板安装、systemd 或跨机器链路验收。

Linux arm64 离线验收（2026-11-18）：在本机无外部网络的 Linux 容器内，以普通用户从同一工作树原生编译 Go 后台、Agent 和 Xray 测试节点，使用容器内独立 PostgreSQL 和回环网络执行上述完整流程。10 项检查通过，重新启用后的累计计费为 659456 字节；退出后本次 schema 与子进程均已清理。报告 `platform=linux`、`architecture=arm64`，178 个输入摘要与工作树一致。此结果证明该架构上的实际执行，不是 systemd 服务安装、真实 3x-ui 面板接入或跨机器测试。本机证据：`.tmp/ui-qa/round64-linux-chain/report.json`。

以下测试分别验证调度工具和真实 Reality fixture 自身，不能代替完整 Agent 链：

```sh
node --test tests/e2e/agent-harness.test.mjs tests/e2e/agent-isolation.test.mjs
CHORDV_TEST_AGENT_ISOLATION=1 node --test tests/e2e/agent-isolation.test.mjs
cd apps/agent
go test -race -tags=e2e ./internal/e2e/cmd/local-node -count=1 -v
```

fixture 源码均受 `//go:build e2e` 约束，不进入生产 Agent 构建。其自身单元测试直接操作真实 HandlerService，仅用于确认 fixture 的 Reality、计数器和撤销语义；完整脚本中的写入和回执始终只由独立 Agent 进程产生。
