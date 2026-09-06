# Agent 迁移核对工具

本目录只处理脱敏后的本地 JSON，不连接 ChordV、3X-UI、Xray 或生产服务器，也不读取账号、Cookie、Reality 私钥和 Agent 令牌。

## 三方用户核对

```powershell
corepack pnpm --filter @chordv/api exec tsx ../../scripts/agent-migration/cli.ts reconcile `
  --bindings .\bindings.json --xui .\xui-users.json --xray .\xray-users.json
```

三个文件都是 JSON 数组。ChordV binding 使用 `nodeId/email/uuid/status`，3X-UI 与 Xray 用户使用 `nodeId/email/uuid/enabled`。报告会检查无效身份、重复 email/UUID、缺失用户、未知用户、UUID/email 和启用状态不一致；只有问题数为零时 `readyForShadow=true`。

## Shadow 流量差异

```powershell
corepack pnpm --filter @chordv/api exec tsx ../../scripts/agent-migration/cli.ts shadow `
  --xui .\xui-delta.json --direct .\direct-delta.json `
  --absolute-bytes 1048576 --relative-percent 0.1
```

输入是相同采样窗口内的用户增量，字节必须使用十进制字符串。允许差异取 `max(absoluteBytes, xuiBytes * relativePercent)`；身份缺失或任一用户超限时 `readyForDirect=false`。

## 重启感知 Shadow 对账

```powershell
corepack pnpm --filter @chordv/api exec tsx ../../scripts/agent-migration/cli.ts shadow-series `
  --xui .\xui-samples.json --direct .\direct-samples.json `
  --absolute-bytes 1048576 --relative-percent 0.1 `
  --minimum-steady-windows 1
```

`shadow-series` 输入按检查点采集的绝对计数。XUI 和 Agent 样本必须使用相同的 `checkpointId`，并由采集器写入同一个 Xray `counterGeneration`。每条记录包含：

- `nodeId/email/uuid`
- `checkpointId/counterGeneration/sampledAt`
- `uplinkBytes/downlinkBytes`

工具会分别保存 XUI 与 Agent 基线。初始检查点或 `counterGeneration` 变化后，下一窗口只用于重新稳定基线，不参与正常误差统计；若 Agent 增量大于 XUI，会标记为 `XUI_FIRST_OBSERVATION_GAP`。只有重新稳定后达到 `minimumSteadyWindows`、没有缺失检查点且所有稳定窗口均未超限时，`readyForDirect=true`。

这不会忽略重启窗口：报告会保留每次边界的 XUI 增量、Agent 增量和缺口字节；未完成预热的边界会使 Direct 准入失败。

`--out` 使用仅新建模式，目标已存在时拒绝覆盖，避免覆盖历史迁移证据。示例数据只能使用 `.invalid` 邮箱、测试 UUID 和虚构节点，禁止把凭据或完整服务端配置放进报告。
