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
| P1-b2 | 命令处理器 + Xray 适配器边界 | 本次新增 |
| P1-b3 | 主循环、入口 `main.go` | 未开始 |
| P2 | 面板入站接入、入站 tag 校验、xray gRPC 适配器 | 未开始 |

**本模块尚无 `main`。** 目前是纯库，可编译、可测试，但还不能作为服务运行；
入口与主循环随 P1-b2 一起提交。这样拆是为了让评审能真正看完每一行。

## 与控制面的关系

线上协议**一个字节都不改**。`internal/protocol` 是
`apps/node-agent/src/types.ts` 与服务端 `apps/api/src/modules/agent/agent.dto.ts`
的逐字转写：灰度时如果协议也跟着变，就分不清是移植 bug 还是协议 bug。
环境变量名也与 Node 版完全一致，同一台机器换个二进制即可。

## 几条不能改的不变量

- **注册密钥由 agent 生成，且必须先落盘再发请求。** 服务端只存它的哈希，所以响应丢失时
  用同一个密钥重放是幂等的，会拿回同一个身份。顺序反了就会把节点锁死。
- **`XRAY_API_ADDRESS` 只能是 loopback 或 unix socket。** Xray 的 gRPC 无鉴权、无
  按方法 ACL，能连上就能删掉面板的入站、改路由。这条限制是唯一的边界。
- **身份归档必须连同状态库一起、同一个时间戳、且先写日志。** 状态库里有旧节点的用户、
  命令历史和未结算的计量批次；新身份继承它就会重放旧节点的账。
- **健康检查路径一个字节都不写。** 它通常由运维以 root 执行，任何它创建的文件都会变成
  root 所有，导致降权运行的服务下次起不来。
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
