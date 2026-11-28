# ChordV Go 服务端

本模块直接实现业务接口、数据库访问、Agent 控制与事件推送，不依赖或转发旧 Node/NestJS 服务。Go 只负责 API；管理后台是同包 `admin/` 的静态文件，由面板网站和反向代理提供。

## 运行模式

默认 `CHORDV_MODE=local`。本地启动脚本固定 local，不加载根 `.env`，不读取旧 `DATABASE_URL`。仅连接回环 `chordv_mygo_local` 数据库，监听回环地址，工单、图床、节点探测及客户端连接只允许回环目标。本地配置通过根 `scripts/mygo-local-config.mjs` 加载，凭据不写入构建产物。

`CHORDV_MODE=production` 是显式生产配置入口；实现此入口不代表已部署。生产启动不会回退读取 `CHORDV_LOCAL_*`，也不会自动迁移数据库、创建管理员或安装 Agent。

| 生产环境变量 | 要求 |
| --- | --- |
| `CHORDV_MODE` | 必须显式为 `production` |
| `CHORDV_LISTEN` | 必填 IP:端口。面板反向代理场景使用回环监听；只有明确网络隔离时才配置外网监听 |
| `CHORDV_DATABASE_URL` | 专用 PostgreSQL URL；远端必须 `sslmode=verify-full`，本机也必须显式设置 sslmode。仅接受 sslmode、sslrootcert、connect_timeout 参数，拒绝 host/service/options 等覆盖参数 |
| `CHORDV_JWT_SECRET` | 独立随机密钥，至少 48 字节；不与 Agent pepper 相同 |
| `CHORDV_JWT_ISSUER` | 访问令牌签发方，默认 `chordv-api`；接管旧库时如需保留仍有效的访问令牌，必须与旧服务的签发方和签名密钥分别一致。本地模式只读 `CHORDV_LOCAL_JWT_ISSUER` |
| `CHORDV_AGENT_PEPPER` | 另一独立随机密钥，至少 48 字节；轮换将使既有 Agent 凭据失效 |
| `CHORDV_DATA_DIR` | 专用可写目录的绝对路径，不能指向数据库或旧发布中心目录 |
| `CHORDV_PUBLIC_ORIGIN` | 外部 API 的 HTTPS origin；不能包含路径、凭据、查询或片段 |
| `CHORDV_ALLOWED_ORIGINS` | 逗号分隔的明确 HTTPS origins，必须含公开 origin；不接受通配符。后台与 API 采用同站点部署，以保持 Strict Cookie 行为 |
| `CHORDV_TRUSTED_PROXIES` | 明确 CIDR 列表；无反向代理必须显式为 `none`，拒绝全互联网 CIDR。只信任直连受信代理提供的 X-Forwarded-For，从右向左剥离受信代理 |
| `CHORDV_OUTBOUND_ORIGINS` | 可选的工单、图床 HTTPS origin 白名单。没有配置时不允许远端集成；每次请求重新校验，拒绝重定向 |
| `CHORDV_GITHUB_REPOSITORY` | 可选的 owner/repo，默认空；启用 GitHub 更新投影时必须显式配置 |
| `CHORDV_GITHUB_RELEASE_PUBLIC_KEY` | 启用发布源时配置固定 Ed25519 发布公钥；版本清单必须验签 |
| `CHORDV_ADMIN_PASSWORD` | 仅显式 `--create-admin` CLI 使用；正常启动不读取、不创建账号 |

生产 Cookie 固定 Secure、HttpOnly、SameSite=Strict。HTTPS 终止、域名、SSL、静态网站、进程管理与日志由部署面板配置；不默认 Docker，不在本轮创建或启动生产服务。数据库账号应仅拥有本应用所需权限，配置和数据目录只授予运行账户。

## 显式 CLI

- `chordv-server --version`：输出 version/commit/builtAt JSON，在配置校验或数据库读取之前退出。
- `chordv-server --migrate`：仅显式执行当前模式对应的数据库迁移后退出。首次部署或迁移旧库前必须备份；本轮只在独立本地库验证。
- `chordv-server --create-admin 邮箱`：从对应模式专用管理员密码环境变量创建账号，不提供默认管理员。
- `chordv-server`：校验明确环境后启动；默认 local。

## 构建

根 `scripts/mygo-build-backend.mjs` 构建 Go 二进制、后台静态文件、版本元数据、本说明及双架构 Linux Agent。默认包包含 `LOCAL-ONLY.txt`；只有显式 `--release` 才生成带 `DEPLOYMENT.txt` 的可配置发布包。脚本不启动服务、不执行数据库迁移、不发布 GitHub。

`VERSION`（设置时）必须与 `SYSTEM_VERSION` 完全一致。版本、Git commit、构建时间及 Agent 清单 SHA256 实际注入 Go `internal/buildinfo`，`build-info.json` 不是唯一证据。构建保留 Go 的 ldflags 元数据供离线独立校验。

Agent 供给只来自运行中可执行文件旁的 `agent-dist/`，不读取 `DataDir`、共享 current 目录或远端 latest；迁移时不要手动向数据目录补包。完整归档必须原样解压到独立、不可变的版本目录，保留 `chordv-server`、`admin/`、`agent-dist/`、`build-info.json`、`DEPLOYMENT.txt`、`SERVER-CONFIG.md`；切换与回滚一起切换整个版本目录，不能只覆盖 server 二进制。

离线信任链：固定 Ed25519 公钥验证 GitHub 发布的 `chordv-server-release.json.sig`（签名覆盖清单原始字节）→ 清单中归档的 SHA256/长度 → 归档中 server 编译内嵌的 Agent manifest SHA256 → manifest 的同版本、同 Commit、amd64/arm64 SHA256 → 每个真实 Go Agent 的包路径、linux/架构、CGO=0、版本与 Commit。发布打包和每次脚本/下载请求均拒绝不匹配产物；运行时不访问 GitHub。未先验证发布清单签名及归档 SHA 的文件不能视为受信发布。`start.sh` 的本地构建也携带对应资产，但它不是签名发布包；无内嵌信任锚的裸 `go run` 仅在安装/下载入口明确返回 503，不从 DataDir 兜底。

## 持久化与恢复

- SQL 保留原表名、列名。Go 使用 `_chordv_migrations` 校验迁移内容；原发布中心历史表不再是版本真相。
- Agent 命令先落 PostgreSQL；事务提交后的 LISTEN/NOTIFY 唤醒 SSE。双连接使用原子领取，断线与进程重启读取耐久队列；30 秒起指数退避至 5 分钟，8 次后显示失败。人工重试仅对未处理 cancelled 的 ENSURE_USER/ENABLE_USER 开放，并从当前 active 绑定重建；停用/移除命令由耐久自动重试及撤销任务机制跟踪，不提供人工重放入口。
- 租约、订阅到期、历史撤销任务、未消费附件到期由事件/定时任务驱动并在启动时恢复；不使用前端业务轮询。
- 租约默认 TTL 1800 秒、心跳 30 秒、宽限 300 秒。创建、续租、活跃计数、最后租约判断与恢复到期任务使用同一配置；有效区间为 `now < expiresAt + grace`，硬截止处即失效。明确撤权不享宽限；并发逐出统一按最近心跳、签发时间、ID 从早到晚选择，用户 override 优先，无有效订阅回落 3。逐出/硬到期写安全审计并在提交后通知，重复到期不重复迁移。
- 运行变更统一先锁完整订阅集合，再锁绑定，最后按节点 ID 预锁绑定、历史租约及授权关系涉及的节点后处理审计/命令；修改节点授权时同时纳入已校验的新输入节点。共享这些节点的变更会等待，无关订阅的独立节点不使用全局串行锁。
- 首次进入节点阶段前，显式事务通过事务内 GUC 冻结已锁订阅 ID 清单及校验摘要；空清单也会冻结，嵌套范围不能覆盖完整清单。之后发现新建/换套餐带来的未知订阅返回 409 并整事务回滚，不在已持节点后补拿订阅锁。清单随提交/回滚自动清除，不使用全局锁、自动重试或重复读快照忽略新连接。
- 生产计时变量为 `CHORDV_SESSION_LEASE_TTL_SECONDS`、`CHORDV_SESSION_HEARTBEAT_INTERVAL_SECONDS`、`CHORDV_SESSION_GRACE_SECONDS`；local 仅读取对应的 `CHORDV_LOCAL_SESSION_` 前缀。只接受整数秒，心跳至少 5 秒、宽限至少 30 秒、TTL 不小于心跳，各项最多 2147483 秒；非法值拒绝启动。配置启动时读取，新连接返回该策略，不提供热更新入口。
- 每小时 17 分清空超过 30 天的已入账计量批次原始载荷、删除超过 90 天的已解决计量异常；批次行、哈希、序列及水位保留，未入账批次和 open 异常不清理。每小时 43 分删除超过 30 天的 Webhook 去重事件。每表每轮最多 40 批、每批 5000 行，跳过锁定行；每批独立提交，取消或失败保留已完成批次，下一固定小时继续，不使用短间隔重试。
- 生产可用 `CHORDV_USAGE_PAYLOAD_RETENTION_DAYS` / `CHORDV_METERING_INCIDENT_RETENTION_DAYS` 调整前两项天数；local 仅读取对应的 `CHORDV_LOCAL_USAGE_PAYLOAD_RETENTION_DAYS` / `CHORDV_LOCAL_METERING_INCIDENT_RETENTION_DAYS`。缺省为 30 / 90，显式配置必须是 1—106751 的整数，非法或溢出拒绝启动；Webhook 固定 30 天，无维护关闭开关。
- 流量重置先持久化门禁并停用绑定，再等待 Agent 最终水位及全部批次入账，最后清零。HTTP 20 秒超时后操作保留，后台由最终回执/计量事件自动继续；重启恢复，不能提前清零。
- 未消费工单附件到期删除远端文件；已引用附件只清理临时凭据。图床更换后无法证明文件归属时保留记录并重试，不跨站点发送旧凭据。

测试边界与未执行项见仓库 `docs/migration/server-parity.md`。

## 显式接管已知 Prisma 基线

`chordv-server --adopt-prisma-baseline` 仅支持完整完成以下已知基线的旧库：从 `20260717000000_init` 至 `20260928150000_achord_connect_support`，共 27 份迁移。它不是任意旧版本自动升级器，也不识别只有 INIT 或缺少履历的旧 db-push 库；没有强制跳过核验开关。

接管命令与 `--migrate`、`--create-admin`、`--version` 分别执行。它不运行服务，不执行业务 DDL，不修改用户、订阅、流量、设置或旧 `_prisma_migrations`：

1. 持有数据库与 schema 作用域的 Go 迁移锁，在事务中锁定 Prisma 履历及业务表，拒绝未回滚失败、缺失、未知、重复成功、checksum 篡改或执行时间逆序。成功履历允许 LF/CRLF 校验兼容；已回滚记录只保留审计，不计为成功；不依赖 `applied_steps_count>0` 推测成功。
2. 对照由 27 份内嵌 SQL 在独立临时 schema 实际重放生成的契约，核验 47 张表、499 个列、33 个枚举、109 个约束、139 个索引。包含类型/类型命名空间、null/default、主键/外键/唯一性、索引有效性；遇到额外未知结构同样拒绝，不自动修复或删除。
3. 全部通过后，原子记录 27 条 `_chordv_migrations`，`applied_at` 保留对应 Prisma 完成时间。已存在的部分 Go 履历、hash 篡改、缺口或未知记录直接拒绝，不重置或覆盖。重复接管原样保留初次时间及全部旧行；中途写入失败整体回滚。

之后另行执行 `chordv-server --migrate`，才运行 Go 新增迁移；本次测试验证只增加第 28 条默认策略迁移，旧业务行与 Prisma 原始履历不变。默认 `--migrate` 对没有完整 Go 履历但已有业务结构的 schema 明确拒绝，不尝试重放 init。

旧服务必须进入维护状态、先有可验证备份，再在显式配置的目标执行；本轮未在任何真实生产库接管。Prisma 协议参考：[MigrationRecord](https://prisma.github.io/prisma-engines/doc/schema_connector/struct.MigrationRecord.html)、[官方 LF/CRLF checksum 兼容实现记录](https://github.com/prisma/prisma-engines/commit/153311247e086e9a80993f1dcf5a6c00230e5b6b)。

契约文件 `internal/database/contracts/legacy-prisma.json` 是自动生成的目录快照，不是第二份 ORM 实现。维护时显式运行 `CHORDV_GENERATE_LEGACY_CONTRACT=1 go test ./internal/database -run TestGenerateLegacyPrismaContract -count=1`，仅对独立本地 schema 重放；普通测试不会写源码，并会重新重放 SQL 验证契约未陈旧。SQL 与 Go 履历 checksum 只规范化 LF/CRLF 行尾，不忽略其他内容变化。
