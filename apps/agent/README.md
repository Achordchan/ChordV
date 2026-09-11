# ChordV Agent (Go)

B1 阶段的节点 agent，移植自 `apps/node-agent`（TypeScript，3,423 行）。
设计与分期见 `docs/prd/node-inband-coexist-go-agent.md`。

## 关于目录名

叫 `agent` 而不是 `node-agent-go`。

旧目录名里的 **node 指的是「节点」**（`nodeId`、`NodeAgent`、`CHORDV_NODE_ID`、
`Node` 模型），**不是 Node.js** —— Node.js 只是它当时的实现语言。正因如此，
`node-agent-go` 会被读成「Node.js agent，用 Go 写的」，自相矛盾；而 P5 删掉
TypeScript 版之后，`-go` 后缀也不再指代任何东西。

`agent` 对齐 API 命名空间 `/api/agent/v1` 与服务用户 `chordv-agent`，名字里不含语言，
因此 TypeScript 版退役后**不需要再改第二次名**。

**部署侧的名字没有跟着改**：systemd 单元仍是 `chordv-node-agent.service`，
数据目录仍是 `/var/lib/chordv-node-agent`。那些是已装机器上的既有事实，
改动会破坏原地升级；仓库目录名与它们无关。

## 为什么是 Go

1. **目标 VPS 零运行时依赖。** Node 版依赖 `better-sqlite3` 这个原生模块，安装脚本必须
   在目标机上准备一整套隔离的 Node 运行时。Go 编译出单个静态二进制（`CGO_ENABLED=0`），
   `scp` 过去就能跑。
2. **xray protobuf 原生可用**，不再经 `@remnawave/xtls-sdk` 这层第三方转译。
3. B1 下 agent 不再写任何 Xray 配置文件，`xray-apply.ts`（agent 里最大的单文件）
   连同 root 助手脚本、systemd path 单元、conf.d 布局一并消失。

## 当前进度

| 分期 | 内容 | 状态 |
| --- | --- | --- |
| P1-a | 协议类型、配置、凭据、持久化写、API 客户端（含 SSE） | 已完成 |
| P1-b1 | sqlite 状态库（用户、计量批次、命令幂等） | 已完成 |
| P1-b2 | 命令处理器 + Xray 适配器边界 | 已完成 |
| P1-b3 | 主循环、入口 `cmd/chordv-agent/main.go` | 已完成 |
| P2-a | 真实 Xray gRPC 适配器、只读 tag 校验、隔离实测 | 已完成 |
| P2-b | 后台 vless 导入、ENSURE_INBOUND 语义改造、接入手册 | 本次新增 |

**已实现面板导入与只读校验，尚未进行生产灰度。** 接入步骤、手工安装路径、
版本和计量验收见 [PANEL-ONBOARDING.md](PANEL-ONBOARDING.md)。启动先只读校验目标 VLESS tag 与 StatsService，
失败时不注册、不初始化状态库。占位适配器和 `AGENT_ALLOW_NO_XRAY` 已删除。

## 与控制面的关系

线上协议**一个字节都不改**。`internal/protocol` 是
`apps/node-agent/src/types.ts` 与服务端 `apps/api/src/modules/agent/agent.dto.ts`
的逐字转写：灰度时如果协议也跟着变，就分不清是移植 bug 还是协议 bug。
既有身份、路径和间隔变量沿用 Node 版；两个所有权开关见下文。面板模式显式下发 `mode=validate_panel`，既有 Node 部署流程保留兼容，不自动切换。

## 几条不能改的不变量

- **注册密钥由 agent 生成，且必须先落盘再发请求。** 服务端只存它的哈希，所以响应丢失时
  用同一个密钥重放是幂等的，会拿回同一个身份。顺序反了就会把节点锁死。
- **`XRAY_API_ADDRESS` 只能是 loopback 或 unix socket。** Xray 的 gRPC 无鉴权、无
  按方法 ACL，能连上就能删掉面板的入站、改路由。这条限制是唯一的边界。
- **身份归档必须连同状态库一起、同一个时间戳、且先写日志。** 状态库里有旧节点的用户、
  命令历史和未结算的计量批次；新身份继承它就会重放旧节点的账。
- **健康检查不注册、不归档、不初始化数据库。** 必须以数据库所属的服务用户执行；
  root 或其他用户会在 SQLite 打开前被拒绝。SQLite 仍可能维护同属服务用户的共享段，
  因此这里的只读指业务状态，不承诺文件系统绝对零写入。
- **状态库属于一个节点身份。** 它装着该节点的用户、命令历史和未结算计量批次；
  换个身份继承它就会以新凭据重放旧节点的账。
- **计量绝不能静默漏计。** Xray 的计数器会在我们脚下被重置（3x-ui 周期性地做这件事），
  而把重置当成「没有流量」是看不出来的：数字依然合理，钱没了。

## 本地开发

```bash
go test ./...                                   # 全部测试
go vet ./... && gofmt -l .                      # CI 里跑的同一套检查
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./...
```

## P1-b3 运行与排查

```bash
# 在 apps/agent 内；产物放在操作者指定的位置
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /path/to/chordv-agent ./cmd/chordv-agent
/path/to/chordv-agent --version
/path/to/chordv-agent --health  # 以服务用户、同一套环境执行；输出 JSON，失败退出 1
```

新开关默认全部关闭：

| 变量 | 用途 | 限制 |
| --- | --- | --- |
| `AGENT_REMOVE_UNKNOWN_USERS=1` | 删除不在期望集合中的未知账号 | **共享入站不可开**，会影响面板账号 |
| `AGENT_ADOPT_EXISTING_ACCOUNTS=1` | 认领同名既有账号 | 仅明确确认属于 ChordV 的迁移环境 |

循环分工：采样按 `AGENT_SAMPLE_INTERVAL_MS`（默认 5 秒），心跳按
`AGENT_HEARTBEAT_INTERVAL_MS`（默认 15 秒），批次每秒最多取 100 个按序上传，
SSE 结束或失败后等待 2 秒重连。所有数据库操作和 Xray 修改共用一把状态锁；
控制面网络请求不占锁。Xray 操作需遵守 context 取消/超时约定，真实 gRPC 每个公共操作共享最多 5 秒预算，服从调用方更短的期限。

- **配置与命令：** HTTP 快照复用命令处理器的身份、模式、binding 历史和所有权规则，
  不伪造命令日志。SSE 模式切换由处理器决定，runner 不提前授予权限。
- **计量：** 删除和 reconcile 前采样；未确认批次持久化重传，负 ack 不删除。
  离线 allowance 截断后，队列清空且后台确认可用额度才恢复；额度为零需较新的充值配置。
- **重启恢复：** 比较 Xray 估计启动时间，同时检查期望用户是否消失；失败保留恢复意图。
- **退出：** SIGINT/SIGTERM 先取消并等待各循环退出，再用独立的 10 秒 context
  做末次采样和一轮上传。未上传完的批次留在数据库，下次启动继续，不丢弃。
- **身份不一致：** 默认拒绝；显式 `CHORDV_AGENT_RESET_IDENTITY=1` 才按现有凭据模块
  归档旧状态，绝不在新节点身份下重放旧批次。

检查日志时区分 `计量采样失败`、`计量上报失败`、`命令流中断`：网络问题可重试，
快照非法或账号归属冲突需修正控制面/接入配置，不能靠打开两个所有权开关绕过去。
本 PR 不部署入站、不写 Xray 配置、不增加 root helper，也不恢复已删除的升级日志回放。

**旧 boot 积压：** 控制面只有一个当前 boot 水位线，切 boot 会清零；direct 结算每次最多
扫描 4 条保留批次。上传与心跳因此使用独立于状态锁的网络锁串行执行，心跳沿用最老
待上传批次的 boot，积压清空后才回到本进程 boot。每轮只上传同一 boot；若服务端
ack 尚未追上该条，下一轮重传，不能越过它切到新 boot。该网络锁不阻塞采样。

每轮上传另有 **10 秒总预算**（不是每条重新计时），到期保留未确认批次并释放网络锁，
让心跳可以继续；单轮仍最多读取 100 条。关闭时服从更短的剩余退出预算。

## P2-a 适配器与隔离验证

依赖固定 `github.com/xtls/xray-core v1.260327.0`（Xray 26.3.27），因此最低 Go 版本为
1.26。直接使用上游 protobuf 和 gRPC service；没有 Node SDK 或自行复制的 proto。

- `XRAY_API_ADDRESS` 支持 `127.0.0.1:端口`、`[::1]:端口`、`localhost:端口`
  （强制映射 loopback，不经 DNS），或 `unix:/绝对路径` / `unix:///绝对路径`。
- API 无认证，**只能本机访问**。agent 不开 API 端口、不改防火墙、不读取面板配置。
- `ValidateInbound` 读取 `ListInbounds` 的 proxy 类型并调用 tag 范围的 `GetInboundUsers`；
  对空入站也能确认 VLESS，不创建探测账号。缺失 tag/非 VLESS/不支持的 RPC 明确失败。
- `EnsureUser` 同 UUID **且同 flow** 才是无操作；否则按预期身份再读取后删除/添加。
  `RemoveUser` 对已不存在账号成功，对身份不匹配拒绝；大小写别名和重复 UUID 拒绝。
- 上游 VLESS validator 在 UUID 索引中屏蔽字节 6/7，适配器按同样的 key 排除已有账号冲突。
  只接受规范 UUID，拒绝上游支持的短字符串哈希别名，避免本地 ownership 记录与真实 UUID 不同。
- `QueryStats.Reset_` 固定 false，int64 直接转十进制字符串，不经浮点数；负计数拒绝。
  只输出目标入站 live 用户的统计，首次使用前尚未注册的计数输出零。

**面板配置前提：** StatsService、HandlerService 已开启；level 0 的
`statsUserUplink` / `statsUserDownlink` 已开启。API 不能区分“尚无流量”与“计数策略未开启”，
因此接入验收必须以实际流量验证，不能仅凭 Health 成功激活。API 客户端不会替面板开启策略。

```bash
go test -v ./internal/xray                 # 启动隔离真实 Xray 服务，自动清理
go test -race ./...                        # 包含真实服务测试
```

真实服务测试覆盖：TCP API、Unix socket、uptime、空 VLESS 入站、错误 tag 的原生
AddUser 报错、用户增删/重复调用、UUID/flow 变更、身份冲突，以及 VLESS loopback 到
本地 echo 服务（上/下各 5 字节，连续读取不清零）。大于 JS 安全整数的精度和非目标
账号过滤由真实 StatsService + 内存计数器验证。测试不接触任何生产服务器或外网目标。

**边界：** 测试使用固定版本的真实 Xray，不等于已验证所有面板捆绑版本；P2-b 接入时
仍须核对版本/RPC/统计策略。合法但指错入站的 tag 须由后台绑定导入端口解决。
身份读取与修改/统计不具备 CAS；面板并发改写竞态沿用 PRD §10。已移除 live 用户的
尾部计数不由全局 stats 猜测归属，删前采样仍是计量保障。ENSURE_INBOUND 对 Go agent 仅接受显式面板校验，仍拒绝部署请求；
不能把只读校验成功当作公网连通和计量验收通过。

**进程范围 email 唯一性：** Xray 的 `user>>>email>>>traffic` 计数没有入站维度。
安装与计量前会检查其他入站的用户列表，同名账号拒绝安装/计量；面板 API 使用的
无 email `dokodemo` 入站跳过。其他入站无法列出用户时保守报错（不假设为空），
因此不支持用户列表 RPC 的共存协议需单独确认，不能直接激活。该检查是当前时刻
的证据，不原子；部署必须保持 email 在整个 Xray 进程内唯一，历史上已混合的计数
不能由 API 拆回各自流量。

P2-b 复用现有节点连接字段与已完成命令 payload 持久化面板规格（mode/tag/声明版本），
API 端口保留在节点本机环境文件，不新增数据库迁移，不删除历史面板列。
面板版本下限为 3x-ui 3.1.0，支持该版本及以上的 3.x 稳定版。一键安装会读取实际面板版本并检查 Xray API 与统计配置；手工填写的版本只代表管理员声明，不能替代实际能力检查。3.0.x 预发布、2.x 和未经兼容确认的其他大版本不放行。
