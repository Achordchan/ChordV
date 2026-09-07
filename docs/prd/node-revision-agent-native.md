# PRD:节点改版——3x-ui 退役 + Agent 全托管接入

状态:草案(待确认)
日期:2026-09-07
前置:PR #11(进度可视化)已合并;生产 0.0.8;agent 直连计费链路已完整实现(agent.service.ts / agent-direct-metering.ts / node-agent)。

## 0. 背景与决定

ChordV 的节点管理当前以 3x-ui 面板为主轨(`xui_primary`):添加节点填 3x-ui 面板凭据,用户管理经 3x-ui HTTP API 写入,计量每 30s 从 3x-ui 抓 `clientStats`。旁路的 node-agent 直连轨(`direct_primary`)已完整实现并经 PR #7-#10 打磨,但默认不启用。

**决定:改版清零重来。**

- 存量节点、PanelClientBinding、xui 轨快照、VPS 上现有 agent 与 3x-ui —— **全部清除**。
- **用户/订阅/流量台账保留**(用户资产不动,已用数据不重置)。
- 改版后管理员重新添加节点(全走 agent 注册),再给订阅重新分配节点与 UUID,重发订阅。
- 3x-ui 相关代码(XuiService、PanelSyncJob、panel 字段、xui 计量轨、control-mode 状态机)**随本轮删除**。

用户影响:改版窗口期连接中断;补偿由运营决定(系统只承诺不丢已用数据)。

## 1. 目标形态

```
管理员添加节点
  后台"添加节点" → 填基础信息(名称/国家/地区/标签/订阅地址描述) → 预创建节点(status=pending_register)
  → 弹出接入引导:一条 install 命令(含一次性注册 token,短时效)

VPS 上
  curl -fsSL -X POST -H 'content-type: application/json' -d '{"token":"<register-token>"}' https://v.baymaxgroup.com/api/agent-install/script.sh | bash
  → 安装脚本:检测架构 → 下载 agent 发布包(release 中心托管) → 安装 Xray(官方脚本) →
     写 systemd 单元(agent 沙箱化,Requires=xray) → 起服务

Agent 首次启动
  无凭据,持注册 token → POST /api/agent/v1/register {registerToken, agentToken, hostname, arch, agentVersion, bootId}
  → 控制面校验 token(一次性、未过期、对应 pending_register 节点)
  → 保存客户端生成的持久凭据哈希(SHA256+pepper,复用 hashAgentToken),返回 agentId/nodeId
  → 节点置 agent_ready

入站配置下发(管理员在节点详情触发"部署入站")
  → ENSURE_INBOUND 命令(Reality 参数:dest/serverNames/privateKey/shortId)
  → agent 生成 Xray 配置(dokodemo-door API 片段 + vless+reality 入站) → reload Xray
  → agent 上报入站就绪(含公钥派生) → 节点 connection 参数落库 → 可分配用户

用户分配
  管理员把订阅分配到节点 → ENSURE_USER / RECONCILE_USERS(现有命令,协议不变)
  → agent 经 Xray HandlerService 写用户 → 计量自动走 direct 轨(现有 applyDirectBatch)
```

## 2. 变更清单

### 2.1 新增:注册协议(控制面 + agent)

- `POST /api/agent/v1/register`(无 Bearer,凭注册 token):
  - 请求:`{registerToken, agentToken, hostname, arch, agentVersion, xrayVersion?, bootId}`
  - 校验:token 存在、未用过、未过期(TTL 24h)、节点处于 `pending_register`
  - 成功:创建 NodeAgent、保存客户端持久 token 哈希、节点置 `agent_ready`、置 token used；仅返回已有身份，不回传明文凭据
  - 已使用令牌只允许持有匹配在册 Agent 凭据的幂等重试，即使原注册令牌已过期也只返回原身份；不同凭据、已撤销 Agent、未使用的过期令牌继续拒绝
- `AgentRegisterToken` 表:tokenHash(不落明文)、tokenPrefix、nodeId、expiresAt、usedAt
- agent 侧:启动时无凭据但有 `CHORDV_REGISTER_TOKEN` 环境变量 → 走 register → 先持久化客户端生成的待注册凭据，成功后将身份及凭据写入 AGENT_CREDENTIALS_PATH(JSON,权限 600)→ 后续启动直接用凭据
- install 脚本注入注册 token 的方式:写入 `/etc/chordv/node-agent.env`
- 完整管理员环境凭据优先于本地文件，轮换时不再被旧文件覆盖；部分配置和注册令牌冲突明确拒绝。安装包先在独立目录下载、验证并以服务用户解压，再发布不可变版本目录、原子切换current；旧版本与持久数据保留。公开下载通过O_NOFOLLOW打开并对同一文件句柄fstat/流式读取，拒绝符号链接及非普通文件。
- 请求前持久化是强制前置条件：待注册与正式凭据共用原子写入、0600权限和文件/目录链同步；落盘失败不得发送注册请求，已有不可读/损坏记录不得被当成缺失后重新生成密钥。首次凭据签发在事务内要求pending_register；匹配已用令牌重试仍返回原身份。注册与心跳版本从部署包package.json读取。

R1 安全与恢复边界：

- 创建的节点保持禁用；pending_register 不可启用或分配，agent_ready 还必须具备非占位地址、有效端口及完整 VLESS/Reality 参数。激活、订阅分配、客户端列表/探测/连接和用户下发共用该检查，R2 完成入站部署前不会向客户端提供 pending-agent:0。
- 安装脚本仅探测 /usr/bin/node、/usr/local/bin/node，解析软链接后限定 /usr 或 /opt 系统路径，并以 chordv-agent 用户验证 Node 20.19.x 可执行；root nvm、ProtectHome 隐藏路径或仅 root 可执行的安装不被采用。
- 关闭弹窗会使当前会话及轮询失效，迟到创建结果仅刷新节点列表，不恢复旧弹窗。待注册节点提供“继续接入”，可重新签发令牌；无需保留明文旧命令或创建重复节点。R1 尚无注册完成的 SSE 事件，沿用3秒检查、故障退避至30秒，关闭/换会话/就绪/15分钟等待期结束时停止。

### 2.2 新增:入站配置下发(agent)

- 命令 `ENSURE_INBOUND`:payload 携带完整 Reality 参数(或由控制面生成密钥对下发)
- agent 职责扩展:管理 `/etc/chordv/xray/` 配置目录(生成含 API 片段的完整配置)、`systemctl reload` Xray、读取生效状态上报
- 密钥管理:Reality 私钥只在 agent 侧生成(可选:控制面下发)——**默认 agent 侧生成、公钥经注册/心跳上报**,私钥永不出 VPS
- Xray 安装:install 脚本负责(官方安装脚本或发行包),agent 只管配置与运行状态,不负责安装(保持边界)

### 2.3 新增:agent 发布托管

- agent 构建产物 tar.gz(linux-x64 + linux-arm64)挂到现有 release 中心(`releases` 存储,走 artifact 下载路由)或独立 GitHub Release
- `POST /api/agent-install/script.sh`:注册令牌放在 JSON 请求体中，禁止放入 URL；动态生成安装脚本。下载通过公开的 `GET /api/agent-download/:arch` 流式分发，断开连接也须结束控制器和生命周期工作。

### 2.4 修改:管理端"添加节点"

- 表单:基础信息(名称/国家/地区/标签/启用开关)+ **删除全部 PanelConfigurationFields**(panelBaseUrl/Username/Password/InboundId/panelEnabled)
- 提交后:预创建节点 + 签发注册 token → 引导页(install 命令 + 复制 + 状态轮询"等待 agent 注册…"→ 成功后自动跳到节点详情)
- 节点详情:Agent 状态卡(在线/版本/队列深度/xray 状态/上次心跳,数据来自 NodeAgent 表)替代面板状态;入站部署按钮 + Reality 参数展示

### 2.5 删除:3x-ui 全链路

- `apps/api/src/modules/xui/`(XuiService 全部)
- `PanelSyncJob` 表 + runtime-session.service.ts 的面板同步 worker 与队列调度
- 计量:`UsageSyncService.syncXuiUsage` 与 xui 分支(applyNodeSamples 的 xui 源逻辑);direct 轨成为唯一计量轨(保留 30s 的批次落库,入账逻辑不变)
- `agent-control-mode.service.ts` 的四阶段状态机(xui→shadow→direct;切换终点已无意义)
- `Node` 表字段:panelBaseUrl/panelApiBasePath/panelUsername/panelPassword/panelInboundId/panelEnabled/panelStatus/panelLastSyncedAt/panelError;`controlMode/controlStatus` 语义简化(direct 即唯一模式,字段可保留兼容或删除)
- `node-import.utils.ts` 的订阅 URL 导入路径(vless:// 解析;新节点的连接参数来自 agent 上报)
- admin 前端:面板字段、入站下拉读取、panel 状态展示、control-mode 切换 UI(NodeControlCenter 四阶段)
- Prisma 迁移:删列/删表(用户/订阅/流量表不动)

### 2.6 保留(明确不动)

- NodeAgent / NodeCommandJob / NodeUsageBatch 表与协议(SSE 命令流、心跳、批次上报、幂等去重)
- 六种用户命令(ENSURE/ENABLE/DISABLE/REMOVE/RECONCILE/REFRESH_QUOTA)
- agent 采样计量全套(runner/store/xray-adapter 的 StatsService 读取)
- 用户/订阅/套餐/流量台账/TrafficLedger;TrafficSnapshot 保留 direct 源语义
- desktop 客户端与订阅格式(用户重发订阅后无感)

### 2.7 数据清理(上线时一次性)

- 删除全部 Node/PanelClientBinding/xui 源 TrafficSnapshot/PanelSyncJob 行
- 保留:User/Subscription/Plan/TrafficLedger/SubscriptionNode 绑定关系视外键约束级联处理(订阅的节点绑定清空,等待管理员重新分配)

## 3. 实施顺序(PRD 批准后逐 PR 交付)

| PR | 内容 | 依赖 |
|---|---|---|
| R1 | 注册协议(表/接口/agent 侧)+ admin 新表单与引导页;存量功能不动 | — |
| R2 | ENSURE_INBOUND + agent 配置管理 + agent 发布托管 + install 脚本路由 | R1 |
| R3 | 3x-ui 删除(服务/表/字段/前端)+ 数据清理迁移 + xui 计量轨移除 | R2 验证新链路可用后 |

每个 PR 走 achord-review;R3 合并前需在生产用 R1+R2 链路验证一个真实新节点。

## 4. 验收标准

1. 新 VPS 上执行 install 命令 → 3 分钟内节点在后台显示 agent_ready,Xray 就绪
2. 部署入站 → 节点连接参数(Reality 公钥等)出现在后台,可分配订阅
3. 用户客户端拉新订阅可连接,用量 5s 采样、30s 入账,断网续传不丢
4. 后台无任何 3x-ui 痕迹:添加/编辑节点不出现面板字段;代码库 grep 无 XuiService
5. 存量用户数据完整:用户列表、已用流量、套餐状态与改版前一致

## 5. 风险与开放问题

- **agent 安装包体积**:node-agent 含 better-sqlite3 原生模块,双架构产物需在 linux 构建(CI)或交叉编译验证
- **Xray 安装来源**:官方脚本(FranzKafkaYu/xray install) vs 发行包直下——倾向官方脚本,但脚本内容需固定版本可复现
- **Reality 私钥归属**:默认 agent 生成上报公钥(私钥不出 VPS);若换机重装,公钥变化 → 订阅需重发(改版场景可接受)
- **补偿策略**:运营层面(送流量/延期)不在本 PRD 范围;系统只保证数据不丢
- install 脚本域名:走现有生产域名(公开路由,无鉴权,token 即凭据)
