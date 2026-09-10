# B1 面板入站接入与验收

适用：P2-a/P2-b Go agent；先在隔离或灰度节点操作。本文不是生产执行授权。
不安装第二套 Xray，不运行旧 Node agent 的自动安装脚本，不修改面板私钥。

## 1. 面板预检

1. 在目标机器确认 3x-ui **稳定版 ≥ 3.7.0**。后台版本输入为管理员声明，**不是自动探测结果**；
   Xray API 不提供面板版本，因此不能凭后台解析成功认为版本已经核实。
2. 按 PRD 确认面板读取用户统计使用 `Reset_: false`，否则双读会丢计量。
3. 在面板创建专供 ChordV 的 TCP/RAW + VLESS + Reality 入站，入站总流量不限、到期永不。
4. 开启本机 HandlerService / StatsService，以及 level 0 用户上下行统计。
   API 监听必须为 loopback 或 Unix socket，禁止公网开放。
5. 整个 Xray 进程的用户 email 必须唯一，不同入站也不能复用。面板占位用户与 ChordV 账号不能重名。
6. 复制分享链接。若面板必须有用户才能复制，建立一个不限流量/期限的占位用户；不要使用正式订阅 UUID。

## 2. 准备 Go agent（手工路径）

P2-b 保留旧 Node 安装链路兼容既有节点，**该旧脚本会安装/配置 Xray，不能用于面板共存主机**。
Go 分发自动化不是本次接口；以下手工路径不依赖旧脚本：

- 从审核的提交构建：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o chordv-agent ./cmd/chordv-agent`。
  ARM64 改 `GOARCH=arm64`。使用 Go 1.26+，保存构建提交与校验和。
- 在后台创建未启用节点、生成注册令牌；只取注册令牌，不执行旧安装命令。
- 由管理员将二进制放到 root 管理、服务用户不可写的位置，准备专用服务用户拥有的数据目录。
- 准备仅服务用户可读的环境文件（不要提交仓库、截图或写到 shell 历史）：

```text
CHORDV_API_BASE_URL=https://控制面地址
CHORDV_REGISTER_TOKEN=一次性注册令牌
AGENT_DATABASE_PATH=/var/lib/chordv-node-agent/node-agent.db
AGENT_CREDENTIALS_PATH=/var/lib/chordv-node-agent/credentials.json
XRAY_API_ADDRESS=127.0.0.1:实际面板API端口
XRAY_INBOUND_TAG=inbound-实际监听端口
```

API 端口与客户端入站端口不同，不能混用。由管理员核对面板配置中的 API 入站；agent 不需要 root
也不读面板文件。服务用户须有访问本机 API/Unix socket 的权限。

以服务用户带上述环境启动二进制。启动会只读校验目标 VLESS tag 和 API，再注册、创建状态库。
注册/心跳版本以 `go-` 开头；不能给旧 Node agent 手工伪造此版本来绕过服务端检查。
首次注册后保存凭据文件，正常重启不需要再次提供注册令牌。不要只删除凭据而保留旧节点数据库。
现有节点迁移须先停止旧 agent、备份身份和状态、确认后台凭据对应正确节点，避免两个 agent 同时运行。

## 3. 后台导入

在节点控制器的“面板入站导入与只读校验”中：

1. 保持节点停用，填写已核对的面板版本，粘贴 `vless://` 分享链接。
2. 或选择手工填写公网地址、端口、Reality 公钥、shortId、SNI、flow、fingerprint、spiderX。
3. tag 默认由导入端口推导为 `inbound-<端口>`。只有已在面板确认非默认 tag 时才填写覆盖并确认警告，
   同时将 agent 的 `XRAY_INBOUND_TAG` 配成该值。
4. 解析预览不保存节点、不入队、不访问分享链接地址。链接 UUID/备注不进入命令或节点记录。
5. 审核预览，再下发校验。此请求显式使用 `mode=validate_panel`；只有 Go agent 可接收。
6. 等待**本条命令**完成。Go agent 读取实时监听端口、Reality 公钥（从本机私钥派生）、SNI 和 shortId 比对。
   私钥从不回传。不会增删入站，不重启，不轮换密钥；空入站也不创建探测账号。
7. 控制面对结果再次逐字段检查，成功才写节点连接参数和 applied revision，保持原 UUID，不自动激活。

链接通常不携带服务端 Reality `dest`，不可把 SNI 猜成 dest；本流程不修改它。fingerprint/spiderX 为客户端参数，
flow 为 ChordV 用户安装参数，校验不代表公网握手已验证。ML-DSA/PQV、WS/gRPC 等不支持的链接明确拒绝。

## 4. 激活前实测（不能跳过）

- 使用专用测试订阅，确认客户端拿到导入的端口/Reality 参数和自己的 UUID，不是占位 UUID。
- 实际传输已知数据，确认上下行计数增长；连续读取不会清零，控制面批次成功结算。
- 验证错误 tag、错误公钥/端口/SNI/shortId 返回明确失败且旧参数不被覆盖。
- 重启面板 Xray 后验证用户级 reconcile 恢复；不要在 ChordV 入站里频繁增删面板账号。
- 验证超额/到期账号停用，其他账号正常；完成后才由管理员手工启用节点。
- 记录面板版本、Xray 版本、二进制提交、tag/端口、测试命令 revision 与验收结果，不记录令牌/私钥。

## 5. 错误与回退

- “需要 go- 版本”：当前连接的是旧实现或旧构建；更新 Go 构建并等待心跳，不修改版本字符串冒充。
- “先停用”：停止对外分配后再导入，避免带流量更改客户端参数。
- “revision 已变化”：其他操作已生效，重新解析/打开表单确认，不覆盖较新的连接参数。
- tag/端口/Reality 参数不符：重新从目标入站取链接并核对 agent 环境，禁止放宽校验。
- Stats 为空不等于无流量：检查统计策略和真实流量；Health 成功不保证可以计费。
- 失败不更改面板入站。保留旧二进制、身份和状态备份；回退前停 agent，禁止两个实现同时计量/写用户。

身份与配置读取不是原子快照，面板并发写入竞态仍见 PRD §10。没有删除面板列/表或执行收敛迁移。
