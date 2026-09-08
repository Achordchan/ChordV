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
- install 脚本注入注册 token 的方式:写入 `/etc/chordv/node-agent.env`(root:chordv-agent 0640,目录 root 所有 0750)。该文件被 `deploy/health-check.sh` 以 shell 方式 source,而健康检查常由 root 执行:服务用户只读不写,健康检查在加载前校验 root 所有且组/其他不可写,否则中止。
- 凭据与注册令牌绑定:正式与待注册凭据都记录注册令牌指纹(仅 sha256,不落明文)。本机已有身份而注册令牌不同(节点删除重建、VPS 复用)时拒绝启动并提示迁移方式,不再静默沿用旧身份;待注册密钥也不跨令牌复用。显式 `CHORDV_AGENT_RESET_IDENTITY=1` 才会把旧凭据改名保留为 `<path>.replaced.<时间戳>` 并以新令牌重新接入。
- 安装脚本的源站遵循与 Agent 一致的传输策略：仅接受裸 `http(s)://host[:port]`，非本机地址必须 https（远程 http 会让安装包走未认证传输，且装完的 Agent 会拒绝该 API 地址而永远无法注册）；来自 Host/X-Forwarded-Proto 的推导值同样受此约束，并以单引号 shell 字面量嵌入脚本。显式配置的 `CHORDV_PUBLIC_BASE_URL` 无效时直接报错，不回退到请求头。
- `--health` 是只读探针：不注册、不生成或落盘凭据、不创建 sqlite 文件。只读连接先校验当前进程就是状态库的属主，否则拒绝打开；WAL 共享段缺失时同样拒绝；状态库属于其他节点时按启动同样的结论拒绝并报告（只读，不认领身份）。仅检查共享段存在与否是有竞态的（服务可能在检查与打开之间停止并删除边车文件，SQLite 会以探针身份重建），因此 `deploy/health-check.sh` 以 root 运行时会先 `runuser` 降权到状态库属主再执行探针，缺少 `runuser` 则中止而非以 root 探测。
- 显式重置身份会把旧节点的凭据、待注册密钥与 sqlite 状态库（含 -wal/-shm）以同一时间戳改名归档，不删除任何数据：状态库承载旧节点的下发用户、命令历史与未结算用量，换身份后继续复用会混淆两个节点并可能重放旧工作。
- 本地状态库绑定节点身份：`meta_v2.node_id` 与当前凭据不一致即拒绝启动（既有无该字段的库自动认领当前身份）。这条不变量覆盖“新身份继承旧状态”的所有来源——中断的重置、安装脚本覆盖旧环境身份、还原备份、手工拷贝数据目录。
- 重置归档可恢复：改名前先落盘重置日志，中断后下次启动按同一时间戳、按日志所列文件补完归档再继续；日志损坏或列出无关文件则拒绝启动，只读健康检查只报告不补写。状态库属于其他节点但凭据是当前的（例如只删了凭据文件重新接入、还原备份、手工拷贝数据目录），同一个 `CHORDV_AGENT_RESET_IDENTITY=1` 只归档运行状态、保留凭据，避免出现「注册成功却永远起不来」。安装脚本在下载任何内容之前拒绝覆盖 `node-agent.env` 中已有的环境变量身份，要求显式迁移。
- 客户端持久凭据全局唯一:注册时若该凭据哈希已绑定其他节点则直接拒绝(而非撞库唯一索引报 500),`NodeAgent.tokenHash` 的全局唯一索引配合可串行化事务保证同一哈希不可能同时存在两个在册 Agent。
- 完整管理员环境凭据优先于本地文件，轮换时不再被旧文件覆盖；部分配置和注册令牌冲突明确拒绝。安装包先在独立目录下载、验证并以服务用户解压，再发布不可变版本目录、原子切换current；旧版本与持久数据保留。公开下载通过O_NOFOLLOW打开并对同一文件句柄fstat/流式读取，拒绝符号链接及非普通文件。
- 请求前持久化是强制前置条件：待注册与正式凭据共用原子写入、0600权限和文件/目录链同步；落盘失败不得发送注册请求，已有不可读/损坏记录不得被当成缺失后重新生成密钥。首次凭据签发在事务内要求pending_register；匹配已用令牌重试仍返回原身份。注册与心跳版本从部署包package.json读取。

R1 安全与恢复边界：

- 创建的节点保持禁用；pending_register 不可启用或分配，agent_ready 还必须具备非占位地址、有效端口及完整 VLESS/Reality 参数。激活、订阅分配、客户端列表/探测/连接和用户下发共用该检查，R2 完成入站部署前不会向客户端提供 pending-agent:0。
- 安装脚本仅探测 /usr/bin/node、/usr/local/bin/node，解析软链接后限定 /usr 或 /opt 系统路径，并以 chordv-agent 用户验证 Node 20.19.x 可执行；root nvm、ProtectHome 隐藏路径或仅 root 可执行的安装不被采用。
- 关闭弹窗会使当前会话及轮询失效，迟到创建结果仅刷新节点列表，不恢复旧弹窗。待注册节点提供“继续接入”，可重新签发令牌；无需保留明文旧命令或创建重复节点。R1 尚无注册完成的 SSE 事件，沿用3秒检查、故障退避至30秒，关闭/换会话/就绪/15分钟等待期结束时停止。

### 2.2 新增:入站配置下发(agent)  —— R2-A 已实现

- 命令 `ENSURE_INBOUND`:payload 携带完整 Reality 参数(或由控制面生成密钥对下发)
- agent 职责扩展:管理 `/etc/chordv/xray/` 配置目录(生成含 API 片段的完整配置)、`systemctl reload` Xray、读取生效状态上报
- 密钥管理:Reality 私钥只在 agent 侧生成(可选:控制面下发)——**默认 agent 侧生成、公钥经注册/心跳上报**,私钥永不出 VPS
- Xray 安装:install 脚本负责(官方安装脚本或发行包),agent 只管配置与运行状态,不负责安装(保持边界)

R2-A 落地细节:

- 命令 `ENSURE_INBOUND` 的 payload 由控制面归一化后落库(`agent-inbound.ts` 的 `normalizeInboundSpec`,含默认端口 443 / dest / SNI),`dedupeKey` 就是规格指纹本身(仅 ENSURE_INBOUND 如此:其它命令类型的显式 dedupeKey 是调用方的幂等契约,释放它会让迟到的 ENABLE_USER 重试把已停用的用户重新启用):同规格且仍未完成的请求由唯一索引原子折叠(并发双击也只会有一条),命令完成或被取消时改名释放该键,已完成的部署因此可以再次下发。折叠还有一条前置条件:待处理的同规格命令必须仍是本节点**最新**的部署请求——「443 → 8443 → 443」全都未完成(agent 断连)时,第三次请求若折叠回第一条 443 命令,它带着比 8443 旧的 revision,8443 反而成了最新操作,而 agent 的过期 revision 守卫会拒绝复用的旧命令,操作员最后的请求永远不生效;此时改为释放旧键(改名为 `:superseded:`,沿用完成流程的释放方式),让 upsert 以新分配的 revision 建一条新命令。「更新」按 targetRevision 判断而非 createdAt:每条建出的命令都消耗了节点单调计数器的一次自增,revision 严格有序,时间戳却可能并列。释放按「仍持有该键」匹配（`where: { id, dedupeKey }`）而不是按状态:待处理的命令可能已进入 running（agent 取走未回报），按 pending 过滤会漏掉它、键没释放、upsert 照样折叠回旧命令;而并发完成的任务已被完成流程改名为 `:done:`，按键匹配自然落空，不受干扰。整个「分配 revision → 查间隔部署 → 释放键 → upsert」的判定按节点**串行化**（事务 + `SELECT ... FOR UPDATE` 锁 Node 行）：唯一索引只仲裁同键写入，间隔检查是跨任务读——8443 请求分配了 revision、还没插入任务行时，并发的 443 请求看不到它就会折叠回旧命令。锁序约定为**先 Node 行后任务行**，`completeCommand`（先写任务行再写 Node 行）在同一位置先取同一把锁，两个顺序相反的事务会死锁。
- agent 无权写 Xray 配置:它把请求写进自己目录下的 `pending.json`,systemd path 单元触发 **root 拥有的** `/usr/local/lib/chordv/xray-apply.js`。该脚本与两份配置片段都由 root 直接从下载到的安装包里解压安装,不经过发布目录——发布目录由服务用户解压,从那里复制会让被攻陷的 agent 替换掉 root 随后执行的脚本,而把目标文件设成 root 所有只是把攻击者的文件保存了下来。助手把 agent 视为不可信输入重新逐字段校验,并**自行渲染**入站结构,绝不搬运 agent 提供的 JSON。
- 配置目录 `/etc/chordv/xray/conf.d/`:`00-base.json`(出站)、`10-api.json`(计量片段,root 所有且从不重新生成)、`50-inbound.json`(唯一生成文件,含 Reality 私钥,`root:chordv-xray 0640`)。发布前用完整候选目录跑 `xray run -test`,原子改名发布,重启失败回滚上一份并再次重启。
- Reality 密钥对与 shortId 由助手在 VPS 上生成,私钥只进 root 文件;改端口/SNI 保留密钥(轮换会让已发出的订阅全部失效),仅 `rotateKeys: true` 才重新生成。
- Xray 重启会清空 gRPC 下发的用户,因此任何触发重启的部署之后 agent 立即 reconcile;另外按 `getSysStats().uptime` 回退检测运维/升级/OOM 造成的重启。agent 单元与 `xray.service` 只用 `Wants=`/`After=` 排序:`Requires=` 会在助手重启 Xray 时把 agent 一并停掉,正好停在它要 reconcile 与回报结果的那一刻。
- `systemctl restart` 对 `Type=simple` 单元在进程绑定端口前就返回,因此助手在回滚窗口内等待端口真正进入 LISTEN、且该监听套接字属于 Xray 自己的进程(按 `/proc/net/tcp{,6}` 的 inode 反查 `/proc/*/fd`)才算成功——端口被 nginx 占着时「有人在监听」恰恰意味着 Xray 没绑上;端口被占用会回滚上一份配置并再次重启。回滚通过同一条写入路径复原(普通 copy 会留下 xray 用户读不到的 root 文件,把一次失败变成两次)。
- 控制面按解析后的地址字节判断公网单播:`0:0:0:0:0:0:0:1` 是写长了的回环,`::ffff:192.168.1.1` 是套着 IPv6 外衣的私网 IPv4,按文本前缀判断都会放行。
- 安装脚本拒绝接管不是它自己写的 Xray 服务(单元里带 `# chordv-managed: xray` 标记):按 `systemctl show -p FragmentPath/DropInPaths` 判断 systemd 实际解析到的单元,systemd 不可用时回退检查 `/etc`、`/usr/lib`、`/lib` 三处及其 drop-in 目录——发行版单元在 `/usr/lib`,只看 `/etc` 会被我们写入的同名单元静默覆盖:替换他人的单元会把服务指向只含计量片段的配置目录并重启,现有代理立刻中断。
- 对外地址在助手动手之前就解析并校验:若等部署完成后才发现地址不可用,Xray 已经重启到新端口/新密钥,而控制面仍在下发旧端点。所需监听族随请求下发,助手在发布前拒绝自己满足不了的族。
- `status` 把「日志未提交」也算作可能已部署:助手若死在发布重启之后、提交之前,入站在服务而 `pending` 仍为真;把它读成「没有部署」会让换身份重装的机器继续用前一个身份的监听器,而调用方唯一的动作是发布空入站——真没有部署时这也无害。反过来,reset 成功后留在盘上的**已提交空片段**(`{"inbounds":[]}`,逐字节等于 reset 的产物)不算部署:把它算上会让 agent 每次重启都把空片段当外来残留再清一次,每次都白白重启 Xray,直到新部署成功;写法不同的空片段无法证明其声明,仍按可能已部署处理。重复 reset 在「无状态且已是空片段」时是无操作,不再重启。
- 监听地址按主机 IPv6 栈决定(`bindv6only=1` 直接报错),并随结果回报;对外地址是 IPv6 而入站只监听 IPv4 时命令失败——这种节点能通过按 tag 的验活,却会把没有监听的端点发给每个客户端。
- `x25519` 解析失败只报告识别到的标签,绝不回显原始输出:该错误会经 agent 可读的结果文件传到控制面,而输出里带着私钥。
- 入队去重只折叠**未完成**的同规格请求(双击),已完成的可以再次下发;否则节点无法回到用过的端口,重复轮换也会失效。
- agent 在把请求交给助手之前就记录本次意图(标记未完成):请求一旦交出,机器可能改变而本进程未必知道结果(超时、结果文件丢失、崩溃),因此除了「正是这个规格且已完成」以外的一切都必须重新走助手,不能凭 tag 还活着就读缓存。
- 助手的结果发布到 **root 拥有、且祖先目录也归 root** 的 `/var/lib/chordv-xray`(agent 只读):写回 agent 自己的目录意味着它可以把该目录换成符号链接、或在 root 创建临时文件与改名之间把文件换掉,从而让 root 把任意 JSON 装进 Xray 的 confdir——那会绕过「agent 只能提供已校验标量」这条边界。临时文件名同时改为随机。
- 清理他人身份残留的入站是破坏性操作(重启 Xray、改写用户表),因此与其它写 Xray 的路径一样只在 `direct_primary` 下执行。
- 重装只在缺失时补齐 `00-base.json` 与 `10-api.json`:运维可能改过 API 端口、路由或统计策略并让 agent 与之对齐,每次重装都覆盖会在下次重启时打断计量;内容不同则提示人工比对,不静默替换。
- agent 不用自己的记忆回答部署结果:每次 `ENSURE_INBOUND` 都经助手确认——只有助手看得到实际部署内容(状态文件、磁盘配置、是否在服务),而「tag 还活着」并不能说明当前跑的是哪个端口与哪把密钥(例如运维还原了旧的 Xray 配置备份却没还原 agent 库)。真正的空转只多一次请求往返,不会重启。
- 助手的两条空转分支都要求磁盘配置**逐字节等于状态所隐含的渲染结果**,并且 Xray **正在服务该端口**:只看文件存在与端口在监听是不够的——运维可能还原了同端口、不同密钥的旧 `50-inbound.json` 而没还原状态文件,那时报出去的公钥根本不是 Xray 在用的那把。:配置文件与状态都还在,但服务已停(或耗尽了 systemd 的重启限额)时回答「无事可做」,会让节点一直宕着且每次重试都得到同样的回答。
- 重启检测按「进程估算启动时刻是否前移」而不是「uptime 是否回退」:采样间隔较大时,重启后的 uptime 可能反而比上次观测更大(1s → 重启 → 3s),按回退判断完全看不出来。容差可用 `AGENT_XRAY_RESTART_TOLERANCE_MS` 调整(默认 2s,吸收秒级粒度与调度抖动;误报只多做一次幂等 reconcile)。但容差内的二连重启(新进程刚接受完补齐的用户、一秒后又被自动化重启,完全落在两次采样之间)连估算都看不见——基线被直接替换。因此每个采样还比对**活跃用户表**:direct_primary 下任一已启用的用户从 `listUsers` 里消失即触发 reconcile(与计量同类的每采样一次额外查询);等待入站期间跳过。
- 恢复下发是「直到成功为止」:重启后第一次 reconcile 可能因 Xray 仍在初始化而失败,而此时健康标记与 uptime 基线都已推进,没有任何路径会重试——因此用一个待恢复标记,只有 reconcile 真正成功才清除。
- 触发重启的部署命令执行前先采样一次:重启会带走 Xray 内存里的计数,而命令执行期间周期采样是被阻塞的,改端口/SNI/密钥这类常规操作不应静默少计流量。
- `fingerprint` 按客户端实际支持的 uTLS 取值白名单校验:它是客户端设置,服务端 Xray 无论如何都会接受部署,写错只会让节点「可激活」而所有生成的配置都不可用。
- 助手单元刻意不排在 `xray.service` 之后:它在自身 start job 里同步执行 `systemctl restart xray`,而排序依赖会让 systemd 把这次重启压到 start job 结束之后——两边互等,部署会一直挂到 oneshot 超时。
- 下发 flow 变化时只改用户的 flow、不写 revision:某个用户的 revision 可能已被更新的用户命令抬高,带 revision 的写入会被拒,于是 Xray 跑着新 flow 而本地状态仍是旧的,下次重启又把不兼容的旧 flow 装回去。
- 助手按 `commandId` 识别重复投递:agent 若在记录完成之前崩溃,同一条命令会被重发,而第二次轮换会让第一次发出的订阅全部失效——因此同一 `commandId` 直接返回已提交结果,不重新生成密钥、不重启。
- 助手用「改名认领」的方式取走 `pending.json`,失败时也绝不删除该路径:一次 apply 可能超过 agent 的等待上限,期间 agent 会写入新的请求,删掉它等于让一条命令永远不被执行。请求以 `O_NOFOLLOW|O_NONBLOCK` 打开一次,在该描述符上校验属主、类型与大小后再限量读取——先查路径再读文件在 agent 自己的目录里是两个文件(可换成符号链接或 FIFO),而无上限读取是对 root 进程的内存耗尽杠杆。
- reset 同样先落盘意图再发布空入站:死在两者之间会让旧 hash 与密钥与一份空配置并存,之后对同一规格的部署会走空转分支、永远不恢复入站。
- 助手在发布配置之前先把本次规格与密钥记为 `pending`,发布并确认监听后才改为已提交;发布失败回滚配置时状态也一并回滚——失败的轮换若把新密钥留下,下一次部署会静默采用它并让已发出的订阅全部失效:进程若死在两者之间,Xray 已在跑新配置而状态还写着旧的,再下发旧规格就会走空转分支并回报一个没人服务的端口。`pending` 状态只用于复用密钥与判断变化,永不用来回答。
- 每次真正走到部署路径都会重新下发用户(不只在本次重启时):上一次可能重启后就失败在 reconcile 之前,而助手对重复请求会回 `restarted:false`。下发的 flow 变化会先移除既有用户再按新 flow 重装——Xray 无法被问出某个用户的 flow,而 `Node.flow` 决定所有客户端配置。
- agent 在助手改动机器之后、验活之前就把规格记为「已应用但未完成」:否则一次「助手成功、随后失败」的部署会让本机以为自己仍在跑旧规格,再次下发旧规格时走捷径、报告一个 Xray 已不再服务的端口。捷径路径也会重新解析对外地址(机器换 IP 或运维改了 `CHORDV_NODE_PUBLIC_HOST` 时,不能因为 Xray 无需改动就继续下发旧端点)。
- 写回是一条带条件的 `UPDATE`(`inboundAppliedRevision < 本次 revision`):先读后写在并发完成时仍可能让旧结果覆盖新部署。
- 部署成功的判据是**运行中的实例**:`getSysStats` 加按 tag 查询 `getInboundUsers` 都通过才算完成;助手失败、端口/SNI 与下发不符、验活失败一律让命令响亮失败,不写任何 Node 字段。
- agent 在回报之前先用与控制面相同的规则校验对外地址(公网单播、按字节判断),不通过就让命令带着地址与 `CHORDV_NODE_PUBLIC_HOST` 的提示失败——服务端仍是权威,但错误不该拖到控制面才浮现、还要人工回溯是哪次部署。
- 节点对外地址来自 `GET /api/agent/v1/whoami`(控制面看到的来源地址,走已鉴权信道),`CHORDV_NODE_PUBLIC_HOST` 可覆盖。控制面独立校验为公网单播地址,并校验端口/SNI/flow 等与下发一致后才写回 `Node`。
- 写回只让节点**可以被激活**(`isNodeOnboardingReady` 转真),`isActive` 仍由管理员决定;迟到的结果不会覆盖更新的部署(按 `Node.inboundAppliedRevision` 的条件更新判断)。
- 本机残留他人身份的入站配置(重装/还原备份/换身份)时,agent 启动即请求助手发布空入站,宁可不提供服务也不拿旧节点的密钥继续服务。是否残留由助手的只读 `status` 操作按其持久状态回答,而不是看上一份结果文件——一次失败并回滚的部署会留下 `ok:false`,而此前的入站仍在服务;助手崩溃则连结果都没有。探测本身失败时不做清理(清理是破坏性的,凭猜测会让健康节点掉线),只记录告警。
- 助手拒绝使用其它配置片段已声明的入站 tag:Xray 的 confdir 合并是按 tag 覆盖的,以 `api-in` 部署会顶掉计量入站,而 agent 是不可信输入方,不能只靠它自己的 tag 校验。无法解析的片段一律按冲突处理(看不见的 tag 也要保护)。
- Xray 二进制走同源分发 `GET /api/agent-download/xray/:arch`(另有 `.sha256`),需要部署侧提供 `CHORDV_XRAY_DIST_DIR`;未配置即报错,不回退到其他下载源。
- `deploy/chordv-node-agent.service` 里的交接目录写成可选(`-/var/lib/chordv-xray/requests`):这个单元文件由 `install-systemd.sh` 安装,而它只创建状态目录——硬性要求一个不存在的路径,systemd 连 mount namespace 都建不出来,agent 起不来,连既有的用户管理负载都被拖死。控制面渲染的单元保持硬性要求:同一个安装脚本必然先建出该目录,严格性在那里是真实的不变量检查。回归:单元里每个不带 `-` 前缀的 `ReadWritePaths` 路径,都必须出现在 `install-systemd.sh` 的 `install -d` 行里。
- 「等待入站」意图的建立拆成**只读探测与破坏清理两半**:探测在 start() 一进来、任何启动对账之前执行——refreshConfig、恢复路径、重启检测都会下发用户,而 Xray 拒绝向不存在的 tag 加用户,start() 抛错会让唯一能恢复节点的 `ENSURE_INBOUND` 永远送不进来。探测与控制模式**无关**(全新重装的本地模式还是 shadow 默认,而后台快照才把它翻成 direct_primary 并带着用户),问助手三件事:助手未安装(没有结果目录)⇒ 这是运维管理 tag 的旧世界,同样没有部署记录,用户必须继续流动,不推导任何等待;助手报告**什么都没部署** ⇒ 受管主机上的 tag 只可能来自部署,下发无处可去,记下等待意图;部署了但本身份没有记录 ⇒ 他人身份的残留,同样先记等待意图。等待意图持久化(`meta_v2` 的 `inbound_awaiting`,重启后自身探测失败也能得出同样结论),`ENSURE_INBOUND` 完成时清除。破坏性清空留在 refreshConfig 之后:此时模式已知(全新 store 的本地默认是 shadow,后台的答案才是决定),只有 direct_primary 才允许改写 Xray。典型场景:既有节点(带用户)重装到全新 VPS——安装器只给出基础+计量片段,首次启动若向缺失的 tag 下发用户即抛错死循环。回归:全新 VPS + 后台快照带用户 + tag 初始不存在,启动不抛错、期间不向缺失 tag 下发、部署完成后用户补齐、意图清除。
- fallback 目标(`dest`)的**地址策略**由 root 助手强制:Reality 会把非 Reality 客户端的连接未经认证地从公网转发到 dest——指向 `127.0.0.1:10085` 等于把无鉴权的 Xray gRPC API(HandlerService)挂上公网监听器,`169.254.169.254` 则是云元数据。判断按**解析出的字节**而非文本:文本前缀匹配会放过 `::ffff:7f00:1`(127.0.0.1 的十六进制写法)与 `0:0:0:0:0:0:0:1`(回环的长写法),IPv4 映射的 IPv6 一律按内嵌 v4 判断。域名解析后逐地址判断,混合记录(一条公网一条回环)按 DNS 重绑定拒绝,解析不出、或答案根本不是地址,同样拒绝。校验过的地址随后**固化**进配置而不是保留域名:Xray 对域名 dest 逐连接重新解析,保留域名等于把「部署时查过」的保证留一个部署后重绑定的窗口(agent 可能控制该域名);固化地址随本次部署冻结(状态记录 `pinnedDest`),站点正常轮换 DNS 不会触发重启——重新下发同规格仍是无操作,只有规格变更才重新解析并固化新的地址;若域名之后解析到内网,重新下发会响亮失败而生效配置仍服务旧的安全地址。有 v4 记录时优先固化 v4(回退拨号不依赖主机 IPv6),仅 v6 时按 Xray 的 host:port 语法加方括号。默认解析器用同一个 node 二进制跑 `dns.lookup`(getaddrinfo,含 /etc/hosts),与 Xray 自己解析 dest 同源;检查在任何发布/空转分支之前,拒绝的 dest 不产生任何副作用。控制面在入队时同样拒绝明显字面量(管理员得到 400 而不是一次失败的部署),但重绑定只有站在节点上的助手看得见。
- `trust proxy` 覆盖**两跳**代理拓扑:1Panel 部署里 agent 的请求过 openresty(TLS 终结)→ admin 容器的 nginx → api,两跳都追加 X-Forwarded-For,agent 的地址离 socket 两项;原来固定信任一跳(且仅在生产强制 HTTPS 时生效),`request.ip` 解析到 openresty 侧地址——whoami 返回私网桥地址让 `ENSURE_INBOUND` 过不了公网校验,或把代理主机的公网地址当成节点的发布出去。默认信任私网周边(loopback/私网/CGNAT/链路本地):该拓扑的所有代理都住在那里,而 agent 从公网拨入,行走停在第一个公网地址——agent 自己伪造的 XFF 项也越不过代理合法追加的那几项。`CHORDV_API_TRUSTED_PROXIES` 可按部署收窄或替换(逗号分隔的 proxy-addr 项),`false` 只信 socket;设置改为**始终**生效,与 HTTPS 强制解耦——whoami 的观测地址依赖它。

### 2.3 新增:agent 发布托管

- agent 构建产物 tar.gz(linux-x64 + linux-arm64)挂到现有 release 中心(`releases` 存储,走 artifact 下载路由)或独立 GitHub Release
- `POST /api/agent-install/script.sh`:注册令牌放在 JSON 请求体中，禁止放入 URL；动态生成安装脚本。下载通过公开的 `GET /api/agent-download/:arch` 流式分发，断开连接也须结束控制器和生命周期工作。

### 2.4 修改:管理端"添加节点"

- 表单:基础信息(名称/国家/地区/标签/启用开关)+ **删除全部 PanelConfigurationFields**(panelBaseUrl/Username/Password/InboundId/panelEnabled)
- 提交后:预创建节点 + 签发注册 token → 引导页(install 命令 + 复制 + 状态轮询"等待 agent 注册…"→ 成功后自动跳到节点详情)
- 节点详情:Agent 状态卡(在线/版本/队列深度/xray 状态/上次心跳,数据来自 NodeAgent 表)替代面板状态;入站部署按钮 + Reality 参数展示

R2-B 落地细节:

- 入站部署区块挂在节点控制器抽屉(健康卡与阶段清单之间),分两半:参数展示(接入地址/SNI/Reality 公钥/shortId/flow/fingerprint/spiderX/部署 revision,均来自 agent 回填的 `Node` 字段,`toAdminNodeRecord` 补齐了 realityPublicKey/flow/fingerprint/inboundAppliedRevision 的映射)与「部署入站 / 调整参数重新下发」。payload 只携带操作员真正决定的两项——监听端口与 SNI,其余保持控制面默认;服务端照常归一化与校验,客户端不做二次校验逻辑。
- 队列响应是**命令**不是结果(带 targetRevision),完成判定靠轮询:节点记录的 `inboundAppliedRevision` 追上该 revision 即完成(3s 间隔、失败退避至 30s、5 分钟超时;超时只提示,命令仍在队列)。轮询的会话纪律与接入引导钩子一致:抽屉关闭或切换节点即失效,迟到的响应/轮询不得改状态、发通知或解锁新会话的请求。
- **`rotateKeys` 按破坏性操作呈现**:选项仅在已部署节点上出现(首次部署没有可轮换的密钥),勾选后展示红色警告并要求二次确认「已发出的所有订阅将立即失效」才能提交——回归同时守着文案与提交门槛的源码断言。

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
- 两个交接目录都挂在 root 拥有的 `/var/lib/chordv-xray` 下(`requests/` 归 agent 0700、`results/` 归 root 0755),agent 单元只为 `requests/` 开 `ReadWritePaths`:如果请求目录的父目录归 agent,被入侵的 agent 可以在重装前把它换成指向 `/usr/local/lib/chordv` 的符号链接,`install -d -o chordv-agent` 会跟着链接把助手脚本目录的属主交给 agent——下次 root 执行的就是它写的脚本。安装脚本因此先拒绝三个目录上的符号链接,再设置属主。
- 清空他人入站之后不立刻补下发用户:入站的 tag 随配置一起没了,Xray 无法把用户加进不存在的 tag,那次 reconcile 会抛出 `start()`——正好干掉唯一能接收后续 `ENSURE_INBOUND` 的进程。改为记下待恢复意图并挂起所有 reconcile 路径(启动、配置刷新、离线恢复),等入站重新部署时由 `ensureInbound` 一并补齐。
