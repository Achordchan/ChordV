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
| P1-b3 | 主循环、入口 `cmd/chordv-agent/main.go` | 本次新增 |
| P2 | 面板入站接入、入站 tag 校验、xray gRPC 适配器 | 未开始 |

**有入口，但仍不能替换正式节点。** P2 的 Xray gRPC 适配器尚未实现。默认启动在注册、
创建状态库之前拒绝运行；只有 `AGENT_ALLOW_NO_XRAY=1` 才允许做协议联调。
联调使用 `shadow_direct` 空节点；`direct_primary` 的首次配置需要真实适配器，当前会失败。
联调心跳报告 Xray offline，`--health` 返回失败。这不是数据面灰度，不要替换线上服务。

## 与控制面的关系

线上协议**一个字节都不改**。`internal/protocol` 是
`apps/node-agent/src/types.ts` 与服务端 `apps/api/src/modules/agent/agent.dto.ts`
的逐字转写：灰度时如果协议也跟着变，就分不清是移植 bug 还是协议 bug。
既有身份、路径和间隔变量沿用 Node 版；新增的三个显式开关见下文。部署脚本和真实适配器不在本 PR。

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
| `AGENT_ALLOW_NO_XRAY=1` | 允许占位适配器构建做协议联调 | 只用非生产 shadow 节点；P2 实现后删除 |
| `AGENT_REMOVE_UNKNOWN_USERS=1` | 删除不在期望集合中的未知账号 | **共享入站不可开**，会影响面板账号 |
| `AGENT_ADOPT_EXISTING_ACCOUNTS=1` | 认领同名既有账号 | 仅明确确认属于 ChordV 的迁移环境 |

循环分工：采样按 `AGENT_SAMPLE_INTERVAL_MS`（默认 5 秒），心跳按
`AGENT_HEARTBEAT_INTERVAL_MS`（默认 15 秒），批次每秒最多取 100 个按序上传，
SSE 结束或失败后等待 2 秒重连。所有数据库操作和 Xray 修改共用一把状态锁；
控制面网络请求不占锁。Xray 操作需遵守 context 取消/超时约定，真实 gRPC 实现在 P2 验证。

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
