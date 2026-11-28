# Go 服务端迁移验收

## 范围与运行边界

- 源目录 `apps/server`：独立 Go 模块，直接实现业务，不转发旧 Node/NestJS API。SQL 保留原 PostgreSQL 表名、列名；独立 `_chordv_migrations` 校验迁移，不依赖 Prisma 运行时。
- 默认 local。当前所有运行及数据库验证仅使用项目独立 PostgreSQL 17、`127.0.0.1:55437/chordv_mygo_local`，不读取根 `.env`、旧 `DATABASE_URL` 或线上凭据。不自动创建业务样例或管理员。
- 已实现显式 production 配置，而不是把只能本地运行作为永久限制。生产模式使用独立 `CHORDV_*` 配置，远程数据库 verify-full、强独立密钥、HTTPS origins、受信代理、出站白名单及 Secure Cookie；没有启动或连接任何真实生产环境。完整字段见 `apps/server/README.md`，发布包附 `SERVER-CONFIG.md`。
- 旧发布中心 CRUD、旧数据库版本投递、服务端在线自更新/回滚退役；版本与组件来自显式配置的 GitHub Ed25519 签名清单。旧历史表只用于保留迁移兼容，不是版本真相。存储接口保留为当前本地托管目录的真实扫描/受控临时文件清理，不再读取旧发布中心。
- 未提交 Git、未推送、未发布 GitHub、未安装 VPS Agent、未操作线上。

## 0.0.34 当前源码的双架构发行包启动验证

本地从同一源码快照构建并暂存 Linux arm64、x64 的 Go 服务端、管理后台静态文件和 Agent。分别从最终 tar.gz 解压执行服务端，使用断网、无宿主端口映射的本地 Linux 容器、临时 PostgreSQL 16 和随机凭据。两份包均通过重复迁移、就绪接口、未登录管理接口返回 401、管理员登录、鉴权后读取 `releaseSource=github` 与 `selfUpdateEnabled=false`，并在 SIGTERM 后正常退出。宿主 Docker VM 为 arm64，x64 结果属于兼容执行，不等于原生 x64 VPS 部署。同一源码快照的版本排序、架构选择、新旧版本混排及分页 HTTP 回归合计 21 项通过（含子用例）。归档和 SHA-256 见本机 `.tmp/ui-qa/round100-backend-gXQrbP/`；未签发正式清单、上传 GitHub 或操作线上环境。

管理后台另做了发行包浏览器验收：不使用 Vite 或模拟 API，直接从上述 Linux arm64 归档解出 `admin/`，以同一源码的本机 Go 服务和临时 PostgreSQL 提供接口。Chrome 在 1366×900 窗口登录、创建 17 GB / 3 并发的个人套餐，整页刷新后复查，随后打开系统设置并退出。没有外部请求、退役发布中心请求或页面异常；系统设置页无横向溢出。截图与仅含请求方法、路径和状态的记录位于 `.tmp/ui-qa/round102-admin-ui-uEde4v/`。未运行真实面板反代，也不代表其余后台页面全部覆盖。

### 第 185 轮：GitHub 不可用时的客户端初始化

Build 184 所附双架构服务端归档在合法仓库配置下断网，实际复现 `/api/client/bootstrap` 返回 502。修复后，只有初始化中的版本查询设 2 秒总时限；发布源不可达、验签失败或版本查询超时时，返回 `version: null`，不丢账号、订阅和策略。父请求取消仍返回取消，独立版本及更新端点仍要求已验签的清单。

两份重建归档在无网、无宿主端口映射的容器中复验：初始化 200，独立版本与更新检查 502；每个架构 43 个退役发布入口均返回 404，重启后数据保留，禁用账号后旧凭证返回 401。本机草稿上传和渠道中断恢复、真实包内 Agent 供给均通过。客户端浏览器回归覆盖版本为空后进入主界面；未改生产 UI 或布局。归档、1,020 文件 SHA-256 清单与证据见 `output/local-candidates/chordv-server-0.0.34-round185/`；未操作真实 GitHub 或线上环境。

验证：定向 `go test -race` 五组通过；服务端首次全量在裁剪快照因缺 `apps/agent` 源码失败，改用完整快照后 `go test -count=1 ./...` 与 `go vet ./...` 通过。`pnpm check` 9/9、`pnpm test:browser` 15/15，未重跑本轮全仓 `pnpm test`。测试使用独立数据库，已退出。

## 已运行验证

2026-11-16 至 17，本地验证记录如下。HTTP fixture 的 Agent 回执只证明 Go 服务状态机；物理 Agent/Xray 验证独立列出，不能互相替代。

| 范围 | 当前证据 |
| --- | --- |
| SQL 与账号鉴权 | 真实迁移及重复迁移；bcrypt 保留密码原始空格；JWT HS256/过期/算法约束；单次刷新轮换与旧访问凭据失效；退出/停用撤销；持久化登录限流；管理员权限与 CORS 拒绝未授权来源 |
| 本地隔离 | 配置单测拒绝远端数据库、错误数据库名、host/service/options 覆盖、全网监听；默认不配置 GitHub 发布仓库；全部 API 数据库测试统一用随机私有 schema，不回退 public，保留真实 Start、双迁移幂等、10 连接池与 HTTP 鉴权 |
| production 配置 | 纯配置单测与 httptest 验证必填/强密钥/HTTPS origin/远端 DB TLS/出站白名单/受信 CIDR、XFF 防伪造、Secure Cookie；没有真实远端连接 |
| 用户/套餐/订阅/团队 | 真实 HTTP CRUD；有效个人订阅冲突；团队负责人/成员/共享订阅；不凭空续期或默认清流量；个人转团队加入已有可用团队订阅，原个人订阅保留归属并停用；无订阅统一 404 当前没有可用订阅，节点列表为空 |
| 多会话与安全策略 | 两节点多租约；同节点尚有有效租约时不删账号；最后一条旧节点租约被逐出才停用绑定；旧租约不能续租；后台并发策略收敛；订阅先锁定再处理绑定，避免计量/重置反向锁序 |
| 流量计量 | 新绑定零/既有计数基线；绝对计数及计数代变化；同代回退拒绝；乱序缺口补齐；相同序号篡改拒绝；重复批次幂等；旧 Node JSON 字段顺序兼容；个人以 Subscription/TrafficSnapshot/NodeUsageBatch 审计，TrafficLedger 仅团队分账 |
| 共享配额 | 实际 HTTP 计量后为每个 active 节点排入新的剩余配额命令；取消被替代的旧供给/配额命令，避免晚到命令重新启用旧绑定 |
| 流量重置 | 真实 DB 门禁：先停用，再等 disableWatermarks 的全部最终批次 accountedAt，最后清零；未结清不提前清零；HTTP 脱离后通过实际回执/计量事件自动完成；团队仅重置指定成员，其他成员账本保留 |
| 节点删除 | 真实 HTTP 两阶段：未结算返回 409，保留 Agent、停用命令和绑定；最终确认后再次删除才级联移除 |
| SSE 与命令 | 用户隔离事件、Last-Event-ID 重放；慢消费者显式 gap，重放窗口外全量同步；游标不倒退；双 SSE 连接原子领取命令；dedupeKey 不能复用不同节点/类型/正文；持久化命令重启恢复、重连后耐久队列补读、有限指数退避与 8 次上限；停用/移除命令由耐久自动重试及撤销任务机制跟踪，不提供人工重放入口 |
| 后台同步任务动作 | retry/dismiss 提交后统一返回全局 `{jobs,summaries}`，不把单 job 或 `{ok:true}` 写入前端队列；GET 的 nodeId/userId 仅过滤详情、摘要仍为全局；提交后通知管理员 SSE，retry 的新命令通过真实 Agent HTTP SSE 领取；队列重读失败保留旧 JSON null/前端重载契约，不把已成功的写入伪报失败 |
| 旧撤销任务 | 实现旧 job/节点重试 URL；从数据库恢复待执行撤销意图；按 subscription/user/node 组合范围撤销，后续实际禁用由耐久 Agent 命令跟踪。全 Handler 注册冒烟覆盖静态/动态路由，防止 ServeMux 歧义导致启动 panic |
| 在线状态 | 客户端 Ping 与 SSE 到期计时推送；匿名 Ping 不写用户版本；错误令牌 401；平台/版本/构建/渠道上报幂等；后台不增加业务轮询 |
| Achord Connect | 真实本机 HTTP Basic Auth；Webhook 原始字节 HMAC、时间容差、去重、乱序水位、同时间冲突、连接 generation/epoch 和查询期间新 Webhook 防覆盖；联系人诊断白名单/敏感值剔除/UTF16 截断、后台套餐与租约事实；指定 422 字段拒绝后无资料重试一次并抑制 10 分钟；连接切换后丢弃旧票据，重读新连接 |
| 工单和图床 | 真实本机 PNG multipart 上传、图片类型/体积约束、一次性上传凭据消费及重放拒绝；未消费附件到期删除，已引用图片不删除；上传后工单删除/写入失败时清理远端孤儿文件；进程重启恢复附件到期任务；接入新工单后旧工单只读 |
| GitHub 协议 | 原始字节 Ed25519 验签、篡改拒绝、固定仓库/标签 URL、Hash/路径、SemVer、不降级、旧客户端更新及组件投影。缺少旧 minisign 过渡安装包时 Tauri 自动更新 204，不冒充签名；未上报架构的旧 macOS 客户端跳到版本固定的下载页面，不默认 arm64 |
| Agent 文件分发/存储 | 本地真实产物清单与双架构 SHA256、篡改拒绝、Bash 语法；存储扫描逻辑/分配大小、硬链接估算、跳过符号链接，只清理允许目录中 mtime/ctime 均超过 24 小时的临时普通文件 |
| 版本构建 | `SYSTEM_VERSION`、实际 Go buildinfo Version/Commit/BuiltAt、`build-info.json` 一致；显式 release 构建和发布 verifier 同时核验真实嵌入 ldflags/native `--version`，版本输出不访问数据库 |

### 实际 Agent + Reality/Xray 本机端到端

原生代理维护的 `scripts/mygo-agent-e2e.mjs` 已完整通过，使用真实 Go Agent、真实 Xray、真实本机 API/数据库，没有向服务端伪造命令回执：

- 一次性注册；ENSURE_INBOUND 只读 Reality 校验；ENSURE_USER、REFRESH_QUOTA、DISABLE_USER 均实际 completed；客户端首次 connect 等待真实 Agent 确认并在同次请求生成租约。
- 首段真实上下行各 262144 字节，个人订阅/快照为 524288 字节；原样重放真实 batch 不重复扣量。
- 暂停原始计量请求后，尾段上下行各 65536 字节；停用回执产生一个非空终结 watermark；放行最终批次后账本完整结算为 655360 字节；Xray 用户实际移除，旧凭据的新连接被拒绝。
- 这是当前主机实际二进制链路，不等同于 Linux VPS 安装、Windows 客户端或所有平台发布资产组合验收。

### 验证命令

本地 DB 环境通过 `loadLocalEnvironment()` 或受保护的 `.data/mygo/local-env.json` 注入，不输出凭据，并固定 `CHORDV_MODE=local`、`GOTOOLCHAIN=go1.26.2`。

节点任务契约回归位于 `internal/api/command_queue*_test.go`、`internal/api/command_retry_integration_test.go`。retry、dismiss 两轮红测分别实际捕获单 job 和 `{ok:true}` 导致缺少 jobs 数组；进一步复核发现旧队列缺少历史过滤，已撤销早期“处理后旧 job 仍在队列”的错误断言，恢复动作后旧任务消失的契约。450 条 completed/已处理历史不占详情上限；210 条其他对象任务不能挤掉过滤目标，摘要不受 200 条详情分页影响；nodeId/userId 同时提供时使用交集。排序恢复 status/nextRunAt/createdAt，错误摘要取最新记录。

人工 retry 只接受未处理 cancelled 的 ENSURE_USER/ENABLE_USER，按钮另检查 active binding；实际执行在 subscription→binding→node→command 锁序下重新读取任务，按当前绑定重建 ENSURE_USER。真实行锁门禁红测曾复现同一任务两个请求均 200；修复后必须一项 200、一项 404，只有一个替代任务。failed、其他命令类型、停用绑定、未就绪节点/已撤销 Agent、不可用订阅等场景不能生成新命令。retry 通过真实 HTTP SSE 检查 Agent 收到的命令 ID/版本和当前绑定 UUID，管理员收到提交后的任务刷新事件。重读失败专项以取消读上下文验证真实路由必须输出 `null`，曾红测捕获空 body；这是刷新分支的故障注入，不冒充真实动作提交时的数据库中断。这里未操作后台正常控件，不把接口回归当作任务弹窗及布局验收。

- 节点任务最终专项：`go -C apps/server test -race ./internal/api -run 'Test(CommandRetryRejects|ConcurrentCommandRetry|CommandQueue|RetryCommandReturns|DismissCommandReturns)' -count=1` 通过，8 项测试（拒绝测试含 13 个子场景），API 39.179 秒；`go -C apps/server test -race ./internal/api -run '^TestConcurrentCommandRetryOnlyQueuesOneReplacement$' -count=10` 通过，API 19.059 秒；`go -C apps/server vet ./...` 通过。
- 同轮尝试 `go -C apps/server test -race ./... -count=1` **未全绿**：API 124.558 秒，`TestTicketMultipartDoesNotSaveEmptyInvalidOrTwoStepFailures` 的独立工单夹具返回 HTTP 404（期望 502）；任务队列专项没有失败，config/database 通过。工单夹具由对应任务修复；双方停止修改后的统一全量验收由主流程执行，不沿用更早的全绿记录替代本轮结果。

- `go -C apps/server test ./... -count=1`：此前已通过；追加测试后以最终 race 结果为准。
- `go -C apps/server test ./internal/api -count=10 -run 'TestDetached|TestMultiSession|TestNodeDeletion|TestSharedQuota'`：通过，API 9.887 秒，无死锁日志。早期异步重置测试曾捕获死锁，已调整计量预锁订阅、回执绑定/节点/命令顺序，不能隐去该修复过程。
- `go -C apps/server test ./internal/api -run 'TestImageUpload|TestSupportDiagnostics|TestSupportLaunch' -count=1 -v`：通过，API 1.367 秒。
- 追加接管及旧栈清理阶段（早期记录）`go -C apps/server test -race ./... -count=1`：通过，API 81.422 秒、config 1.706 秒、database 8.758 秒，无 race 报告；追加旧撤销范围测试单独 `-race` 通过，API 3.916 秒。`go -C apps/server vet ./...` 和 `node --check scripts/mygo-build-backend.mjs` 均通过。
- `node scripts/mygo-build-backend.mjs --platform macos --arch arm64 --release`：已通过；产物经 `.github/scripts/server-build-info.mjs` 严格核验，实际 --version 与嵌入元数据一致。此前阶段产物及版本一致性复验通过；追加接管和清理后按授权未再次正式 release 打包，接管/清理阶段源码已通过编译、全量 race/vet 和实际 CLI --help；后续追加变更以本节最新专项及全量记录为准。

## 旧 Prisma 基线接管补充验收

新增独立 `--adopt-prisma-baseline`，仅接管从 `20260717000000_init` 到 `20260928150000_achord_connect_support` 的完整已知 27 份历史迁移，不自动兼容任意旧版本或缺失履历的 db-push 结构。默认迁移现在会拒绝未知现存业务结构和未显式接管的旧 Prisma 基线。

- `schema_contract.go` 的结构契约实际来自内嵌 SQL 在随机 `go_adopt_test_*` 私有 schema 中重放，并读取 PostgreSQL 系统目录生成：47 表、499 列、33 枚举、109 约束、139 索引；无手填 ORM 猜测，也不依赖旧 `apps/api` 源码。
- 显式命令使用 schema 作用域 advisory lock、事务及短时 SHARE 表锁，只有所有历史 checksum/顺序/结构核验通过后才原子写 Go 履历。旧 Prisma 原行、回滚记录、原成功时间和业务数据全部保留；Go 履历部分写入/篡改不能靠接管覆盖。
- 成功演练逐字 JSON 比较 User、Plan、Subscription 与设置；初次写 27 条，重复接管不改变 applied_at，随后单独 `Migrate` 只执行新增第 28 条默认策略迁移，旧行不变。CRLF checksum、步骤数为零的显式成功记录、已回滚审计记录保留均通过。

负向案例均实际运行，拒绝后 Prisma/Go 履历及业务快照不变：

| 组别 | 实际拒绝案例 |
| --- | --- |
| Prisma 履历 8 类 | 缺少成功迁移、未回滚失败、checksum 篡改、未知迁移、重复成功记录、执行时间逆序、完成早于开始、只有回滚记录没有对应成功记录 |
| 业务结构 8 类 | 缺少必需表、列类型变化、null 约束变化、默认值变化、枚举变化、外键缺失、唯一索引缺失、未知额外表 |
| Go 履历 4 类 | 部分基线已写、hash 篡改、历史缺口、未知记录 |
| 默认与事务边界 | 缺少 Prisma 履历、默认迁移遇到未知表、默认迁移遇到未接管 Prisma 库；锁等待取消无写入；触发器在第 3 条插入时抛错，前 2 条亦整体回滚；两个并发接管归一为一次写入与一次幂等 |

所有演练只创建/删除随机私有 schema，不重置共享 QA public schema。首次完整 database 用例通过 4.412 秒；补齐并发/中途失败的首轮 race 通过 6.131 秒，最终行尾兼容后完整 database race 复验 7.328 秒通过，database/cmd vet 和实际 CLI --help 通过。演练前后共享 QA public 的28条 name/hash/applied_at 聚合MD5均为 `3f5bdeb32bca9c55ee22ef129a2c8a94`，临时 schema 数量均为0。生产接管未执行，原地接管能力不再依赖保留旧 Node/Prisma 可运行实现；实际部署仍需备份和单独授权。

### Build 186：用真实 Prisma 履历和发行包演练备份接管

分别使用 arm64、x64 的原始 Linux 发行归档，在无网、无宿主端口映射的 PostgreSQL 16 容器内演练。旧库由 `397a64d` 的 Prisma schema、迁移文件和旧锁定版本 Prisma CLI 6.19.2 实际执行 `migrate deploy` 生成，27 条 Prisma 履历不是手填数据。写入临时账号、套餐、订阅和设置后，以实际 `pg_dump -Fc` 备份并 `pg_restore` 到同一容器内另一空库；历史工具只通过临时本机回环管道访问容器。

两份包内程序均验证：直接 `--migrate` 拒绝接管且不写 Go 履历；显式 `--adopt-prisma-baseline` 写入 27 条并保留原完成时间，重复接管不改动履历；随后 `--migrate` 只追加第 28 条。业务和原 Prisma 履历在接管前后逐行比较不变，源库未被 Go 接管。真正启动包内 Go 服务后，旧账号用原测试密码登录，读取相同套餐、订阅及已用 2 GiB。容器已停止并删除；x64 属兼容执行，只覆盖受支持的完整 27 份历史基线，不代表未知历史库或线上迁移。绑定两份包 SHA-256 的日志与报告见 `output/local-candidates/chordv-1.1.12-build186/evidence/prisma-adoption/`。

另从头复验了含已发布 `99.0.0`、强制升级标志和旧下载地址的旧库。接管不删旧发布和附件记录；配置的 GitHub 发布源断网后，初始化仍返回 200（版本为 `null`）、独立版本和更新接口返回 502、旧下载接口返回 404。两架构四个响应都未出现旧版本或旧下载地址，没有把遗留记录当成备用发布源。

## 未执行与仍需注意

- 没有启动 production、连接远程生产数据库、配置真实域名/SSL/面板进程或做生产迁移；这些需要独立部署授权。production 目前证据是配置拒绝边界和本机协议测试，不冒充线上验收。
- 没有 Linux VPS/systemd 安装测试、所有 CPU/操作系统真实客户端组合、正式证书签名、公证、GitHub 上传或旧安装包跨版本过渡安装验证。
- 管理员最后一人保护已用数据库事务级全局串行锁覆盖普通账号变更与踢出停用路径，但没有在现有共享本地库中停用全部真实管理员来做破坏性并发验证。
- 图床域名/凭据更换后，旧地址的未消费附件会保留清理记录，不能把旧凭据发送给新站点；需保留原图床有效访问方式才能完成远端删除。远端和数据库同时不可用时，上传后即时清理只能记录失败，不能宣称具备跨系统原子事务。
- 并发限制目前是 API 租约级：同一用户与节点的多个租约沿用旧模型，共享 VLESS 绑定 UUID。通过客户端 SSE 撤销及最后有效租约离开后停用账号，不宣称能在保留同节点其他租约时精准阻断恶意旧客户端的单条 VLESS 连接；租约级独立凭据需另行改变兼容与计量模型。
- 后台布局、客户端布局由主流程验收；服务端子任务未修改前端/CSS。测试 fixture 仅在 `_test.go`，生产路径没有 Mock 数据或假接口。

旧栈已按逐文件白名单清理；274个tracked源路径及保护检查见 `legacy-backend-cleanup.md/json`，原schema非运行快照位于 `legacy-schema/`。本机ignored历史缓存/凭据仍受保护，不是当前构建依赖。

旧接口索引见 `apps/server/legacy-routes.json`：implemented 仅表示存在对应实现；retired_release_center、retired_github_delivery、retired_server_self_update 表示明确退役，不等同于遗漏业务。行为证明以本文件的实际验证为准。

### 主流程后续统一复验

工单图片夹具的身份错误修正并停止双方写入后，根`pnpm check`6/6、`pnpm test`84/84通过；服务端完整race通过，API125.463秒。主流程随后先把新增队列8项改为私有schema wrapper，保留`server.Start()`真实worker；当时再次完整race和vet通过，API123.436秒、config2.458秒、database7.197秒。该阶段的分域wrapper已由下述统一夹具替代。

迁移前的整套测试public设置整行指纹检查曾未通过：迁移指纹不变、私有schema0→0，但既有public测试会写回集成设置及更新时间，不能据当时测试全绿宣称整库零写入。新增队列8项当时单独race42.397秒通过，前后迁移/两项接入设置整行指纹均一致且schema0→0，证明当时仅新增范围已隔离；旧记录保留，不清空或改写QA数据来消除差异。

本轮将全部API数据库测试统一为 `isolated_schema_test.go` 内唯一 `newTestAPI`，删除原工单/队列两套helper；原有公共库helper从 `integration_test.go` 移除，工单、图床和队列调用同一入口。仅测试连接池设置 `search_path=api_test_<随机UUID>,pg_catalog`，生产DatabaseURL仍只接受原有 `sslmode` 参数。继承10连接/UTC、两次真实Migrate并逐行履历摘要验证幂等、真实`server.Start()`及管理员HTTP登录；退出按服务/连接池/本次随机schema清理，不清空public。新增夹具回归验证两套私有schema的初始业务空态、设置不串库及跨schema令牌401。

统一后 `go -C apps/server test -race ./... -count=1` 通过：API128.166秒、config1.937秒、database7.456秒；`go -C apps/server vet ./...` 通过。所有原业务断言保留，没有用public历史数据补夹具或放宽断言。只读REPEATABLE READ前后比较public User2、Node1、Plan1、Subscription1、SystemSetting2、迁移28条的全部整行SHA-256（含设置更新时间），六类逐表完全一致，聚合SHA-256前后均为 `dad936e37d5407809e80865b7f00339429ecff327c30060e0e709fcbda848016`。临时schema0→0，67个生产Go文件SHA-256完全一致；未重启主API/后台/数据库。脱敏证据为 `output/local/api-schema-isolation-before.json`、`output/local/api-schema-isolation-after.json`、`output/local/api-schema-isolation-report.json`、`output/local/api-schema-isolation-validation.json`，不包含数据库凭据或业务行明文。

合并multipart图文回复已恢复旧DTO：真实图床失败且文字有效时先真实保存后返回`attachmentUploadStatus=failed`与错误；成功返回uploaded，无图片纯文字返回none。非法图片、无内容、非属主、已关闭及两步上传不借部分成功绕过校验，独立schema的8项图床/工单race通过。相关实现为`ticket_writes.go`、`ticket_multipart.go`、`imagebed.go`，测试为`ticket_multipart_test.go`、`isolated_schema_test.go`、`image_integration_test.go`。上述端点证明不替代后台正常控件和布局验收。

### 站点主地址与本地文件清理契约修复

- 站点地址以 `settings.go` 的同一数据库读取为来源，管理端/客户端返显、Webhook URL及Agent安装脚本API_BASE均使用保存后的主地址；仅配置行不存在时使用启动默认。数据库读错或非法存量配置直接报错，不退回旧URL；local只接受回环HTTP，production只接受HTTPS，不从Host/X-Forwarded生成公开地址。真实HTTP先红测捕获保存成功后Webhook仍为3100，修复后覆盖保存/重读、安装脚本、关闭并重建Server/HTTP实例的持久化恢复、读错和地址边界。原默认启动地址的纯配置函数改名 `defaultPublicOrigin`，不再由下游误作当前主地址。
- 本地 `FileCleanupJob` 执行归入 `file_cleanup.go`，首次清理、人工重试和定时恢复共用持有任务行锁的执行器；`Start()`只恢复当前DataDir托管临时路径，按持久化nextAttemptAt交给已有scheduledTasks，不新增轮询。失败持久化attempts、最新lastError和UTC退避时间（1分钟起指数退避，最多24小时），提交后才安排下次执行；人工失败仍返回旧版“已处理本次尝试”DTO，由现有UI重新扫描读取真实失败状态。缺失任务/文件/父目录幂等收敛，blocked、越界及非托管路径不执行删除。跨请求行锁覆盖实时文件检查和删除，避免同job被两个并发请求重复执行。
- OsRoot、24小时mtime/ctime、普通文件及逐层非symlink检查保留；未读取/删除主服务DataDir或旧发布目录。私有schema与真实临时目录测试先捕获旧人工重试409但不记状态、启动恢复无提交事件；严格退避上下界还实际捕获TIMESTAMP无时区写入的8小时偏移，改为显式UTC。覆盖真实新文件/仅mtime回拨保护、外部文件/托管保护文件/符号链接原样保留、过期目录快照的实时复核、启动deadline/失败恢复、缺失父目录与同job并发。现存文件的ctime不做伪造，成功收敛分支用真实缺失文件；没有把“删除真实已满24小时现存文件”冒称为本轮实测。
- `go -C apps/server test -race ./internal/api -run 'TestSiteAddress|TestProductionOriginsProxy|TestAgentArtifacts' -count=1`：第一阶段通过，API6.437秒；主流程仅在该阶段停写后编译过固定二进制，不作为后续清理修复的运行证明。
- `go -C apps/server test -race ./internal/api -run '^TestFileCleanupConcurrentRetriesProcessSameJobOnce$' -count=10`：通过，API13.907秒。最新 `go -C apps/server test -race ./internal/api -run 'TestFileCleanup|TestStorage|TestSiteAddress|TestProductionOriginsProxy|TestAgentArtifacts' -count=1`：通过，API18.012秒；`go -C apps/server vet ./...`：通过。前端/CSS未修改，正常控件及布局验收由主流程使用重新构建后的二进制完成；此阶段未以早前全量绿测代替追加修改后的统一全量复验。

### 剩余清理证据与非法批次异常

“真实现存文件mtime/ctime均满24小时后被删除”仍未验：禁止改宿主时钟、伪造ctime或借用用户资产，只能让本轮独立创建的文件自然老化。已在忽略目录创建本轮专属样本 `.tmp/cleanup-age-proof/970f9da5-c4ae-43a1-8917-72bdba7faa25/managed/tmp/natural-age.part`，文件0600；上一级 `age-record.json` 也0600，仅含本地dataDir/file/ctimeNs，记录真实ctimeNs为 `1794859092178170591`。最早自然验收时间为2026-11-18 03:58:13（上海时间）；后续须先确认该ctime未变化，重新核实真实mtime/ctime均超过24小时，再通过独立API/私有数据库仅清理这个自建样本。没有设定自动化、后台任务或默认测试入口来触发该删除，当前不记通过。

另补真实批量异常：旧HEAD的 `storage-catalog.service.ts:156-167` 先整批校验，Go曾在循环中先执行第一项，再因第二项无效返回400。`file_cleanup_batch_test.go` 使用真实新文件和实际扫描，只注入过期目录判断、不修改文件ctime；4个子场景均先红测捕获首项已被写入/重置（未知第二ID、不可清理第二项、第二路径越界、首项已有失败任务）。`file_cleanup.go` 改为完成整个输入选择的ID/托管路径校验后才执行目标，拒绝批次的清理任务整行状态和真实文件完全不变；合法批次正向控制仍逐项经过实时文件保护并记录失败。此保证针对输入预校验，不宣称多个文件的运行时操作具有跨文件事务原子性；24小时/OsRoot条件没有放宽。

`go -C apps/server test -race ./internal/api -run 'TestFileCleanupInvalidBatchHasNoPartialEffects|TestFileCleanupValidBatchStillRecordsEachLiveFailure' -count=1` 通过，API7.337秒；`go -C apps/server test -race ./internal/api -run 'TestFileCleanup|TestStorage' -count=1` 通过，API21.398秒；`go -C apps/server vet ./...` 通过。只改清理模块、新批次测试与本段记录，不重复队列/工单整链，不操作主服务目录或线上；追加变更后的完整统一验收由主流程复核。

## 第12节团队语义与真实计量修复

默认团队kick不再删除成员或全账号断连；显式禁用才使用与updateUser共用的账号级事务。kick/remove团队范围和锁序统一，真实HTTP/SSE/heartbeat及并发屏障通过；正常UI实际成员清零不影响另一成员、默认kick保留成员和另一活跃租约、个人转团队保留expired历史均已现场验证。

团队usage不再返回原始ledger或只取最新一项，列表/单条/独立usage和成员总量共用一套批量聚合；真实字节优先并兼容旧GB、未知节点及历史成员，recordCount为实际行数。全新双Agent/Reality三批计量得到14680064/29360128B、每人3条，API/正常UI为0.014/0.027，SSE更新保留原Modal/table且无额外usage请求。前端同时分离Agent online与内核healthy，不再误报等待心跳。

最终服务端全量race API191.582秒、config1.501秒、database6.875秒，public Team/Member/Subscription/Ledger/Settings/迁移整行摘要一致，私有schema0→0；统一check6/6、test98/98和普通构建通过。测试替身只在测试入口，现场没有SQL造账/造绑定/伪回执。详细文件与边界见`local-verification-20261117.md`第12节；自然24小时现存文件删除仍最早11月18日03:58:13再验，原样本未修改。

## 第13节订阅动作与工单连接补充

续期/换套餐按旧DTO剥除额外usedTrafficGb/state，PATCH及显式重置保持原意；成员重置复用唯一bytes优先/旧GB回退表达式，保留其他成员及另一团队数据。工单切换已有地址/Client ID必须轮换Webhook Secret；连接预检不借用客户入口，关闭入口也可测，专用测试联系人不发送管理员身份，显式重验绕过属性负缓存但保留真实422的一次无字段重试。

新API65099/PG65100的真实HTTP和正常UI续期/换套餐后0.25GB保持，关闭入口测试200且仍关闭。完整服务端race API245.992秒、config2.218秒、database11.148秒；统一check6/6、test99/99，主public八类整行摘要一致、私有schema0→0。两套隔离进程/root/凭据已清理，没有线上操作。SQL混合历史账本是明确测试夹具，不冒充真实Agent新流量；自然24小时现存文件删除仍未到时。文件/命令及未修候选见本地验证第13节。

## 第14节本地自动安装与契约补充

订阅专用数字归一先于任何写入/marker，117项非法HTTP全部400且六张私有表不变，11种旧合法转换与null拒绝语义保留；不改通用number或结算锁序。全量race API255.042秒、config2.435秒、database7.844秒，主public八表摘要一致、私有schema0→0；主API36763没有重启。统一check6/6、test99/99及构建通过，具体四个服务端文件和红绿见本地验证第14节。

### 第16节：Agent供给与策略布尔契约

Agent安装分发不再依赖缺失的DataDir手工包。同次server/双架构Agent构建、编译manifestSHA锚、真实Go版本/Commit/平台/架构校验、GitHub完整归档及固定exe目录消费已实现；最终源码重新构建并离线临时签名/归档/正常HTTP节点创建和脚本/双架构下载验证通过，无token明文proof，无Linux系统安装或线上发布。旧文本成功夹具改真实Agent，破损文本仅为负测。详见agent-release-supply-completion.md和第16节。

策略PATCH的blockAds/chinaDirect/aiServicesProxy现在在任何DB读取前严格要求JSON bool；48非法样本真实HTTP全400且私有schema48表摘要不变，旧modes/缺省/白名单语义保持。显式DB的完整server race API298.829/config2.080/database11.818秒，421 pass、0fail；仅三个明确opt-in skip，其中两个归档/专用exe测试已另外真实执行。早期未带DB的28.887秒日志不作为API集成证明。主服务和public数据未修改，全部证据见第16节。

### 第17节：断连/凭据旧契约与存储空间

团队kick的disableAccount只有true/false/null/缺省合法；11非法样本旧Go曾实际200断连并发SSE，现事务前拒400，48表/sequence/SSE无副作用且旧null语义保持。工单四字符串字段按真实旧Nest DTO/helper的42边界结果归一，33负向/6nullable及191/512/JS trim/省略/清除/轮换控制通过；不改通用boolean/text或未验证字段。数据与SSE red/green/全行摘要详见第17节。

恢复原有磁盘可用空间字段：Linux/macOS扫描通过已打开DataDir FD的Fstatfs返回Bavail×Bsize，精确数值检查，SSE/list持久snapshot一致；其他平台明确null+warning而非假数值。根重命名/closed-root/整数溢出测试通过。显式数据库完整race API349.348/config4.087/database15.603秒，484pass、0fail，只有三个明确opt-in跳过且归档两项另行实际执行。最新完整server/双Agent归档和HTTP链再次验证，不启动或重启主API，正式部署/系统安装仍未执行。


### 第18节：安全PUT旧契约与正常启动

套餐安全PUT现在专属白名单/必填/旧Number转换及Prisma截断/int32边界，不再借安全入口修改其他套餐字段；普通POST/PATCH不变。旧真实Prisma37样本、5项HTTP race、21拒绝全48表/SSE零业务副作用及实际3会话收敛正控通过。独立完整start.sh创建管理员和两次重启、真实节点安装脚本/双Agent下载/退出清理通过；启动期取消遗留PG也有真实红绿。最终完整DB race API362.044/config3.973/database16.240秒、489pass/0fail；三个opt-in中归档/exe已另验。未验边界以本地验证第18节为准。


### 第19节：Node PATCH完整契约与通知隔离审计

严格7字段/显式null拒绝、JS trim/tags/country、旧启用条件/状态转换/空更新语义恢复；750/534/102静态数据由当前共享源码+锁定ISO生成，仓库工具和check/test检查漂移，Node20/24/25均实际通过。56非法输入、10就绪拒绝、双SSE/全48表摘要与真实HTTP撤销/回执/重启用已验。全量和两个独立进程并行红测确证数据库级NOTIFY频道跨schema把foreign command_ready写入replay；现生产事务和每次listener重连共享schema频道表达式，public保留旧频道、私有按schema摘要隔离。同ID双向隔离、同schema真实Agent SSE和专属监听重连/catch-up已验，未放宽观察器。完整证据见本地验证第19节。旧客户端自动过渡仍204，Go原型仅_test.go，正式Windows升级未实现。


### 第20节：新建Agent节点旧输入/保存契约

新建入口专属校验恢复严格类型、nullable/default、validator.js呈现序列长度与名称UTF-16二次门禁，tags保持原值，节点强制inactive；不把PATCH规则复用于创建。原96样本/62拒绝，真实HTTP4项race7.777秒、普通20项通过，48表/序列/SSE零副作用和令牌/真实注册正控已验。共享panel内部未完整重审且不改本地地址隔离；仅3文件，详见本地验证第20节。


### 第21节：客户端自定义路由CRUD

原DTO/完整service/真实Prisma与filter83样本、4项HTTP race22.165秒/普通12项已过。专属校验恢复nullable/字符数/UTF16/trim与helper顺序，关键词不误用域名label、100上限400、空更新不写但仍推送、删除deletedId和所有权保持。63拒绝全48表/序列/三路SSE零业务副作用，25个自有schema与临时Prisma已清理；原null及Unicode切片500按实证保留，不以本轮声称panel内部完整审计，详见本地验证第21节。

## 第22轮补充

第22轮panel入站normalizer/parser按职责移出，旧实现删除而非并存。实际397a64d helper/DTO/parser的243输入形成oracle；168 normalizer/75 parser、75解析HTTP、100非法排队请求的全48表/SSE0副作用、58合法spec排队payload全等及规范公钥/长SNI真实Agent SSE+回执正控通过。修复类型/default、JS trim、公钥trim后输出、版本、129–253字节SNI、错误类型静默默认、空type/username、坏转义unknown/分号、点根路径与IPv6 canonical。原local/production网络谓词未改；parsePanelReport/commandResult所有类型负分支未全审。证据round22-server-panel，专项race7项、重复21项/vet通过。

## 第23轮补充

面板回执已按真实397a64d DTO/helper的157输入（13通过/144拒绝）与17个真实Prisma事务场景核对，修复status/result/error类型、4000字符、数字端口、tag不得trim、旧payload重规范化、inactive/revision/首激活条件、实际tag冻结/完成dedupe释放、failed错误原文/default。仅Go Agent回执专属实现，不改通用字段helper/网络策略/停用水位。

保留新Go Agent持久cached completed ACK重放200（同/冲突合法DTO正文均48表零写/SSE0），不机械恢复旧404；cancelled仍409，failed保留Go指数退避而非旧30秒。实际SSE发现失效panel先交付并导致后续合法任务提前消耗attempt，最坏8次重投非无限；现Node锁内active排队400且不耗revision，claim同一事务仅取消已激活/过期的pending/running/failed panel并释放:cancelled:id，保留payload/错误/审计，重复claim零写/事件0。Node只MVCC读，避免Job→Node反向锁；commit后取消行>0才发一次node_access_updated。原key可用于新合法部署，非panel/未过期panel正常交付。

13专项race20.484秒、3次重复12.093秒、vet/4项现存Agent缓存恢复通过；32组claim与真实HTTP回执并发、持Node锁的非阻塞claim及真实唯一约束触发整事务回滚均通过。94个精确自有schema、临时Prisma客户端/引擎清理，public11表不变。相关9文件SHA与红绿证据见round23-server-report/REPORT.md。MVCC只能避免尚未领取的失效重投；并发后失效的在途帧仍可能收到一次400/409，不声称物理撤销网络中消息。最终统一全量门禁见local-verification-20261117第23节。

## 第24轮：公告写入/消费及非UTC日期

恢复公告专属严格DTO/trim/120与4000字符限制、modal_countdown缺省5/显式0拒绝、离开倒计时归0/重选恢复、删除ID及级联、客户端10字段投影和publishedAt/createdAt双降序。更新采用行锁事务保证mode/countdown串行等价，提交后仅一次带announcementId的事件；16组并发及真实延迟提交约束失败的48表/SSE0均已验证。旧DTO+五完整原service经私有Prisma/PostgreSQL执行258样本（109接受/147拒绝/2旧Date503改前置400）、7转换、精确admin/client SSE与旧读状态保留已核。

主流程复核未把第一次全绿当完成：旧oracle仅UTC；原new Date对无TZ datetime在上海/纽约分别按本地时钟，而第一版Go固定UTC。另实证单纯time.Date对NY春季gap、Lord_Howe秋季fold与JS不同。现仅公告局部用time.Local/ZoneBounds做compatible解析：重叠取早，缺口按真实offset gap前移；date-only仍UTC，Z/显式offset不变。四个独立TZ子进程44个原Date对照、四TZ各258条真实HTTP/DB/SSE表已通过，测试不写全局time.Local、不调用生产函数生成期望；普通无DST样本单独按已实证当地映射，DST期望来自原Node表达式。

相关代码/测试/fixture已按职责拆分，未改通用date/helper、策略业务或增加生产依赖。第一次check7/7、test104/104和server race575pass为first保存，修后全量以第24节最终证据为准；不把旧UTC-only绿报告当新源码证据。详见round24-server-announcements/REPORT.md与timezone-audit。只覆盖已记录ISO calendar/四时区及DST样本，不宣称任意非标准Date/所有历史时区数据/跨操作系统实机均相同。

## 25. 本地发布恢复、计量保留与当前真实内核复核

/Users/achordchan/Downloads/不同步的桌面/项目/ChordV/.tmp/ui-qa/round25-server-metering/completion.md

第25轮仅本地：显式resume-channel已用当前双架构真实Go归档/临时Ed25519/回环HTTP验证7场景，47项发布测试通过；所有恢复只写渠道，未写GitHub或放松legacy门禁。服务端补回计量30天已入账payload清空、90天resolved异常、30天Webhook保留任务，每表5000×40/跳锁/逐块提交，17/43分固定小时，失败下一小时继续；批次行/hash/序列/水位保留。订阅提示改为当前用户最新有效租约/在线健康Agent/90秒宽限，显式message，不被团队其他节点污染；旧16案例与13项专项race、真实旧boot重放/终结水位通过。134注册实现不是134端点行为全等价证明。

计量异常手机定位portal/祖先样式缺口待专项复现修复；其他设置/用户安全DTO/站点细节/自动孤儿发现与一般provisioning扫描未因本轮13专项而宣称全等价。

## 26. 计量提示定位与用户安全写入契约

用户安全PUT从通用用户编辑拆成专属白名单：缺省/null/只有额外字段都清override恢复套餐策略，额外password/role/status/displayName/authVersion等忽略不落库；复用已有Number/Min1/正小数截断，存在用户时int32越界503，缺用户先404，非法DTO先400。原Nest DTO＋完整原方法＋真实Prisma6.19.2/原模型私有schema实证48条，原27条红现绿；只读/写入全48表及三方SSE、3条真实HTTP租约同步逐出2条通过。专项5项×2次race34.983秒/vet通过。普通PATCH、共享plans/users/concurrency/events与round25的16冻结源码未改；原pending/通用租约差异明确保留，不用窄测试冒称完整后端等价。

证据：.tmp/ui-qa/round26-user-security/completion.md、concurrency-boundary.json。用户安全保留Go事务内同步收敛，不仿造原50ms defer总pending。共享租约算法仍有旧300秒宽限/lastHeartbeatAt+issuedAt排序与当前状态过滤/排序的已知差异，见concurrency-boundary.json；本轮只证明输入/存储/事件和当前Go收敛，不宣称租约算法等价。用户创建/编辑DTO、站点/自动孤儿发现/一般provisioning完整对应仍待定向证明。

## 27. 租约、认证恢复与签名发布协议

本轮先按旧方法真实差分，修正服务端默认TTL/HB/grace为1800/30/300秒、过期+宽限半开硬截止、逐出排序/默认3/正override及终态原因/撤销时间/审计持久化，重复心跳不重复生成终态审计。保留同步事务收敛、最后有效租约离开才停共享UUID并排DISABLE，不机械退回旧异步行为。实际又复现跨用户互换Node的40P01（500/200），现完整Sub→Binding→Node稳定预锁后200/200；Plan范围后插入Sub再补锁也实证40P01，现事务内冻结已锁Sub集合，任何Node阶段未知Sub在补锁前409并全事务回滚，正常无插入200/200、显式重提收敛。59顶层相关race及旧v1/v2反控保留，不宣称所有业务锁序已被普遍证明。

最终DB race818项；所有package/skip见round27-server-real-race-summary.json。共享节点/同一完整Sub集合会等待；晚插入Sub明确409需重提，不靠忽略新订阅制造成功。计量提示仍保持既有未软过期租约口径，未改为宽限计数。站点origin规范化/历史域名去重、其他DTO/自动孤儿发现/一般provisioning完整旧新对应仍待定向审计，本轮不宣称后端全部等价；未改全局HTTPSOrigin。

## 第28轮统一本地验收

修复用户创建/编辑输入；站点专用canonical/IDNA去重；缺失账号由事件与启动恢复，坏marker不饿死其他缺口；真实Owner/FK、Member/Sub、Token/User死锁与旧JWT撤权后新建租约均先红后绿。GitHub草稿原bundle只补缺项恢复、完整流审核及Content-Length已进生产CLI。Mac schema2普通GUI独立进程整链通过；新Build28/新后端和归档均本地重建。

最终冻结后 `pnpm check` 9/9、`pnpm test` 110/110；真实DB race971项（API 717.76秒），Native完整e2e/race424项（369.675秒，私有普通Build28 schema1/schema2均实际执行）。Linux/Windows双架构16组交叉编译/vet通过，不当实机。实际新双架构Linux归档+原bundle+真实Git/HTTP三恢复模式436请求通过。

保留全部原红及夹具错误：用户空密码/非法字段/转换差异；Owner多种40P01与connect敏感保存后旧JWT仍200/active1；站点canon/DTO；publisher污染、隐藏draft及缺Content-Length。Owner广专项55pass/1观测失败来自共享PG全局advisory把其他schema计入锁链，修正仅精确schema观测，expected2/等待预算不变，显式外部链正负控证明；root首次全量本身971pass/770.801s，随后仍对最终helper再完整重验。Native早期04通过但泄漏自有16943导致06 ACK拒绝，fresh PID/签名/启动身份核实后精确终止，测试清理根因修复并连续两次及root新包全量通过；不改生产单实例/ACK、不回溯称从无遗留。原390浏览器缩放图有底部重复捕获，但DOM仅1个App/标题；独立标准模式真clock390/820无重复，不锁定单一成因。旧契约Prisma初次生成日志明确自动加载根.env，不宣称从未读取；未输出其值、实际DSN均显式私有本地。已隔离cwd+最小环境+RootEnv读取阻断器重生成/重跑87例，读取尝试0、可观测输入/存储/密码结果相同；两批临时29文件client均清理。最终扩大hdiutil扫描还发现1份仅attached自有测试镜像；时间归因未知，按精确image-path/UID/readonly/整盘唯一归属二次核验后普通detach disk11成功，前后证明保留。原环境断言失败保留，不能把手工清理当生产缺口修复或回溯称原本零遗留。

逐文件/摘要、完整命令、环境和未验范围见 `.tmp/ui-qa/round28-completion.md`、`round28-final-report.json`；原始日志保留。无UI/CSS改动，8份上轮冻结客户端前端源码SHA未变，检查后台名称溢出样式与空密码正常提交契约；已重跑并查看当前客户端820/390与后台1024/390截图；原390捕获异常另用标准模式独立截图和DOM复核，非目标OS实机布局证明。未新增生产Mock或临时probe，无重复上传/普通用户校验/心跳替代链；未提交/推送/发布/部署/主服务重启、系统代理写入或正式证书操作。完整目标仍active。

- 新发现且未修复：macOS更新清理在mountpoint detach失败后仅按同Fsid误判成功，可能遗留仅attached设备并删除marker；旧assertMacNoMount只查work字符串也会漏检。本轮扩大扫描发现1份自有测试镜像（产生时间未知），精确普通detach后归零，不代表生产cleanup已修好。下一阶段优先修复设备归属记录/清理与严格负控。
- 按用户决定未改宿主系统代理、未用DeveloperID/profile/公证/Authenticode；Windows真实安装/旧updater/恢复、目标Linux桌面、移动端/Intel/旧macOS尚未实机验，交叉编译不替代实机。
- 可信自动journal恢复仍只读inspector，认证intent及启动自动回放未实现；schema2旧客户端需可信bootstrap，不因本轮本地GUI通过而松正式门禁。
- 未做GitHub云端/Actions上传下载/权限/公开库实际发布；complete-draft不自动清starter或替换错资产。100页库存上限闭合失败；远端前后审核不是跨资源事务。
- 旧scripts/mygo-agent-e2e.mjs仍依赖主本地API/output/local及public表，本轮未运行；当前后端物理Agent/Xray整链应先改成独立实例/私有schema。Native真实Xray与HTTP回执/真实包供给不冒充该整链。
- 用户普通编辑相同active状态等后续副作用、其他DTO与一般provisioning完整旧新行为仍待定向核验；本轮不宣称后端全部等价或所有锁图已普遍证明。
- 密码创建/修改保留本项目72字节上限，不恢复旧bcryptjs静默截断；87例输入存储及邮箱用例不是全部Unicode/邮箱标准的普遍等价证明。
- 构建含dirty工作树，嵌入HEAD不代表远端已含改动；后台chunk>500kB警告保留。public48行摘要/PID/代理mtime与大小不证明索引、统计、全进程内存/日志或共享PG通知完全无变化。

## 第29轮：镜像归属与隔离Agent整链

当前生产API/Start、生产Agent和真实Xray在独立回环host/私有schema通过7项整链：上下行各262144字节，尾流量各65536字节，最终655360字节；原计量批次重放幂等、非空停用水位结算和旧凭据新连接拒绝均核验。主流程独立重跑报告：/Users/achordchan/Downloads/不同步的桌面/项目/ChordV/output/e2e/agent/e2e-1794955197492-f494049d/report.json。旧public按行清理入口已无消费者并删除。

普通用户显式保存相同active状态会重复产生供给命令：已复核旧Nest/当前Go静态条件，尚未修复或完成真实副作用对照；不等同已证断连或重复计费。 真实Go API/Start+生产Agent+真实Xray为本机私有schema链；不代替生产服务端CLI、Linux/systemd、3x-ui或跨机器验收。 本轮服务端生产业务源码未改，上一轮971项DB race属于历史证据，不冒充本轮重跑。

逐文件、完整验证和未验边界见 `.tmp/ui-qa/round29-completion.md` 与 `round29-final-report.json`，历史失败日志保留。

## 第30轮：状态迁移去重与恢复边界核验

第30轮修复相同启用保存重复供给、相同停用保存重复撤权；正常敏感编辑、真正启用、并发策略和订阅刷新保持。最终check9/9、test110/110；真实DB race986项（API 784.539秒），定向15项；当前Go后台＋生产Agent＋真实Xray10项通过，最终精确计费659456字节。旧真实服务图15例由root独立再现，122份HEAD源精确核对。

保留Go相同active真红（新增Node/Binding/ENSURE）和相同disabled真红（认证版本2→3、RefreshToken重复写）；物理Agent同active真红也实测Node revision2→3。初次物理观测误读不存在的directAppliedRevision列只算夹具错误，修正后才取得真实回归证据；两份失败报告保留、schema/进程先终态后仅清除各自精确临时目录。首次构建命令漏工具链PATH，Go1.23.2在GOTOOLCHAIN=local下拒绝，修正环境后3构建通过；未为此改生产构建器。旧oracle保留Unicode/DTD元数据/search_path/WorkLifecycle观察器原失败及修正，未改旧供给或认证逻辑。

完整race默认跳过3个专用入口：2个真实归档/可执行路径测试随后用官方供给脚本显式补验；TestGenerateLegacyPrismaContract是会写golden fixture的生成器，本轮不启用。2个无测试包不是验证失败，不把986项写成零skip。 仅修普通用户真实状态迁移门禁，不宣称所有旧后端副作用逐项等价。旧真正启用会即时＋延迟生成2条ENSURE，新Go有意按受锁迁移只供给1次，并已证明可实际恢复访问。 旧oracle是完整真实方法/DI/Prisma与隔离PG，但未启用Nest HTTP bootstrap、cron消费者、监听器或旧物理Agent；旧撤租约pending Job不是最终执行证明。初始disabled/刷新令牌为明确fixture初态，不推广为旧完整停用→启用生命周期。

逐文件及完整证据见 `.tmp/ui-qa/round30-completion.md` 与 `round30-final-report.json`；历史失败保留。

## 管理员改密与会话：本地归档后台 0.0.34

从 Linux arm64 服务端归档取出后台静态文件，在 Chrome 的两个独立浏览器上下文登录同一个临时管理员。API 是当前源代码构建的 macOS Go 进程，数据库为新建的本地 PostgreSQL；未使用线上账号、服务或用户资料。通过可见开关展开密码输入框；两次输入不一致时保存禁用且没有写请求。正确提交后 `PUT /api/admin/me/security` 返回 200；当前页面刷新仍可使用后台，另一个已登录页面刷新后回到登录页。旧密码登录返回 401，新密码登录返回 200 并进入后台。

记录：`.tmp/ui-qa/round108-admin-security-bw6goF/results.json`（仅方法、路径、状态和判定，不含密码或令牌）。第一次尝试点击隐藏的原生 switch 输入超时；改为点击其可见关联标签后整条流程通过，未改生产逻辑。此项是正式归档前端与本地 Go 服务的联调，不证明 Linux 运行环境或第三方身份服务。

### 改密修复后的双架构归档（本地 0.0.34）

最新归档位于 `.tmp/ui-qa/round111-backend-0JAjgP/workspace/release-assets/`，同轮 `SHA256SUMS` 和 `source-sha256.json` 分别标识安装包与未提交的源码快照。arm64 和 x64 归档的 `admin/` 逐文件相同。从归档解出的前端在 Chrome 登录本地 Go API 和独立 PostgreSQL 后修改密码：仅带原始首尾空格的密码能登录；旧会话刷新被拒绝，发起改密的会话刷新正常。两个归档中的 Linux 服务端也分别在无外网、无宿主端口映射的临时容器执行两次数据库迁移、登录、改密、按原文登录及退出；二者均拒绝去掉首尾空格的密码。x64 是在 arm64 主机上兼容执行，不宣称 x64 物理机验收。未改线上版本、未创建或替换 GitHub Release。

### Build 122 快照：补跑隔离环境可选用例

使用同一候选源码、全新 PostgreSQL 和真实 Xray/GEO 只读来源的独立副本，显式启用 `CHORDV_TEST_AGENT_ISOLATION=1` 与 `CHORDV_TEST_PSQL=1`。上轮默认跳过的六项均执行；三个相关测试文件共 15/15 通过、零跳过。另运行 `node scripts/mygo-agent-e2e.mjs`，用真实 Go Agent、私有 schema 的 Go 后台和回环 Xray 测试节点完成十项端到端检查，包括使用量重放不重复计费、停用后最后一批结算、重新启用后恢复传输。故意中断和正常完成两条路径均验证自有进程停止、私有 schema 剩余为零；三份原始组件摘要未改变。证据目录 `.tmp/ui-qa/round124-optins-nUxgd9/`。手动预置组件不是 GitHub 下载验证；回环测试不替代 Linux 独立服务器或跨主机验收。

### 归档后台的站点地址保存与客户端读取（0.0.34）

用双架构归档中先前核对一致的后台静态文件（本次从 Linux arm64 包提取）、当前源码编译的 macOS Go 服务和独立 PostgreSQL，通过“系统设置 → 管理地址”实际提交。带路径的回环地址、非回环 HTTPS 地址分别返回 400，失败后客户接口仍返回原配置；点击“重新读取”恢复原值。有效的 ` HTTP://LOCALHOST:80/ ` 归一为 `http://localhost`，三个旧地址中重复项与主地址被排除，最终仅保留 `http://127.0.0.1`。保存响应、无需管理员身份的客户端读取、后台页面刷新后重新打开的表单三者一致。1366×900 窗口中弹窗完整可见，无外部请求或页面异常。首次将非回环 HTTPS 当作本地成功输入的测试预期有误；按本地配置契约修正后在新库完整复测，未放宽服务边界。证据在 `.tmp/ui-qa/round129-site-TLt1FP/{results.json,site.png}`；未测试或变更真实 DNS、证书、线上来源或部署。

### 小文件单位修复后的本地归档：0.0.34

两份 Linux 归档和描述文件在 `.tmp/ui-qa/round131-backend-zKZugm/workspace/release-assets/`，摘要在同轮 `SHA256SUMS`。使用各自包内服务，在断网的临时 Linux 容器扫描 0、37、2048、1048576 字节文件，两种架构均返回逻辑合计 1050661 字节，扫描完成事件与随后读取的清单完全相等。两包后台静态目录逐文件一致；从归档提取的页面在 Chrome 中连接本地 Go API，四行分别显示 `0 B`、`37 B`、`2.0 KB`、`1.0 MB`，刷新保留，未发清理请求。后台专项 34/34 条命令通过；签名前离线流程用临时 Ed25519 密钥生成 schema 2 清单，两份归档各自通过 Agent 接入及双架构下载验证。Linux x64 兼容执行，不代替 x64 实机。本轮不创建或覆盖线上 0.0.34，不部署。

### 重启后事件流去重的 0.0.34 归档

归档与描述文件在 `.tmp/ui-qa/round134-backend-sjDoQa/workspace/release-assets/`，同轮 `SHA256SUMS` 记录包摘要。两种架构分别从归档启动，隔离容器内保留真实 PostgreSQL，在已有管理事件连接时终止并重启服务。携原令牌和上个进程的事件游标重新订阅：仅收到一次 `replay_gap` 全量同步，九类初始事件各一次；能查回重启前的公告，且重启后新公告送达到同一订阅。计数以新公告事件作为初始同步结束的界线，不靠固定等待时间。用上一轮 arm64 归档跑同一条件得到两次全量同步。两份新归档均通过 SHA-256 校验及 schema 2 临时签名前供给测试。无外网容器；x64 属于兼容执行；未触发线上重启、签名发布或部署。

### 含后台重连退避的 0.0.34 归档

两份新 Linux 归档及其描述文件见 `.tmp/ui-qa/round136-backend-I3nbkr/workspace/release-assets/`；两包后台静态目录逐文件相同。用归档页面在 Chrome 中登录同源码构建的本地 Go API，保持页面不刷新，终止临时服务并由回环反代将上游拒绝连接返回 502。原会话实际重连间隔依次为 3.051、6.413、12.199 秒，服务重启后携原游标收到一次 replay_gap，未重新登录即可打开站点地址表单。首次静默断开代理套接字时，同一重试时点出现多条底层 GET，不能作为应用重试次数；该日志保留，502 场景用于测量应用退避。两份包内 Linux 服务另在断网容器验证重启后九类通知各一次、新事件可达；两包均通过签名前离线 Agent 供给校验。未更改宿主网络或部署。时间戳、请求和事件在同轮 `results.json`。

### 凭据刷新临时失败不退出的 0.0.34 归档

本轮两份 Linux 归档、描述文件及校验值在 `.tmp/ui-qa/round138-backend-z6xDxb/`。每种架构均使用自身包内的后台页面和服务程序，数据库在断网临时容器中。Chrome 正常登录后，测试反代对站点读取注入一次 401、对刷新注入一次 503；表单显示可重试错误，页面未退回登录。再次读取时注入一次访问令牌 401，后续凭据刷新与设置读取均由包内服务真实返回 200，操作员无需再次输入密码。随后另一临时会话通过真实管理 API 改密；原页面的刷新请求收到包内服务的 401，返回登录页。两包均通过 schema 2 临时签名及 Agent 下载校验。x64 是 arm64 主机上的兼容执行。此次验收未更改现有账号或创建 GitHub Release。逐架构请求状态在 `results-arm64.json`、`results-x64.json`（无令牌或密码）。

### 当前本地服务端候选：切换管理员后隔离迟到请求（0.0.34）

两份 Linux 归档及摘要位于 `.tmp/ui-qa/round140-backend-mJSAvH/`。两种架构分别以自身包内服务、后台静态页面和独立 PostgreSQL 实测：回环测试代理暂缓转发管理员 A 的站点地址读取，浏览器正常退出并在同一页面登录管理员 B。另一个会话变更 A 的凭据后，释放原读取请求，包内 Go 服务真实返回 401。该响应未触发凭据刷新，未重发旧请求，B 随后主动读取同一接口返回 200；浏览器总计只有两次登录。两份归档的 HTTP 状态记录在 `results-arm64.json` 和 `results-x64.json`。两包均通过 SHA-256 及临时 schema 2 签名前的 Agent 供给校验。此项不覆盖多标签页的 Cookie 响应顺序、x64 物理机或正式发布。

### 候选包从旧库备份接管演练（0.0.34）

对第 140 轮 arm64、x64 Linux 归档各执行一次：在无网络的临时 PostgreSQL 16 容器内，使用旧提交 `397a64d` 的 27 份原始 Prisma SQL 建库，写入与原文 SHA-256 匹配的测试迁移履历和用户、套餐、订阅、设置样例。`pg_dump -Fc` 备份后用 `pg_restore --single-transaction --exit-on-error` 还原到独立目标库。包内 CLI 的普通 `--migrate` 在接管前拒绝，未留下 Go 迁移表；显式接管只登记 27 条，重复接管不修改时间或内容。随后 `--migrate` 仅增到第 28 条，再运行不改履历。还原后和全部操作后分别比较用户、套餐、订阅、设置以及 Prisma 迁移表的整行摘要，均与源库一致；订阅已用量始终为 2,147,483,648 字节。测试脚本、样例和两架构日志位于 `.tmp/ui-qa/round141-restore-jejL1B/`。旧履历和业务数据是隔离样例，不是生产备份；x64 为兼容执行，未测试线上迁移窗口、锁等待或真实业务数据分布。

### 已接管旧用户的登录与订阅展示

沿用旧提交 27 份原始 SQL 和隔离数据库备份还原流程，以旧服务依赖的 bcryptjs 3.0.3、成本 10 生成临时密码摘要并写入旧库用户记录，不通过 Go 接口重建用户或重置密码。两份第 140 轮 Linux 包各自接管并迁移还原库后，从 Build 128 生产前端登录表单实测：错误密码 401、原密码 200；bootstrap 仍返回原用户和订阅 ID，页面显示原套餐名称、总量 10 GB、已用 2 GB、剩余 8 GB，820×560 下无横向溢出。首次观测等待完整 URL 时漏匹配带查询参数的 bootstrap；按路径观察后用新库重跑两架构通过。证据 `.tmp/ui-qa/round142-migrated-login-fVgzQZ/{results-arm64.json,results-x64.json,migrated-arm64.png,migrated-x64.png}`。未使用生产用户密码、真实旧数据库或宿主代理；本项是 Chrome 内的生产前端，非原生窗口测试。

### 已接管旧刷新凭据的续期与失效边界

从 `397a64d` 的 `auth-session.service.ts` 提取并运行原来的 `generateRefreshToken` 和 `hashToken` 方法，在旧库样例中写入三条合成会话：有效、过期、已撤销。两种 Linux 归档分别备份、还原、显式接管旧库并完成 Go 新迁移。用有效旧凭据向包内 Go 服务续期返回 200，新访问令牌读取 bootstrap 仍是原用户和订阅；同一旧凭据再次使用为 401。新发凭据可再轮换一次，轮换后旧值为 401；迁移前已过期和已撤销的记录始终为 401。最终目标库只有一条未过期且未撤销的刷新记录，源库摘要（含刷新履历）未变。日志仅记录结果，不含凭据原值：`.tmp/ui-qa/round143-session-restore-ZMzijf/{arm64.log,x64.log}`。首次核对 SQL 引号有误，修正后在新容器完整复跑通过。此项仅验服务端续期，不说明旧客户端安装目录中的会话能自动迁移至 MyGo。

### 旧服务签发的访问令牌与新版 Linux 候选包（第 145 轮）

两种 Linux 0.0.34 候选包均已包含自定义 JWT 签发方修复。以 `397a64d` 原版 AuthSessionService、PrismaService、原 schema 生成的 Prisma Client 和独立测试库真实签发会话，不由 Go 构造旧令牌。将含会话的 PostgreSQL 17 SQL 备份还原至两个断网 PostgreSQL 16 容器（只剔除 16 不认识的 `SET transaction_timeout = 0`），分别接管旧迁移并运行对应归档。相同密钥和签发方的旧访问令牌均能读取原用户与订阅（200）；仅签发方不同则为 401。旧刷新令牌轮换返回 200，轮换前的访问令牌随即返回 401。此结果不验证桌面升级时会话文件搬迁，也不是整套旧 Nest 服务端的 HTTP 登录测试。

归档、源码指纹、四项校验和、两架构访问结果和 Chrome 管理后台切换账号回归在 `.tmp/ui-qa/round145-linux-JEDcxJ/`。浏览器首次未解包静态文件而收到 404，随后从对应候选归档提取后台资源重跑，两架构均通过；x64 通过兼容执行，不是 Intel 实机。本轮未发布或部署。

### 第 193 轮：接管旧节点账号的停用回执和最终流量

旧 Nest 把删除中的节点账号标记为 `deleted`，保留绑定 ID、邮箱和最终计量资料。此前 Go 只接受 `disabled` 的停用回执且跳过 `deleted`，会出现后台保存授权返回 200、但账号仍未下发的情况；如果停用在旧服务迁移前尚未结算，还会拒绝对应的 Agent 回执。

Go 现在可在后台保存授权、进程启动或 Agent 回执与用量入账时恢复这些旧记录，也让客户端首连走同一更新路径。恢复同时要求节点仍有授权、用户和订阅有效、节点已就绪、最终流量已入账。普通闲置 `disabled` 账号仍按原有显式恢复标记处理。恢复时复用绑定 ID 和邮箱，更换节点 UUID，只归零节点计数基线，不清套餐累计；同一代次只排一条新供给。只接受原节点、匹配绑定和当前代次的旧 `REMOVE_USER` 回执，陈旧回执仍拒绝。复用现有 Agent 事件调度，无新增轮询。

| 文件（`apps/server/internal/api`） | 改动 |
| --- | --- |
| `provisioning.go` | 定义旧绑定恢复条件和共用恢复操作；换凭据、重置节点计数，保持订阅用量。 |
| `subscriptions.go` | 保存授权时在现有事务内核对绑定及结算，并复核后台任务的恢复资格。 |
| `scheduler.go` | 启动后发现仍获授权的旧绑定，交给已有节点事件任务处理。 |
| `commands.go` | 接受状态与代次都匹配的旧 `REMOVE_USER` 回执，复核节点和绑定，拒绝迟到代次。 |
| `sessions.go` | 客户端首连复用同一旧绑定恢复逻辑，Agent 确认供给后才建立使用新凭据的会话。 |
| `missing_provisioning.go` | 复用节点就绪条件，补缺行仍不处理任何已存在的绑定。 |
| `legacy_deleted_provisioning_test.go` | 私库真实 HTTP 测试保存、重启、首连、旧回执与后续用量，并覆盖撤权、未就绪、待结算和陈旧回执。 |

定向 `go test -race` 的迁移与供给组 23 项、计量与会话相邻组 14 项通过（含子测试）；`go -C apps/server vet ./...` 通过。旧记录由隔离测试按原版行形状写入；真实 HTTP 先累计 120 字节，旧最终样本入账后为 220，恢复账号发首批新计量后为 255，未丢失或重复计费。Agent 回执由测试客户端发送，未重跑真实 Xray 进程。相邻组一次流量重置任务遇到 `40P01`，重试后用例通过；修改前对照仅两次完成，第三次受磁盘空间不足中止，不能判定该瞬态问题是否由本轮引起。全量 Go 服务端回归先遇 Agent 链接磁盘空间不足，随后私有 PostgreSQL 进入恢复，未取得通过结果。原始日志：`.tmp/ui-qa/round193-legacy-node-binding-tQqEZm/`。

本轮未改变数据库结构、公开 HTTP 形状或客户端、后台前端（258 个文件摘要与 Build 192 一致）；未引入生产 Mock，未重打安装包、发布或部署，私有 PostgreSQL 已退出。

### 第 194、196 轮：服务端全量回归及持久候选包

第 194 轮在专用内存盘上使用私有 PostgreSQL 和 Go 临时目录，执行 `go -C apps/server test -p 1 -parallel 1 -count=1 -json ./...`，共 1,029 项通过、0 失败、3 项按条件跳过（含子测试）。未再记录第 193 轮相邻用例的瞬态死锁，不能据此证明该并发路径无风险。测试数据库退出、内存盘卸载；当时两份 Linux 包仅在内存盘暂存，未保留本地候选。

磁盘恢复后，第 196 轮核对 1,023 文件摘要与第 194 轮完整相同，重构建并保存 Linux ARM64、x64 归档，见 `output/local-candidates/chordv-1.1.12-build196/server/`。这两份包的 Agent 供给、安装脚本、内嵌来源校验和篡改拒绝通过真实归档的隔离 HTTP 测试。服务端全量默认跳过的两个 Agent 归档与可执行目录用例均在本轮补跑；第三项是显式生成旧 Prisma 契约，不作为运行时已验项。使用临时密钥和回环 GitHub 模拟，实际新归档通过草稿上传中断、补齐文件、渠道更新中断及恢复验证。证据收录于同一候选目录 `evidence/`。

Docker 本地套接字未就绪，本轮没有直接执行两份 Linux 包内服务或 Agent。归档及 HTTP 供给证明不替代 Linux 实际启动、部署、Windows 安装或线上 GitHub 发布。源码、数据库结构及前端布局未改，私库已退出。

### 第 198 轮：直接启动 Build 196 原始 Linux 归档

不接入 Docker daemon 或现有磁盘，使用无网卡、无共享目录的本地 Linux 虚拟机。两份归档及解包后的服务端可执行文件在虚拟机内均通过 SHA-256 核对。ARM64 在 ARM64 Linux 内原生执行；x64 在同样的隔离 Linux 环境中用 QEMU 用户态运行原始 x64 可执行文件，不等同于 x64 实机。每次均使用全新 PostgreSQL 17.12 内存盘数据库，服务和数据库只监听虚拟机的回环地址，虚拟机正常关机。

两个包都完成数据库迁移、创建管理员、真实登录和订阅、旧节点绑定恢复及撤权验证。恢复后原绑定和邮箱不变、UUID 更新、只排一条新供给、套餐使用量维持 120 字节、节点计数基线归零；再重启服务能继续读取订阅，禁用账号后原令牌返回 401。43 个旧发布入口均返回 404；断网时客户端初始化继续返回用户、订阅和策略，独立版本和更新检查返回 502，没有回退旧发布中心。两份包的 Go Agent 可执行文件各运行 `--version`，实际服务通过 HTTP 提供两个架构的 Agent，下载内容和安装脚本摘要均与受测归档一致。Agent 注册与配置请求由测试客户端发起，未运行完整 Agent 守护进程或 Xray。

首次虚拟机启动发现默认本机内核没有启用 initrd，换用支持 initrd 的本机开发内核。首个成功启动的服务拒绝夹具发送的裸 Agent 版本号；修正夹具后保留裸版本 400 和带 `go-` 前缀版本 200 两项对照，未改变服务或原始包。不修改生产源码、前端、现有安装或 Build 196 交付目录，也不访问线上。日志和脚本：`output/local-candidates/chordv-server-0.0.34-build196-linux-runtime/`。

### 第 200 轮：Build 196 原始服务和 Agent 跑完整传输、计量与撤权

在同样无网卡、无共享目录的 Linux 虚拟机中，从已核对摘要的每份原始归档启动生产服务可执行文件和同架构 Agent 守护进程。ARM64 原生运行，x64 通过 QEMU 用户态运行。测试节点复用仓库 `e2e-local-node` 及其锁定的 Xray SDK，实际完成 VLESS/Reality 握手和回环数据往返，不替换服务端或 Agent 的响应。所有数据库、节点和凭据均为来宾临时数据。

每架构 11 项业务断言通过：真实 Agent 注册及入站确认、账号供给和租约、相同状态编辑不重复供给、往返各 262,144 字节且数据内容一致、同一上传批次重放不重复计费、停用时双向各 65,536 字节尾流量入账、撤销租约并移除 Xray 用户、旧凭据不能建立新连接、重复停用不再撤权、再启用只新增一次供给并恢复传输。再启用后的两向各 2,048 字节入账后，总计 659,456 字节；每架构六条节点命令全部完成。服务、Agent、测试节点均以退出码 0 结束，私有数据库停止，虚拟机正常关机。

首次运行仅因校验报告试图写入来宾只读测试目录而退出，改为写来宾临时目录，不放宽隔离权限。中间通过日志显示测试结束时仍有一条配额同步运行，最终追加等待和断言后，确认六条命令均已完成。原始失败和中间报告保留。没有修改生产代码、布局或 Build 196 归档；不替代 Windows 实机、完整 3x-ui/systemd 安装、独立 Linux VPS、宿主系统代理恢复或真实 GitHub 发布。记录与脚本：`output/local-candidates/chordv-server-0.0.34-build196-agent-e2e/`。
