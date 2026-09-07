# ChordV Node Agent

Node Agent 部署在 VLESS 节点 VPS 上，直接通过本机 Xray gRPC API 管理用户并读取绝对流量计数。它不会监听公网管理端口，只主动连接 ChordV API。

## 运行约束

- Node.js 必须为 `20.19.x`。一键安装器与发布构建使用同一版本要求，20.18.x/20.20.x 不作为兼容版本接受。
- Xray API 必须绑定 Unix Socket、`127.0.0.1` 或 `::1`；Agent 会拒绝公网地址。
- Xray 必须启用 `StatsService`、`HandlerService`、`statsUserUplink` 和 `statsUserDownlink`。
- `XRAY_INBOUND_TAG` 必须指向实际承载 ChordV VLESS 用户的入站。
- Reality 私钥和完整 Xray 服务端配置不传给 ChordV API。

## 数据可靠性

- SQLite 使用 WAL 和 `synchronous=FULL`。
- 每 5 秒使用 `reset=false` 读取绝对计数。
- 首次读取只建立基线，不把迁移前累计流量重复入账。
- Xray 计数回退时创建新 generation，并从新计数继续计算非负增量。
- 待上报批次收到连续的十进制字符串 `ackThrough` 前不会删除。
- 后台断联期间，每用户最多额外使用 64 MiB；达到缓存套餐余额或离线额度后，本机移除 UUID。
- Agent 重启时若后台仍断联，会使用 SQLite 中最后确认的配置和控制模式继续计量；从未成功同步过配置的全新 Agent 会拒绝盲目启动。

## 本地命令

```bash
corepack pnpm --filter @chordv/node-agent check
corepack pnpm --filter @chordv/node-agent test
corepack pnpm --filter @chordv/node-agent build
```

复制 `.env.example` 的变量到 systemd EnvironmentFile 后启动。`shadow_direct` 模式只采集和上报，不执行 Xray 用户写操作；`direct_primary` 才会启用增删、停用和重启全量协调。

systemd 环境中的 `AGENT_DATABASE_PATH` 必须设置为 `/var/lib/chordv-node-agent/node-agent.db`，与服务的只写目录保持一致。远程 `CHORDV_API_BASE_URL` 必须使用 HTTPS，只有本机 loopback 测试允许 HTTP。

## Xray 配置

[`deploy/xray-api.fragment.json`](deploy/xray-api.fragment.json) 是需要合并进现有 Xray 配置的最小结构示例，不能直接覆盖已有生产配置。合并后先运行 `xray run -test -config /etc/xray/config.json`，再重启 Xray。

安装 systemd 前按实际目录修改 [`deploy/chordv-node-agent.service`](deploy/chordv-node-agent.service) 中的路径，然后运行 `deploy/install-systemd.sh`。健康检查使用 `deploy/health-check.sh`，它会同时验证 SQLite 和 Xray StatsService。

## Linux 发布

在 Linux 源码工作区使用 `bash apps/node-agent/deploy/build-release.sh /opt/chordv-node-agent.release` 生成待切换目录。脚本会在 Node.js 20.19.x 下执行测试、类型检查和构建，并强制使用 pnpm 的 `package-import-method=copy`，保证 `better-sqlite3` 等原生模块不与 pnpm store 或其他构建目录共享 inode。

禁止用默认硬链接产物覆盖正在运行的 Agent。重建共享的原生模块会改写运行中进程已经映射的文件，可能导致 `SIGBUS` 或 `SIGSEGV`；脚本会在构建前检查当前 systemd 服务并拒绝这种状态。

### 原生注册凭据与版本

首次注册前必须将客户端生成的持久密钥写入 `AGENT_CREDENTIALS_PATH.pending`：缺少父目录时创建权限0700的目录，文件使用0600，完成原子写入及文件/目录链同步后才发送注册请求。任何写入或同步失败都会中止启动，不消耗注册令牌；响应丢失或最终凭据保存失败时，下次启动重用同一密钥。已有凭据文件不可读或损坏时明确失败，不静默生成替代身份。

注册成功后的正式凭据同样原子持久化；部署目录中的 `package.json` 是注册及心跳版本号的来源，直接由systemd执行Node也不依赖npm环境。首次注册只允许控制面节点处于pending_register，已注册身份的匹配重试不受此首次注册限制。此流程针对单个systemd Agent实例；测试中的故障注入不替代真实掉电恢复演练。
