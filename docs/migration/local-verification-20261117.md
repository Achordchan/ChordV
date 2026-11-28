# 2026-11-17 本地重构验收记录

本记录不代表整个重构已完成。全部运行只使用本机独立数据库和测试节点，未提交、推送、创建 Release、触发 Actions 或操作线上。完整范围仍以 `mygo-rebuild.md` 为准。

## 1. 本轮文件变更

### 默认入口、依赖与旧入口

| 文件 | 改动 |
| --- | --- |
| `package.json` | 增加显式 `test:e2e:agent` 命令，不把需要实际 API 的整链脚本混入普通单测 |
| `scripts/mygo-verify.mjs` | 默认验收纳入 `tests/e2e/*.test.mjs` 调度工具测试 |
| `packages/shared/package.json` | 移除 `./mock` 对外导出，不再提供生产演示数据入口 |
| `packages/shared/tsconfig.json` | 从构建中排除历史 `src/mock.ts`，保留原源码供旧版本对照，不删除已有修改 |
| `pnpm-lock.yaml` | 按当前四个工作区离线重新生成，移除旧 NestJS/Prisma/Node Agent importers 和不再可达依赖 |
| `scripts/local-desktop-dev.mjs` | 旧名称仅委托 MyGo 开发入口，删除 Tauri 及默认线上组件回退 |
| `scripts/local-backend-dev.mjs` | 旧名称仅委托独立本地 Go 服务入口，不再启动 NestJS 或 Node Agent |
| `scripts/release-desktop.sh` | 旧自动 tag/push 入口退役，只提示人工 workflow_dispatch 并退出 1；无 Git/网络操作 |
| `scripts/mygo-legacy-entrypoints.test.mjs` | 增加 4 项真实子进程测试，核对参数委托与退役脚本不启动外部命令 |
| `scripts/local-backend-dev.test.mjs` | 旧测试名委托新测试集，移除旧 concurrently/Nest 测试实现 |

### 组件来源状态与真实链路测试

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/hooks/useRuntimeAssets.ts` | 无配置作为来源前置状态处理；本地齐全保持可用，不伪造远端版本或下载失败 |
| `apps/desktop/src/lib/runtimeAssetsState.ts` | 增加可测试的未配置/缺件/本地齐全状态推导 |
| `apps/desktop/src/lib/runtimeComponents.ts` | 明确 `unconfigured` 状态及中文说明 |
| `apps/desktop/src/lib/downloadProgressPresentation.ts` | 未配置状态不是下载错误，不伪造下载量或进度 |
| `apps/desktop/src/lib/appState.ts` | 连接动作呈现来源未配置事实，避免误导为下载重试 |
| `apps/desktop/src/components/ControlPanel.tsx` | 缺少来源时显示“未配置组件来源 / 组件未安装” |
| `apps/desktop/src/components/RuntimeAssetsBanner.tsx` | 未配置状态不渲染下载面板或空进度条 |
| `apps/desktop/src/components/UpdateCenterModal.tsx` | 来源未配置显示不可用，不提供虚假的重下操作 |
| `apps/desktop/src/App.tsx` | 组件浮层受已登录/主界面就绪约束，且排除未配置状态；退出后无空浮层 |
| `apps/desktop/test/runtime-source-state.regression.ts` | 缺件、部分文件、零长度文件、本地可用和真正下载失败的状态测试 |
| `apps/desktop/test/runtime-source-state.browser.ts` | 真实 hook 浏览器测试：启动/连接检查均无外网请求、下载命令或未配置态进度面板 |
| `apps/desktop/test/fixtures/runtime-source-state.tsx` | 仅浏览器测试加载的隔离夹具，不进入生产入口 |
| `scripts/mygo-agent-e2e.mjs` | 真实 Agent/Reality、精确计量、原样重放、非空最终结算水位、停用与凭据拒绝的完整调度；临时管理员自行创建并清理 |
| `tests/e2e/agent-harness.mjs` | 进程 RPC、SSE 状态等待和只转发真实原始计量请求的透明代理 |
| `tests/e2e/agent-harness.test.mjs` | 5 项调度工具测试，含原请求暂停/放行与资源清理 |
| `tests/e2e/local-postgres.mjs` | 核对本机专用数据库及实际数据目录，按本次 UUID 清理 |
| `tests/e2e/README.md` | 记录可复现命令、个人计量审计口径及实机限制 |
| `apps/agent/internal/e2e/cmd/local-node/` | 仅 e2e 构建包含的真实 Xray/Reality 入站、传输和计数测试；各文件职责见源码及测试说明 |

### 服务端、发布及记录

服务端本轮还修复 ServeMux 旧路由注册冲突、订阅/绑定加锁顺序，并补工单诊断、附件清理、旧撤销任务与显式 production 包。实际文件及业务证据见 `server-parity.md` 和 `apps/server/README.md`。发布脚本逐文件说明见 `github-releases.md`，主要新增 `server-build-info.mjs` 验真、归档/签名前核验与三份工作流全测试入口；没有实际发布。

`docs/prd/backend-self-update.md`、`scripts/release-center-server-checklist.md` 明确标注旧设计退役；`deploy/backend/README.md` 标明旧 Node/Docker 目录只供历史对照。`mygo-rebuild.md`、`ui-qa.md` 与本记录分别维护完整目标、界面证据和本轮验收细目，避免沿用全“待实现”或无依据的全“通过”。

## 2. 已执行验证

- `pnpm install --offline --frozen-lockfile --ignore-scripts`、`pnpm check`、`pnpm test`：初轮80/80条命令通过；工单测试夹具和组件巡检补齐后重新执行`pnpm check`为6/6、`pnpm test`为84/84，包含Go、前端回归、发布协议、Agent/工单调度及三个浏览器专项。随后完成审计又发现节点任务动作的返回契约缺陷，修复后仍须重跑受影响验证，不以此前绿灯覆盖后续修改。
- 重建最新本地 API 后 `pnpm test:e2e:agent` 通过：首段上下行各 262144 字节，重放不重复计费；尾段上下行各 65536 字节，一个非空终结水位结清，最终计费 655360 字节；账号从真实 Xray 删除且旧凭据新连接被拒绝。
- 服务端全量 race、重复 10 次并发/计量/重置测试、原生 race/真实 Xray/独立 watchdog 强杀恢复、发布 actionlint 已由各专项运行，证据和限制见专项记录。
- `node scripts/mygo-build-backend.mjs --platform linux --arch x64` 通过，默认包明确 LOCAL-ONLY；这是交叉构建，不是 Linux 实机运行。
- 961 个非忽略源码文件复制到独立目录，从缓存离线安装前端依赖后完成前端与 MyGo 构建，不依赖原 `node_modules`、`.data`、`output` 或旧忽略内核。最终普通本地应用 17.9 MB，MyGo 打包阶段 2.1 秒；未计全部前端流程，不据此宣称比旧版提升多少倍。
- 真正 MyGo 窗口通过普通鼠标/键盘验证登录、退出、后台禁用自动退出、25→30 GB 实时同步、诊断弹窗及未配置态底部操作无遮挡。DOM 仅只读检查和等待，没有注入账户/React 状态或替代桥接。
- 布局已查看 660×468 登录、820×588 主窗口（均含 28px 标题栏），后台 1440×1000 与 1024×768 客户页。没有新增 CSS；未配置态浮层被删除，而不是把遮挡移到别处。
- 本轮两批 UI 账号/套餐/订阅和 Agent 脚本数据都按 UUID 清理为 0，测试 Agent/Xray 进程均退出。宿主代理配置文件修改时间仍为 2026-10-13 18:50:58。
- `git diff --check`、脚本语法检查通过；无自动提交或推送。

截图及日志位于忽略目录 `.tmp/ui-qa`、`.tmp/migration-tests`、`.tmp/clean-native-build.log`；Agent 报告为 `output/local/agent-e2e-report.json`。测试夹具仅位于测试目录或 e2e 编译标签，不进入生产；历史 Mock 源码保留但不导出、不构建。

## 3. 未执行、仍未证明的项目

- Windows/Linux 实机、宿主系统代理写入及真实授权恢复、正式证书签名公证、DMG/安装器升级、旧 Tauri 过渡包迁移未验证：当前为 macOS，本轮未取得相应运行环境或发布授权。
- 后台团队完整操作、两条5秒公告与原生工单真实链路已实测；后台节点任务、图床、完整设置，原生全部弹窗和真实连接状态的完整视觉对照仍未全验。打开表单或通过API单测不算全部UI通过。
- 未修改的旧可执行源码已逐文件精确清理：后端274条、桌面78条tracked路径；用户已有ignored数据库、内核、依赖和编译输出保留，Git索引未改，两份Prisma schema归档为非运行快照。不能把精确清理冒称删除了所有历史资产。
- 同用户同节点租约沿用共享 VLESS UUID 的兼容模型，不提供恶意客户端单连接的强隔离。另有 Vite 大块资源告警，未为消除告警擅自重构布局或依赖。
- GitHub签名渠道没有客户端直连SSE/WebSocket；已修正并运行真实hook/虚拟时钟验证单飞、12小时常规检查、事件30秒节流、5/10/20/40/60分钟失败退避，以及隐藏/忙/连接暂停和无配置/登出/卸载停止。此低频下载源检查不等同于业务实时轮询，不能宣称整个项目完全没有周期检查。

目标保持进行中；上述未验收项没有被单元测试绿灯或本机截图替代。

## 4. 后续原生工单与本地界面验收

| 文件 | 改动/证据 |
| --- | --- |
| `tests/e2e/support-provider.mjs` | 独立真实HTTP测试站点：Basic认证签票、一次兑换、HttpOnly会话、未读与桥消息；仅当前联系人下一次请求延迟3秒，取消/超时/停服清理定时器 |
| `tests/e2e/support-provider.test.mjs` | 真实HTTP正负测试，包含并发兑换、过期、跨源拒绝、3秒单次延迟、取消与超时，不用注入原生状态代替真实链路 |
| `tests/e2e/support-isolation.mjs` | 单独临时根目录和三个回环端口；真实套餐/订阅、登录/bootstrap/退出门禁，SIGINT/SIGTERM正常清理并退出0 |
| `tests/e2e/support-isolation.test.mjs` | 准备不启动、随机凭据/0600权限/独立目录，以及缺订阅/错误归属/无效到期/HTTP错误拒绝与会话清理测试 |
| `tests/e2e/support-portal.html`、`tests/e2e/support-portal.js` | 中文测试门户，签票片段先清除再兑换；ready、未读、过期、关闭和一次性延迟正常按钮，仅测试入口使用 |
| `tests/e2e/support-README.md` | 准备/启动/GUI正常输入/取消/清理的可复现操作，以及窗口取消与HTTP取消的不同验收口径 |
| `docs/migration/ui-qa.md`、`docs/migration/native-parity.md`、`docs/migration/mygo-rebuild.md` | 同步真实团队/公告/路由/工单证据、旧栈清理事实及仍未验证范围 |

`node --test tests/e2e/support-provider.test.mjs tests/e2e/support-isolation.test.mjs`为15/15通过；根84/84验证亦包含这些测试。两阶段使用同一个真实MyGo二进制、独立Go API和独立PostgreSQL，从客户端原入口正常打开，不直接调用原生命令替代操作。第一阶段未读7→0、窗口复用/关闭重开/会话失效重开通过；第二阶段签票延迟3秒，两次加载窗于710ms/616ms正常关闭，10.9秒/13.6秒后均无复活，再次点击正常打开。

脱敏报告为`.tmp/ui-qa/support-e2e-phase1-report.json`与`support-e2e-phase2-report.json`；第二阶段issued=5/redeemed=3，两个迟到票据没有被兑换，pendingDelays=0。两阶段GUI、API、provider和PG均退出，端口关闭且临时目录删除；凭据没有打印，宿主代理配置修改时间仍为2026-10-13 18:50:58。布局已单独查看900×648工单内容区的门户、加载和过期状态，未改生产CSS；测试按钮响应式无横向溢出。首帧白屏截图不当作布局验收，等待真实加载文案后重新捕获。

此次新增测试站点只在`tests/e2e`，生产代码不导入它；没有把Mock数据/假接口接入应用。已另跑`pnpm build:web`，通过，仍存在Vite大块资源告警。后续队列返回契约和全量验证结果需继续补记。

## 5. 完成审计发现并修复的业务契约

| 文件 | 本轮修改 |
| --- | --- |
| `apps/server/internal/api/commands.go` | 移出后台任务队列职责，保留Agent命令处理，没有保留第二套队列入口 |
| `apps/server/internal/api/command_queue.go` | retry/dismiss统一返回全局`{jobs,summaries}`；已提交但重读失败返回显式JSON null；事务后SSE。过滤已完成/已处理历史、恢复排序和200条上限、摘要取最新错误；人工重试仅当前active绑定的未处理ENSURE/ENABLE，锁后重读防止并发重复下发 |
| `apps/server/internal/api/command_queue_contract_test.go` | 450条历史不能挤占待处理详情、210条其他目标不遮蔽过滤目标，交集过滤、全局摘要、排序及按钮条件 |
| `apps/server/internal/api/command_queue_integration_test.go` | 两项动作响应、当前绑定重建命令、真实管理员/Agent HTTP SSE、刷新失败序列化，动作后旧任务必须消失 |
| `apps/server/internal/api/command_retry_integration_test.go` | 13类拒绝和真实数据库行锁门禁；先红测复现200×2，再要求一个200、一个404且只生成一个替代命令 |
| `apps/server/internal/api/queue_schema_test.go` | 新增队列专用私有schema wrapper，复用工单隔离建库并保留`server.Start()`真实worker；不修改生产数据库URL参数白名单 |
| `apps/server/internal/api/ticket_writes.go` | 合并multipart与两步上传区分；有效文字在图床失败时仍真实保存，非法图片/无内容/非属主/已关闭仍失败 |
| `apps/server/internal/api/ticket_multipart.go` | 恢复`attachmentUploadStatus`/`attachmentUploadError`旧DTO，不新增不兼容的`reply`或`partialFailure`字段，不伪造文字已保存 |
| `apps/server/internal/api/imagebed.go` | 分离文件验证与图床请求，使部分成功不吞掉非法文件校验失败 |
| `apps/server/internal/api/ticket_multipart_test.go` | 真本机HTTP图床、部分成功/纯图片/纯文字/两步/超时/非法响应/缺凭据/并发关闭等验收；非属主404与真正属主502分别验证 |
| `apps/server/internal/api/ticket_schema_test.go` | 为工单及队列用例创建随机schema、单独连接池和临时目录；清理只删除本次schema |
| `apps/server/internal/api/image_integration_test.go` | 原附件上传/一次性消费/过期与持久化失败清理改用私有schema，不再暂存并修改public图床配置 |
| `apps/server/README.md`、`docs/migration/server-parity.md` | 修正人工重试范围，记录先红后绿、真实SSE/并发证据及未进行的UI验收 |

主流程已逐项复核旧Nest契约、前端实际调用及新测试，不直接采用代理初版结论：初版错误保留已处理任务的断言已撤销，恢复旧任务消失；发现初版并发重试仍可能重复下发后，以确定性门禁红测复现并修复。工单初轮两步上传测试错误使用admin身份访问客户端点，真实404是正确权限行为，已修正夹具为先断言非属主404、再用客户令牌验证图床502，未修改生产权限规则来凑绿灯。

两个专项停止写入后，主流程`pnpm check`6/6、`pnpm test`84/84通过，完整服务端`go test -race -count=1 ./...`通过，API125.463秒、config1.448秒、database7.080秒；其中队列用例此轮仍沿用旧public测试helper，不能冒称私有schema证据。随后仅测试夹具改成`newQueueSchemaAPI`，8处调用均替换，保留真实worker；该调整后的最终全量race/vet及public指纹与临时schema清理结果另行记录。既有其他12个测试文件仍使用public的历史测试模型，不在本次队列隔离改动中擅自重构。

`pnpm build:web`、`pnpm build:server`与普通非e2e的`node scripts/mygo-desktop.mjs --build-only --skip-dmg`均通过；MyGo阶段3.5秒、普通本地app17.9MB，默认依赖不含自动化插件。服务端包存在`LOCAL-ONLY.txt`；没有发布、部署或真实证书签名公证。生产前端未改CSS或布局，工单门户及加载布局已单独实测；后台任务正常按钮与图文回复的完整UI路径仍待验证，不能以HTTP回归代替。

### 最终复验与隔离边界

- 队列夹具调整后服务端全量`go test -race -count=1 ./...`及`go vet ./...`均通过，API123.436秒、config2.458秒、database7.197秒，日志`server-race-after-queue-isolation.log`。外围“整套测试前后public指纹完全相同”的额外检查**未通过**：迁移指纹相同、私有schema均为0，但图床/工单接入设置整行指纹变化。既有public测试仍用saveSetting写回设置（含更新时间），不能把测试用例全绿解释为public完全未写入；结果保留在`queue-isolation-result.json`，调度命令因该额外检查退出1，不隐去它。
- 对新增8项队列用例单独再次执行真实`-race`，包括13个拒绝子场景，42.397秒通过；严格同一SQL比较前后public迁移与两项接入设置整行指纹完全一致，私有schema0→0，调度命令退出0，证据`queue-isolated-contract-final.log`、`queue-isolated-contract-result.json`。这证明本次新增队列用例已隔离，不证明其他既有public测试已迁移。
- 本地原API和Vite由持有的supervisor94314正常SIGINT退出（未停止原PG12027），确认3100/5174监听消失后经唯一入口重建并启动。新API只监听127.0.0.1:3100，health返回local/ok；后台5174正常重载并读取仪表台。当前运行的是包含队列/工单修复的新二进制，不用旧进程的可访问性替代新源码启动证据。日志`.tmp/ui-qa/local-stack.log`。
- 最终`git diff --check`通过，生产前端无console.log/debugger/TODO mock残留，新测试站点和测试数据未进入生产入口。未进行提交、推送或发布；主机代理文件时间不变。

下一阶段仍需完成后台失败任务按钮、图文回复/图床配置完整UI、剩余视觉状态及既有public测试的进一步隔离；Windows、宿主代理授权恢复、正式签名公证和旧版安装升级维持未验证。

## 6. API测试统一隔离整改

上节“历史public测试仍会写回设置”的缺口已整改并重新取得证据，不沿用此前不通过的外围检查冒称成功。

- 新增`apps/server/internal/api/isolated_schema_test.go`作为唯一`newTestAPI`入口；从已校验本机连接复制10连接/UTC配置，仅该测试池设置随机`api_test_*`与`pg_catalog`搜索路径，不允许public回退。保留两次Migrate并逐字校验履历幂等、真实`server.Start()`、HTTP管理员登录与临时目录清理；新增跨schema设置/令牌隔离回归。
- `integration_test.go`移除原public构造器和重复结构体；三份队列测试、工单multipart及图片集成测试全部统一到此入口；删除已无调用的`queue_schema_test.go`、`ticket_schema_test.go`两套重复夹具。没有修改生产数据库URL参数白名单或67个生产Go源码文件。
- 完整`go -C apps/server test -race ./... -count=1`通过：API128.166秒、config1.937秒、database7.456秒，`go -C apps/server vet ./...`通过。public User2、Node1、Plan1、Subscription1、SystemSetting2、迁移28条完整行SHA-256前后逐表一致，聚合摘要均为`dad936e37d5407809e80865b7f00339429ecff327c30060e0e709fcbda848016`，临时schema0→0。未因私有schema暴露旧测试假设而放宽业务断言。

脱敏原始证据位于`output/local/api-schema-isolation-before.json`、`api-schema-isolation-after.json`、`api-schema-isolation-validation.json`、`api-schema-isolation-report.json`；主流程已读取核对。上述是API测试隔离与当前代码验证，不替代后台正常控件、生产迁移或跨平台验收。

## 7. 后台真实控件收敛与追加契约修复

### 文件改动

| 文件 | 修改 |
| --- | --- |
| `tests/e2e/image-provider.mjs` | 独立回环HTTP图床，真实multipart/PNG读取、鉴权、搜索/删除、503与有界延迟，停止释放文件与定时器；兼容Go默认octet-stream文件part |
| `tests/e2e/image-provider.test.mjs` | 真实HTTP15项：PNG原字节、鉴权、分页/搜索、删除、模式、取消/超时/半上传停止、容量与路径拒绝；不以它替代UI通过 |
| `tests/e2e/image-README.md` | 接口、凭据与测试边界说明 |
| `tests/e2e/admin-ui-isolation.mjs` | 组合原support隔离入口与本机图床，prepare/start分离，独立Vite来源、真实账号/订阅/工单及cancelled审计夹具，保留部分启动失败原因和报告 |
| `tests/e2e/admin-ui-node-fixture.mjs` | 两个节点由真实生产Agent/Xray初始化；授权产生真实绑定，初始化后停止Agent，新重试保留真实pending，不合成回执 |
| `tests/e2e/admin-ui-isolation.test.mjs`、`admin-ui-README.md` | 计划/端口/篡改拒绝与完整操作、清理、夹具范围说明 |
| `tests/e2e/support-isolation.mjs` | 增加仅测试admin来源、可不启support-provider及单独报告名选项，避免后台wrapper覆盖原生工单报告 |
| `tests/e2e/local-postgres.mjs` | 指定测试根目录并核对实际PG data_directory；真实psql使用-q消除DML命令标签，不截断JSON兜底 |
| `tests/e2e/local-postgres.test.mjs` | 显式开关下启动全新PG，真实SELECT/INSERT/UPDATE RETURNING和错误行为验收；已单独运行通过，不把默认跳过算成功 |
| `apps/server/internal/api/imagebed.go` | 图床管理删除稳定返回四字段，列表业务失败正确报错，不把provider原文直接当DTO |
| `apps/server/internal/api/imagebed_contract.go` | 删除数组/错误脱敏、文件ID别名、大小字符串/null、时间及计数归一化 |
| `apps/server/internal/api/imagebed_contract_test.go` | 真HTTP/私有schema先红后绿，9类删除、部分失败/脱敏、列表字段、Unicode路径和查询转发；与旧图文/图片专项12组race通过 |
| `apps/server/internal/api/settings.go`、`network_policy.go` | 统一读取数据库站点主地址；仅无配置才用启动默认，读错/非法存量不悄悄回退 |
| `apps/server/internal/api/support.go`、`agent_distribution.go` | Webhook与Agent安装ORIGIN使用已保存主地址，不信任请求Host/X-Forwarded |
| `apps/server/internal/api/site_address_test.go`、`network_policy_test.go` | 真实保存/重读/下游/新Server恢复、读取失败、local回环和production HTTPS边界 |
| `apps/server/internal/api/file_cleanup.go` | 统一初始/人工/后台清理、持有任务行锁、失败次数/错误/UTC退避持久化；严格托管路径、OsRoot、非symlink和24h保护 |
| `apps/server/internal/api/scheduler.go`、`storage.go` | 启动恢复持久化nextAttemptAt并用已有定时器调度；移出重复清理逻辑，无新增轮询 |
| `apps/server/internal/api/file_cleanup_test.go`、`file_cleanup_observer_test.go` | 真实新文件/ctime/符号链接/越界保护、缺失文件与父目录幂等、失败持久化、启动恢复和同任务并发门禁 |
| `apps/server/internal/api/records.go` | insert/updateKey的两个CTE投影明确`to_jsonb(result.*)`，消除与同名JSON result列的行/列歧义；update继续共用updateKey |
| `apps/server/internal/api/records_projection_test.go`、`retry_null_result_test.go` | SQL NULL、对象、数组、数值、字符串、布尔×三方法18场景；真实HTTP NULL任务重试由500红→200绿，不改fixture填{}掩盖 |
| `apps/admin/src/features/nodes/SyncTasksModal.tsx` | 过滤视图仅以真实详情判空；全局摘要不是当前范围总数，未知时不声称“还有其他任务”；保留未过滤分页提示和加载/失败状态 |
| `apps/admin/test/sync-tasks-modal.browser.ts`、`test/fixtures/sync-tasks-modal.tsx` | 真实组件浏览器先红后绿，8项涵盖过滤空/非空/200条、全局上限、加载/错误、保留旧结果与查看全部；夹具不进入生产 |
| `docs/migration/ui-qa.md`、`server-parity.md`、`mygo-rebuild.md`及本记录 | 更新真实控件、失败→根因→重建复验、清理与未验证范围，不把API单测替代GUI |

### 已执行与证据

两期后台UI的正常操作、截图、明确SQL夹具边界和自有资源退出见`ui-qa.md`。一期普通按钮真实触发的500保留为失败：NodeCommandJob.result是SQL NULL，旧`to_jsonb(result)`误取同名列，事务回滚；不是网络超时，也不是靠给fixture补{}修好。二期固定新二进制正常ENSURE/ENABLE重试均200，旧记录消失、只各生成一条pending，B标记后空态与查看全部均正确，页面错误0。

一期已完成真实图文成功/PNG预览、503文字只保存一次、纯图片失败保留附件草稿、1500ms延迟双击去重、文件搜索/确认删除及URL404、工单关闭重开、站点保存后Webhook随动、启用新工单旧工单只读、密钥重开不回显/清除自动停用、正常退出。二期还正常操作文件SSE扫描。没有实测删除一份真正满24小时的现存文件；真实文件保护/缺失幂等与恢复并发测试不等同于该破坏性实测。没有因为测试观察工具超时而重启业务服务或数据库。

追加全部生产修复后，主流程最终`pnpm check`6/6、`pnpm test`85/85通过；完整服务端`go test -race -count=1 ./...`通过：API151.560秒、config1.887秒、database7.769秒。`pnpm build:server`及桌面前端build通过，仍保留Vite大块资源告警。此前普通MyGo原生17.9MB构建的桌面源码未因本轮后台修复改变，不伪称做了正式签名或旧版安装升级。

两期独立PG/API/provider/Xray/Vite、额外本机支持provider和测试浏览器均正常停止，端口关闭、临时目录及凭据删除；脱敏报告保存为`.tmp/ui-qa/admin-ui-phase1-report.json`、`admin-ui-phase2-report.json`和`admin-queue-phase2-ui.json`。主PG12027未停止；主本地API/Vite在专项全部结束后由唯一入口正常重建重启，当前supervisor25814/API25861，3100 health为local/ok、5174为HTTP200，未启动production或操作线上。

生产前端只改任务弹窗条件，没有改CSS；实际1024×768/1440×1000检查了弹窗、密集会话、预览、图床列表及滚动可达性。旧清理执行与重复测试夹具入口已移除，源码扫描无console.log/debugger/TODO mock；所有provider/UI fixture仅测试目录使用，不进入生产。最终`git diff --check`通过，无提交、推送、发布；宿主代理配置时间仍为2026-10-13 18:50:58。

目标仍进行中：完整客户端各设置/真实连接视觉、尚未逐项操作的后台高级入口，Windows/Linux实机、宿主代理授权恢复、正式签名公证与旧版覆盖升级仍不能用本轮局部证明替代。

## 8. 设置专项、发布兼容与批次清理补验

以下为本阶段停写后的独立复核，不覆盖上节失败记录，也不代表整体目标完成。

### 逐文件改动

后端与原生传输：

| 文件 | 本阶段修改 |
| --- | --- |
| `apps/server/internal/api/github.go` | 公钥解析补齐SPKI DER Base64，保留raw32/PEM及Ed25519算法限制，不放宽清单原字节验签 |
| `apps/server/internal/api/github_transport_test.go` | 临时密钥与真实回环HTTP经生产路由覆盖三种公钥、旧只读更新/版本/历史/组件投影、篡改拒绝和Tauri204；无外网/DB |
| `apps/server/internal/api/file_cleanup.go` | 完整批次ID/可清理状态/托管路径均验证完成后才处理，避免后项非法时首项已被修改；未改变实时24h/ctime/OsRoot保护 |
| `apps/server/internal/api/file_cleanup_batch_test.go` | 四种非法批次先红后绿，比较任务完整行和真实文件；合法批次仍逐项实际执行并记录新文件保护失败 |
| `apps/desktop/native/download.go` | 实际低速错误增加前端已使用的稳定标记，保留中文说明，使最终去低速门槛重试可达 |
| `apps/desktop/native/download_test.go` | 真实12.1秒慢HTTP错误、两个独立源65536字节断流续传、污染前缀Hash拒绝且保留旧文件、清理part后显式恢复 |

桌面状态与回归：

| 文件 | 本阶段修改 |
| --- | --- |
| `apps/desktop/test/download-mirror-ranking.regression.ts` | 对齐实际原生标记与前端候选顺序/最后源无门槛/低速源最终重试，不再只手造与原生不同的英文错误 |
| `apps/desktop/src/components/ReleaseHistory.tsx` | 未配置与网络失败分开呈现；初次读取、重试、切通道、卸载统一effect清理，旧重试迟到不能覆盖新通道 |
| `apps/desktop/test/release-history-source.browser.ts`、`test/fixtures/release-history-source.tsx` | 实际组件验证未配置0请求/0重试、配置后503→正常重试、延迟旧stable重试不覆盖beta；夹具仅测试入口 |
| `apps/desktop/src/hooks/useAuthBootstrap.ts` | `clearSession`及正常logout在首个异步操作前幂等清空内存密码，保留邮箱语义；去除“记住邮箱则保留密码”的旧条件与依赖 |
| `apps/desktop/test/remember-email.regression.ts` | 执行实际hook，覆盖记住邮箱true/false、正常退出/撤权及stop/store失败，不吞异常、不伪造退出完成 |

隔离测试与记录：

| 文件 | 本阶段修改 |
| --- | --- |
| `tests/e2e/admin-ui-isolation.mjs`、`admin-ui-isolation.test.mjs` | 任务来源使用稳定明确IDs/dedupe，不再用易变化错误文案；4项回归与两份报告来源标签精确纠正 |
| `docs/migration/ui-qa.md`、`github-releases.md`、`server-parity.md`、本记录 | 正常控件/截图、真实失败与修复、逐文件改动和未验事项；不把组件夹具替代原生GUI、真实发布或生产部署 |

### 已执行的统一验证

- `pnpm check`：6/6；`pnpm test`：87/87。前一轮86/86后又发现真实退出密码残留和重试迟到覆盖，修复停写后重新全量跑到87/87，不沿用前轮结果。日志`.tmp/ui-qa/final-settings-check.log`、`final-settings-test.log`。
- 显式读取已验证本机环境后执行`go -C apps/server test -race -count=1 ./...`：API160.852秒、config1.873秒、database7.060秒通过。`CGO_ENABLED=1 go -C apps/desktop/native test -race -count=1 ./...`：14.064秒通过。可选真实Xray测试仍需另行显式资产环境，不能把默认跳过当物理链通过。
- `node --test tests/e2e/admin-ui-isolation.test.mjs`：4/4；实际remember-email回归单独复核通过；`git diff --check`通过。87/87统一轮次前后，public User2/Node1/Plan1/Subscription1/SystemSetting2/迁移28条完整行SHA256逐表不变、临时schema0→0；证据`.tmp/ui-qa/public-settings-before.json`、`public-settings-after.json`、`public-settings-invariant-report.json`。脱敏脚本仅保留行数与Hash，不输出/保存数据库原行。
- `pnpm build:server`通过；`pnpm build:desktop`实际构建普通本地MyGo应用及DMG：应用17.9MB，DMG6.5MB（6,818,816字节），MyGo阶段19.9秒其中DMG约16.2秒。不将此含DMG数字与此前不含DMG的2.1秒直接比较，不承诺比旧Tauri快多少。
- `codesign --verify --deep --strict`通过，实际签名为`adhoc`、TeamIdentifier未设置；`hdiutil verify`校验DMG通过。不是Developer ID签名、公证或旧版覆盖升级。Vite大块告警仍在，未提高阈值隐藏。

### 真实UI、环境与未验边界

后台账号安全、策略持久化、其他会话撤销、真实SSE断流/心跳检测重连与草稿保护，及客户端帮助/记住邮箱/关闭提示/模式/更新选项/日志/本地文件/原生窗口行为均按正常控件执行，详见`ui-qa.md`与`.tmp/ui-qa/admin-settings-ui-report.json`、`client-settings-gui-report.json`。两套自建数据库、API、Vite/转发器、GUI/浏览器及凭据均已清理；宿主代理未写入，配置mtime保持2026-10-13 18:50:58。后台成功通知短暂遮挡弹窗按钮的观察仍保留，不宣称所有叠层状态已通过。

主supervisor25814经SIGINT正常退出，确认3100/5174监听关闭后由唯一`node scripts/mygo-local.mjs`重新编译启动；当前supervisor36715/API36763/Vite36795，3100为local/ok、5174为HTTP200，原PG12027未停止，生产App359未操作。主运行会话80881，日志`.tmp/ui-qa/local-stack.log`；不以旧进程可访问性替代新源码启动。

真实现存文件满24h删除仍未即时实测：新增独立`.tmp/cleanup-age-proof/970f9da5-c4ae-43a1-8917-72bdba7faa25/managed/tmp/natural-age.part`与0600记录，只让真实ctime自然老化；主流程已复核ctimeNs原样。最早2026-11-18 03:58:13上海时间后再验，不改宿主时钟、不伪造ctime、不借用用户资产，也未创建自动化。真实连接/额度耗尽视觉、宿主代理授权恢复、Windows/Linux实机、正式平台签名/公证与旧安装升级仍未验；GitHub发布与线上部署遵守仅本地边界未执行。没有提交、推送或发布。

## 9. 邮件入口追加修复与最后统一复验

### 文件与根因

| 文件 | 修改 |
| --- | --- |
| `apps/desktop/native/installer.go` | 原先真实Invoke拒绝帮助按钮的mailto；现只允许HTTP/HTTPS和严格校验的单收件人mailto，限定subject/body、正文LF、16KiB上限；拒绝头注入/控制字符/其他协议/多收件人/附件与未知或重复参数。唯一生产OS实现不变，包私有执行器仅供串行测试拦截，无配置旁路 |
| `apps/desktop/native/external_url_test.go` | 真实Invoke→URL校验→系统执行参数，串行临时替换执行器后Cleanup恢复；正常模板、拒绝表和执行器失败3项先红后绿。不运行系统邮件应用 |
| `apps/desktop/src/components/LoginScreen.tsx` | 捕获原生拒绝或ok:false，中文失败提示保留邮箱；加载防重复、关闭重开清错、旧epoch迟到结果隔离，不伪造已发送 |
| `apps/desktop/test/login-help-email.browser.ts` | 实际组件reject/false/success、延迟busy双击、关闭重开迟到失败；660×468和660×440均检查，等待弹窗及祖先opacity=1与动画完成后截图 |
| `apps/desktop/test/fixtures/login-help-email.tsx` | 仅测试页面替换原生传输并使用测试账号；生产入口不加载，不把组件替身说成真实邮件应用成功 |

### 最后验证与布局

- 停写后重新`pnpm check`6/6、`pnpm test`88/88；日志`.tmp/ui-qa/final-help-check.log`、`final-help-test.log`。第8节87/87及其日志仍保留为前一阶段，不覆盖原结果。
- 主流程`CGO_ENABLED=1 go -C apps/desktop/native test -race -count=1 ./...`全量13.854秒通过，日志`final-help-native-race.log`；服务端本阶段源码未再变，沿用本轮实际完整race API160.852秒的证据，不虚称邮件后又重跑一次服务端race。邮件专项3项race、原生vet及桌面类型检查另通过。
- 最后`pnpm build:desktop`重新构建普通本地应用17.9MB、DMG6.5MB（6,851,584字节），MyGo阶段18.8秒含DMG约15.7秒，日志`final-help-desktop-build.log`。`codesign --verify --deep --strict`与`hdiutil verify`再次通过；实际仍是adhoc、无TeamIdentifier，不是正式签名/公证。
- 主流程独立查看稳定白底`login-help-email-reject.png`，错误文案、联系地址、关闭和发送按钮均完整；代理逐张查看reject/false及两种高度共4张截图。未改CSS、全局样式或生产依赖，未以透明过渡图或仅数值矩形作为视觉通过依据。

实际邮件客户端启动/默认应用行为未验，因为本轮没有打开外部邮件应用或发送邮件；本地测试证明到OS执行器边界，不证明邮件已发送。页面/凭据清理、更新日志旧通道清理都只有一套状态逻辑；旧错误分支与保留密码条件已移除，Mock和传输替身只存在于测试入口。所有自建测试Vite/Chrome正常关闭，未重启已清理专项GUI/数据库，主本地API36763/Vite36795与原PG12027继续服务，生产App359未动。

## 10. 额度与通知布局追加收敛

### 文件改动

后台反馈：

| 文件 | 修改 |
| --- | --- |
| `apps/admin/src/features/feedback/AdminNotifications.tsx` | 复用唯一Mantine通知store，以固定DOM宿主在页面/最上层Modal或Drawer间移动，避免动态更换Portal target丢失通知/重置计时器；MutationObserver仅跟踪第三方容器，不做业务轮询 |
| `apps/admin/src/main.tsx` | 用唯一AdminNotifications替换原固定位置入口，不并行保留旧通知组件 |
| `apps/admin/src/features/feedback/Notifications.module.css` | 活动弹窗内反馈独立占位/限高滚动，表单单独滚动；页面通知也限高可滚，长文本不被旧200px动画上限裁掉；只用模块作用域，不改body/reset |
| `apps/admin/src/features/system-settings/PolicySettings.module.css` | 仅给AI分段选择器isolation，约束其内部z-index=2不覆盖sticky保存底栏，不抬全局层级 |
| `apps/admin/test/admin-notifications.browser.ts`、`test/fixtures/admin-notifications.tsx` | 实际策略/安全组件与Modal/Drawer：连续保存、选择模式、390/1024/1440宽度、长错误末尾、队列、嵌套/关闭重开、原节点身份/计时器保留；夹具仅测试 |

后台异步与客户端额度：

| 文件 | 修改 |
| --- | --- |
| `apps/admin/src/App.tsx` | 策略SSE刷新传silent，不卸载已有表单；响应落地前再次检查dirty/saving，防止在途读取覆盖后来编辑；首次骨架和失败门禁不取消 |
| `apps/admin/test/settings-policy-request.regression.ts` | 追加后台读取不置loading、在途读取后开始编辑/保存则拒绝覆盖，两项红测先捕获true/false和late/cached差异，再全部通过 |
| `apps/desktop/src/hooks/useAuthBootstrap.ts` | 空节点提醒仅适用于active订阅，不再把耗尽/暂停/过期的正常空节点响应误报为分配故障 |
| `apps/desktop/test/subscription-availability.regression.ts` | 实际bootstrap hook的4种状态×有/无节点8组合；仅active真无节点提醒 |
| `apps/desktop/test/quota-control.browser.ts`、`test/fixtures/quota-control.tsx` | 实际ControlPanel单变量额度门禁，可用→耗尽禁用→恢复可用；仅测试props/回调，不建立物理连接 |
| `docs/migration/ui-qa.md`、`mygo-rebuild.md`、本记录 | 更新真实额度/UI、通知修复、失败证据、布局及剩余边界，保留先前观察与失败历史 |

### 真实操作与验证

- 新隔离额度GUI42594经真实管理API人工调整1GB用量，SSE耗尽/耗尽重登/恢复均过；真实connect409且租约/计费记录均0，不宣称实际Agent计费。耗尽原生基线和恢复都还因组件未配置禁用，因此额度独立门禁另由实际组件单变量验证。完整证据`.tmp/ui-qa/client-quota-gui-report.json`与对应observations/db-proof/cleaned报告，主流程独立查看耗尽修复截图。
- 通知组件先红：成功提示覆盖正常保存。第一版移入反馈区又实际发现分段控件穿出层级与动态Portal target关闭后丢失，均修根因后补闭环回归；最终使用同一宿主DOM节点移动，onOpen保持1次、自动关闭正常、5条队列逐个正常关闭，不用点击穿透或强制点击绕过遮挡。1440×1000、1024×768、390×640的安全表单与策略、抽屉、长错误、嵌套均验，主流程查看稳定截图。
- 一期独立49402/49404后台连续正常保存200，通知已不挡操作，但另观察到SSE切骨架重置滚动，报告`admin-feedback-ui-phase1-report.json`保留scroll0及清理状态。修复后用全新51919/51921二期正常连续保存，并由另一个真实会话修改触发SSE：表单DOM不变、滚动143→143、异常0。只延迟真实GET发出后正常修改草稿，迟到200不覆盖；关闭重开显示服务器直连而非未保存规则草稿，没伪造API响应。报告`admin-feedback-ui-report.json`及截图`admin-feedback-policy-sse-scroll-preserved.png`为最终依据。
- 停写后`pnpm check`6/6、`pnpm test`91/91通过，日志`.tmp/ui-qa/final-quota-feedback-check.log`、`final-quota-feedback-test.log`；`pnpm build:server`和`pnpm build:desktop`通过。本轮未改Go生产源码，没有重复声称重跑全量race；普通Go测试/vet包含在统一命令中，实际旧race证据保留于前节。生产修改扫描无console.log/debugger/TODO mock，未加生产依赖。
- 最后普通本地应用17.9MB、DMG6.5MB（6,853,632字节），本轮同机缓存MyGo含DMG阶段8.7秒；不与未含DMG或旧Tauri异条件比较。`codesign --verify --deep --strict`及`hdiutil verify`通过，实际adhoc/无TeamIdentifier，仍不是发行签名或公证。Vite大块告警未隐藏。
- 91项统一命令前后public User2/Node1/Plan1/Subscription1/SystemSetting2/迁移28条完整行SHA256逐表一致，临时schema0→0，证据`public-quota-feedback-before.json`、`public-quota-feedback-after.json`。两期自建PG/API/Vite、调试Vite、Chrome及额度GUI/观察器均退出，临时目录/凭据已删；原主36715/36763/36795/PG12027与生产App359不动，宿主代理mtime仍为2026-10-13 18:50:58。自然老化样本保留，未安排自动化。

仍未执行物理节点连接视觉/宿主代理授权恢复、自然满24h现存文件删除、Windows/Linux实机、真实默认邮件应用、正式发行签名/公证和旧版安装升级：分别缺明确代理写入授权、尚未满24h、平台设备与发行条件；遵守仅本地边界，不发布或部署。没有提交、推送或影响线上。

## 11. 组件完整性、启动竞态与真实连接 GUI

### 本轮生产代码

- `apps/desktop/native/components.go`：`exists`只代表物理文件存在，新增`verified`表示实际SHA256及大小与安装记录匹配；kind必须一致、installedSize必须为正。原生连接入口也执行这一基础契约，不能绕过前端门禁。`components_test.go`覆盖缺失、损坏、错kind/零大小及真实Invoke在写配置/启动内核之前拒绝；不把本地记录校验叫作发行签名。
- 桌面`geoUpdate.ts`、`runtimeAssetsState.ts`、`supportContextSources.ts`、`useRuntimeAssets.ts`统一消费显式verified；删除仅凭UI缓存ready与近期GEO检查直接放行连接的分支。无下载来源的坏文件显示校验/安装记录错误，不制造下载进度。
- `apps/desktop/native/runtime.go`：端口就绪和takeProxy之后再次检查ctx、真实内核退出信号和恢复进程退出信号，中断时停止自有内核、恢复代理记录，不返回连接成功。`runtime_startup_test.go`先红后绿；真实Xray两轮专项9.246秒，完整原生race18.243秒，e2e专项race3.864秒。
- `apps/server/internal/api/github_compat.go`：实际beta清单的旧兼容响应归一化minimumVersion=0.0.0，不再误报最低版本阻断；stable强更/最低版本语义保持。`github_compat_beta_test.go`真实HTTP+随机私有schema先红后绿，相关8顶层及9子场景race10.129秒；public设置/迁移指纹不变，测试schema0→0。

### 独立环境及证据边界

新增`tests/e2e/runtime-ui-{isolation,assets,nodes}.mjs`、对应计划边界测试与README；prepare与显式start分开，拒绝旧root/旧PG/桌面会话、固定代理口占用及重定向。首次start因旧Go自动切换工具链遇GOSUMDB=off而失败，正规stop清理root；随后直接执行本机已存在并实测版本的Go1.26.2二进制，GOTOOLCHAIN=local、GOPROXY/GOSUMDB=off，离线小构建与缺工具链拒绝测试通过。修正后runtime9/9、相关默认组合24/24，均0 skip。

新临时root `chordv-support-e2e-5jrtw8`：API60633、PG60634、supervisor55258/API55293/PG55272；真实双Xray/Reality节点55318/55324与生产Agent55320/55325保持运行。节点创建、Agent注册、用户A/B授权均走真实API，ENSURE_USER completed后只读SQL和真实Xray账号交叉核对；没有SQL造绑定或伪回执。ignored原Xray/GEO只读复制到独立desktop/bin，记录真实SHA/size，标签明确为“手动预置真实资产fixture”；不是GitHub下载安装证明。

`proxy_e2e_darwin.go`及测试仅`e2e && darwin`编译；以canonical系统临时root、0600当前用户独占非链接JSON为代理存储，flock+全值CAS原位修改，非法显式profile启动即终止，后续失败也不回退宿主代理。恢复watchdog仅同进程pipe drain stand-in，不证明独立watchdog或父进程崩溃恢复。主流程核对独立QA二进制确有profile与automation符号、普通包均排除，普通包SHA保持不变。

### 第一轮真实 GUI

GUI55358使用独立bundle `app.chordv.runtime.qa`、真MyGo页面、真桥接与真内核；socket只做DOM只读和截图，鼠标/键盘由校验bundle和frontmost PID的系统CGEvent发出，输入凭据后逐类型恢复原剪贴板。未注入React、伪桥或ready状态。

1. 正常登录→选全局→连接节点B，真实Xray55599监听17890/17891，页面显示B已连接。HTTP CONNECT经GUI启动的Xray、global-all-proxy规则、真实本机Reality节点到本机echo，65536字节逐字一致；再正常断开，测试代理JSON精确恢复初值。
2. 选择节点A并正常启动，页面显示A已连接；同一路径再次65536字节往返一致，SHA256均为`944044fe482bc4e91085c15c5a923a1b9e02eac98d3bce04997d6dbecd2a5b8d`。选择不同节点本身不会重接当前连接，本轮是明确断开后连接新选择，不宣称托盘即时切换已验。
3. 核对Xray55808的父PID和独立desktop路径后只对它SIGKILL：页面真实显示异常与“运行内核意外退出，连接已断开”，测试代理恢复初值，诊断弹窗可读真实两次启动与`http-in -> proxy`日志。发现界面仍残留“内核已启动”及旧端口，留作下一轮修复，不能把第一轮故障视觉全部判绿。

主界面820×588，无水平/整体垂直溢出，节点列表、控制按钮和诊断入口均在可见区域；诊断600×460，日志独立滚动、关闭与复制按钮可达。主流程已查看连接B/A及诊断截图。首轮最后正常断开释放状态并CmdQ退出GUI55358，暂保留独立节点等待修复复验；原主本地环境及生产App359未动，宿主代理文件mtime/size始终1791888658/21576。

原始证据：`.tmp/ui-qa/runtime-gui-phase1-proof.json`、`runtime-gui-{login,idle,connected-first,connected-A,disconnected,core-exit,diagnostics}.png`、`runtime-first-start-cleaned.json`、`runtime-gui-build/binary-profile-proof.json`。本节第一轮不是最终修复后的GUI结果，后续验证与最终清理另记。

### 最终修复、复验与清理

`ControlPanel.tsx`原先把残留xrayBinaryPath当作内核已启动，且用旧runtime配置展示端口。现运行标签同时依赖状态与正activePid（Android保留真实vpnActive信号），error无进程显示“内核已停止”；verified组件ready/completed时显示“内核已安装”；端口仅connected且有存活信号时显示。保留异常清理按钮、lease和原生进程语义，不改CSS。新增`runtime-control-status.browser.ts`/`fixtures/runtime-control-status.tsx`，真实组件10场景×2视口共20次观察，覆盖Android及残留PID/路径/配置反例；先红后绿，相关三浏览器3/3通过。主流程另看390px截图确认状态、错误、footer和操作均可见；这是组件级移动布局，不是Android实机验收。

修复版独立二进制SHA256=`9cefac6c2ee90853ab4b84992faa8e083d132f691f93f37041a345efa7c15eb5`，GUI60268：启动空闲显示已安装；正常点击出现“连接中/正在连接…”且端口--，随后节点A已连接、显示真实端口。再次65536字节经真实内核/Reality往返一致。核对父PID和独立路径后终止自有Xray60303，真实UI显示异常、已停止、HTTP/SOCKS --，测试JSON精确恢复。正常点击断开后空闲/已安装，CmdQ退出。主流程查看`runtime-gui-fixed-core-exit.png`确认修复后820×588完整，无整体溢出。

先退出GUI和自建echo，再对本次helper正常SIGINT，全部自有API/PG/Agent/节点退出，60633/60634/17890/17891无监听，测试root及socket消失。helper报告`testProxyJSONRestored:true`、`cleaned:true`、`rootRetained:false`；清除独立bundle的两个缓存位置及已过时launcher，保留审计截图和构建物。主本地进程36715/36763/36795/12027、生产App359不变，宿主代理文件mtime/size仍1791888658/21576。

最终验证（所有代理源码停写后）：

- `pnpm check` **6/6**、`pnpm test` **92/92**。之前91/91是新增故障展示回归之前的结果，本轮最终不沿用它。
- `CHORDV_TEST_XRAY_DIR=... CGO_ENABLED=1 go -C apps/desktop/native test -race -count=1 ./...` **18.243秒**；`CGO_ENABLED=1 go -C apps/desktop/native test -tags=e2e -race -count=1 -run 'E2E|ComponentMetadataRejects|InvokeConnectRejects' .` **3.864秒**。普通包排除profile及automation的符号检查另行复核。
- 最终服务端`go test -race -count=1 ./...` **通过**：API163.356秒、config1.585秒、database6.631秒。public全部SystemSetting及迁移整行摘要前后一致，api_test/go_adopt_test schema均0→0；没有用主业务schema造测试数据。
- `pnpm build:server`、普通非e2e `node scripts/mygo-desktop.mjs --build-only` **通过**；MyGo含DMG阶段18.8秒，脚本计19.0秒，普通app17.9MB、DMG6.5MB。仅本地adhoc签名，不是DeveloperID签名、公证或真实发布。DMG/普通二进制的最终明细见`final-current-artifact-report.json`和`final-current-dmg-verify.log`。
- `git diff --check`通过；本轮生产改动与helper扫描无console.log/debugger/TODO mock/fake/demo残留，测试替身只在显式test/fixture/e2e标签内。移除旧组件缓存放行逻辑、重复基础校验和过时工具链自动切换，不新增生产依赖。

最终证据：`.tmp/ui-qa/runtime-gui-final-proof.json`、`runtime-gui-environment-cleaned.json`、`runtime-gui-cache-cleaned.json`、`final-current-{check,test,native-race,native-e2e-race,server-race,build-server,build-desktop}.log`、`final-current-server-isolation.json`。第一轮旧截图仍保留作红证据，修复后判断以`runtime-gui-fixed-*`和新二进制SHA为准。

未执行/未完成：宿主代理真实写入授权与恢复、独立watchdog的GUI父进程崩溃恢复、Windows/其他平台实机、真实系统邮件客户端、公开GitHub/镜像完整发布下载、正式签名公证、旧1.1.x到新客户端实际过渡安装。前两项没有用户授权或本轮隔离夹具不覆盖，公开发行受本地-only边界限制；旧版自动过渡安装仍未实现/实测，不只是“测试没跑”。Linux系统代理原生实现仍未支持，不把它描述为只缺实机。自然24小时清理样本最早2026-11-18 03:58:13上海时间才可验，本轮未改ctime/内容/权限/宿主时钟，也未新建自动化。目标仍未宣布完成。

### 本轮逐文件改动索引

| 文件 | 本轮内容 |
| --- | --- |
| `apps/desktop/native/components.go` | verified、kind/正大小基础记录契约、一次真实SHA核对 |
| `apps/desktop/native/components_test.go` | 损坏记录与真实Invoke连接前置拒绝回归 |
| `apps/desktop/native/runtime.go` | 就绪及代理设置后的启动取消/退出复核与恢复 |
| `apps/desktop/native/runtime_startup_test.go` | 真实Xray启动中断先红后绿 |
| `apps/desktop/native/proxy_e2e_darwin.go` | 仅e2e Darwin的严格文件代理隔离 |
| `apps/desktop/native/proxy_e2e_darwin_test.go` | 路径/身份/权限/CAS/非法配置与隔离门禁 |
| `apps/desktop/src/lib/geoUpdate.ts` | GEO current以verified为准 |
| `apps/desktop/src/lib/runtimeAssetsState.ts` | 显式verified谓词及就绪状态归一化 |
| `apps/desktop/src/lib/supportContextSources.ts` | 支持上下文不把坏物理文件当可用 |
| `apps/desktop/src/hooks/useRuntimeAssets.ts` | 连接前重查，删除UI缓存直接成功分支 |
| `apps/desktop/test/geo-update.regression.ts` | GEO verified契约回归 |
| `apps/desktop/test/runtime-source-state.regression.ts` | 就绪/取消/缓存/无来源坏文件回归 |
| `apps/desktop/test/runtime-source-state.browser.ts` | 真实hook的八类组件文件状态 |
| `apps/desktop/test/fixtures/runtime-source-state.tsx` | 仅浏览器测试的hook夹具 |
| `apps/desktop/src/components/ControlPanel.tsx` | 真实运行信号驱动内核标签与活跃端口 |
| `apps/desktop/test/runtime-control-status.browser.ts` | 10场景×2视口状态/端口/可见性回归 |
| `apps/desktop/test/fixtures/runtime-control-status.tsx` | 仅测试故意保留旧配置的组件夹具 |
| `apps/server/internal/api/github_compat.go` | 旧兼容接口beta最低版本归一化 |
| `apps/server/internal/api/github_compat_beta_test.go` | 真实HTTP/私有schema的beta红绿与stable对照 |
| `tests/e2e/runtime-ui-assets.mjs` | 真资产只读字节复制与真实记录检查 |
| `tests/e2e/runtime-ui-nodes.mjs` | 离线真实工具链、双节点/生产Agent/绑定证明 |
| `tests/e2e/runtime-ui-isolation.mjs` | prepare/start分离、fresh-root门禁与清理报告 |
| `tests/e2e/runtime-ui-isolation.test.mjs` | 9项隔离/端口/重定向/工具链边界测试 |
| `tests/e2e/runtime-ui-README.md` | 显式启动、文件代理及手动资产证据边界 |
| `docs/migration/local-verification-20261117.md` | 本轮逐项结果、命令、证据与未完成项 |
| `docs/migration/ui-qa.md` | 真实连接/故障视觉复验及清理状态 |
| `docs/migration/mygo-rebuild.md` | 重构阶段状态及未完成边界 |

## 12. 独立恢复进程与团队业务现场复验

上一目标轮有实质进展：关闭组件门禁、真实连接和内核退出展示缺口。本轮没有沿用这些绿测作为完成证明，重新审查独立watchdog和高级团队操作，实际发现并修复新的契约问题；当前仍只本地调试。

### 独立watchdog：真实main与父进程强杀

`proxy.go`只提取共用launcher；e2e Darwin profile删除同进程pipe stand-in，子进程复用生产握手、Wait、`runProxyWatchdog`及同一restore逻辑，仅传本次文件profile、数据目录和回环API，不继承automation。e2e子命令缺STATE/API/DATA_DIR或目录不一致直接终止，不回退OS。新增测试先以旧stand-in真实复现EOF后ProxyEnable仍1，再验证独立EOF、holder-only SIGKILL、身份/路径不匹配保留目标、缺字段关闭与真Xray。原生普通全量race18.868秒、e2e全量race27.834秒通过；这些结果早于后续生命周期提示修改，不能用作该修改后的最终全量结果。

主流程新建Js7Zxp临时root：API49742、PG49743、独立后台49744，controller64139/API64362/PG64302、真实节点64468/64555、生产Agent64545/64556。源自用户ignored资产的真实字节副本仍明确为手动预置，不是GitHub下载安装。后台来源复用support计划未使用的provider端口，prepare/ready显式提供adminEnvironment；helper不启浏览器或Vite。

- 第一包SHA256 `870c9672665b8b4cae90286dc9f0ade86d70558fc20fbeb0f664573b0a8720ac`。真GUI65485正常连接，Xray67365监听17890/17891；真独立watchdog67370的PPID65485、PGID67370。只SIGKILL该watchdog：主进程停止自有内核，测试JSON精确还原，UI空闲/端口--。
- 再正常连接得到Xray67647/watchdog67649。先建立文件事件观察及系统进程退出观察，再核对GUI可执行路径后只SIGKILL父GUI65485。独立watchdog由真实管道EOF触发，恢复测试JSON、删除journal、杀身份/路径匹配的Xray67647并退出。进程退出由DispatchSourceProcess观察，不用睡眠伪造结果；主流程随后ps确认三者不存在、两代理端口无监听。
- 第一轮真实UI暴露事件语义错误：用户未退出，却显示“退出未完成…请稍后再次选择退出ChordV重试”，还有重复句号。已将真正shutdown失败与运行中断、启动恢复、托盘故障分成typed事件；真实红测与截图保留。修复包SHA256 `c0fed5abf99040130cec072b96d8ed264ff6c3ddb163161bd24c9793efb2b39c`，GUI69270/Xray69290/watchdog69292复验只杀watchdog，正确显示“连接已断开”，没有退出建议或重复句号，随后正常CmdQ退出。

这证明真实main/独立子进程的生命周期、文件存储恢复和己有内核清理；不证明宿主SystemConfiguration/Authorization恢复或Windows。宿主preferences.plist mtime/size一直1791888658/21576。截图又显示持久提示遮住右上操作，布局不能据此全判绿；该问题另行改为条件反馈区并复验，最终结果随后补记。

证据：`.tmp/ui-qa/watchdog-real-gui-proof.json`、`watchdog-runtime-notice-proof.json`、`watchdog-gui-child-exit.png`、`watchdog-runtime-notice-fixed.png`、`e2e-independent-watchdog-{red,real-xray-green}.log`及`watchdog-lifecycle-report.json`。

### 团队断连、成员重置与转入团队

源码审查与真实私有schema红测确认：旧Go kick复用移出实现，误删成员并全账号撤销；正常成员详情也错接账号级disconnect；团队“重置流量”未传userId，转换入口在旧不可达页面。修复后：

- 默认kick保留成员、仅撤销本团队该用户租约/绑定；SSE及heartbeat均为admin_paused_connection，负责人也允许仅断连。显式勾选禁用账号才执行全账号禁用/撤销，与updateUser复用同一事务并保留最后管理员保护；其他用户不受影响。
- kick/remove共用团队范围撤销，统一Subscription→成员→绑定/节点锁序；确定性双HTTP请求以订阅行锁为屏障，再用成员NOWAIT证明没有反序抢锁。移出仍是独立真实删除动作，不恢复旧死disable分支。
- 当前客户工作台加入转团队、明确选成员重置入口，初始不默认选人，成员详情使用团队kick；成功正确关闭弹窗。转换准确写“停用并保留历史”，没有按旧错误文案删除订阅。真实App组件回归6/6，包含错误保留/重试、成功关闭、忙态和禁用账号全范围文案；不是现场接口证据的替代。

主流程在Js7Zxp经真实API建立双成员团队与共享订阅，两生产Agent实际安装。真实Reality流量分批产生负责人10485760B、成员20971520B；只读SQL审计，未SQL造账或伪回执。正常后台“更多→重置成员流量”初始空选且按钮禁用，明确选负责人后真实200；目标账本清零，另一成员20971520B保持，弹窗关闭。再为两成员通过真实客户端API建立活跃租约，从成员详情默认未勾禁用执行kick：真实200、撤销1条、成员仍2人、accountDisabled=false；目标heartbeat/SSE均admin_paused_connection，另一负责人heartbeat仍active。

从个人客户正常入口先取消转团队，审计个人订阅仍存在/成员关系0；再次明确确认指定团队，真实200。原个人订阅仍在且expired/remaining0，创建目标团队member关系，弹窗关闭，没有DELETE历史。

另在同一双Agent现场发现仪表台把内核healthy覆盖Agent online，误写“等待心跳/待确认”。前端统一分离控制链路与内核健康，13标签+11关注等级组合回归；现场两节点agent.online/xray.healthy、心跳不足1秒，页面“Agent在线”2、“等待心跳”0、异常节点0。没有把healthy一概翻译成在线。

第一环境所有GUI/Chrome/观察SSE/Vite、双Agent/节点/API/PG已正规停止，root删除，原主进程36715/36763/36795/12027和生产App359未动。证据：`team-actions-real-proof.json`、`team-convert-real-proof.json`、`team-admin-network-proof.json`、`agent-health-real-proof.json`、`watchdog-team-phase1-cleaned.json`。`team-reset-real-success.png`拍在用量重读骨架阶段，不用作数值稳定后的视觉证明。

### 用量聚合与实时缓存：不能只显示最后一条

现场实际GET团队usage返回4条原始ledger而非成员汇总，UI find首项显示0.008/0.016，账本真合计为0.009765625/0.01953125。已将列表/单条团队内嵌usage、成员used和独立usage入口统一到一套批量SQL聚合：真实正字节优先，默认0字节的历史GB保留；保留旧/当前订阅、未知节点和离队历史，recordCount修正为真实账本条数，不按分组数误计。真实HTTP/私有schema红绿及相关10顶层+2并发子场景race28.556秒通过，public指纹不变。

主流程正规清理旧root后，以最新API建立全新WUnTNV环境（API52475/PG52476/后台52477，controller70031/API70112/PG70077，节点70182/70188、Agent70185/70189），重跑真实计量。首批快速传输被Agent合成每人一条ledger，虽数字正确，但不足以证明多条聚合，因此未据此判完成。先确认首批落账，再发第二批并用真实SSE观察：负责人两条合计12582912B，成员两条合计25165824B；API分别返回0.012/0.023、recordCount2、各1节点。又发现前端缓存仍显示首批0.01/0.02；这是独立的缓存错误，不能用手动刷新绕过，正在同步既有SSE/teams同源数据并防旧响应覆盖。

用量红证据：`team-usage-real-red.json/png`、`team-usage-cache-real-red.json/png`；API修复后的稳定数值、缓存及后续布局/统一门禁的最终证据待本节末追加。追加代码后旧93/93不作为当前最终通过数。服务端新全量race已通过：API191.582秒、config1.501秒、database6.875秒，public全量Team/Member/Subscription/Ledger/Settings/迁移摘要前后相同、私有schema0→0；见`team-final-server-isolation.json`。

### 最终关闭本轮新增缺口

**真实累计与SSE缓存。** App在teams快照提交点同步已加载/在途团队用量，不预热未打开团队、不新增usage请求；每团队版本号+会话epoch拒绝迟到成功、失败和finally。保留既有SSE180ms合批，不清空缓存切骨架、不重建成员Modal/table。列名改为准确的“累计已用”，不是改变后端历史口径。

WUnTNV现场先重新预热到两批累计0.012/0.023，保持真实成员详情与table的ElementHandle，再发第三批真实Reality载荷。实际账本每人3条，负责人14680064B/成员29360128B；API0.014/0.027、recordCount3，浏览器未经手动刷新显示0.014/0.027，原Modal/table仍isConnected，额外usage请求0。测试侧原始管理员令牌期间到期，使独立审计SSE等待超时；没有重启环境或伪造结果，使用真实`/auth/refresh`续期后核对SQL/API。浏览器自身刷新及SSE一直正常，页面异常0。这个观测端到期被明确保留在proof，不当作产品失败或静默丢弃。

缓存组件浏览器另外覆盖旧成功/旧500、初读在途、会话退出/force去重/删除；滚动180→180属于这项组件证据，现场只确认原Modal/table和数值、没有声称现场滚动180。证据`team-usage-real-final-proof.json`、`team-usage-sse-real-fixed.png`、`team-usage-final-network.json`。

**持久提示布局。** 生命周期提示从固定portal移入App条件文档流：已有NoticeRow最多两行，完整原因始终可进既有AppDialog详情；无提示零占位，普通短时toast不改。桌面只新增条件三行grid，登录只在存在反馈时将原form gap18→10，保留真实登录错误；无全局reset或团队卡片改动。仅已确认connected状态变化清除旧runtime-interrupted，不误清退出/启动/托盘信息，也不会因旧connected快照立即吞掉刚到中断。

真实组件先红测抓到公告被portal挡住、660×468双错误登录按钮越界；最终820×588个人/团队长邮箱、57px双行反馈、660×468及390×760登录双错误均实际点击通过。长原因完整详情可滚动；普通toast保持旧逻辑。主流程另重建最终真GUI（SHA256 `099bb1f687012d9dd18eaed0fc7b2eff83c1ff7632c76923b9c9d89851e13618`，PID75848），在个人及真实转团队后的两种头部下各正常连接并只杀真实独立watchdog。反馈40px位于y201..241；全部头部操作和连接/分流/诊断中心hit=true、与反馈无交叠、bottom≤559、整体820×588无溢出；公告、诊断、完整详情和更多菜单均以系统鼠标实际打开。一次过渡期连点未打开详情，已检查同一存活GUI/动画状态后重试，不以该次失败判通过；最终详情opacity1、变换归一且原文完整。真实重连后反馈消失、grid恢复原两行，再正常断开。

主流程已查看最终个人/团队及成员用量截图。现场几何与动作见`lifecycle-feedback-real-proof.json`，截图`lifecycle-feedback-real-{personal,team,details}.png`；极长错误/双错误登录是组件级证据，详见`native-lifecycle-layout-report.json`、`native-lifecycle-layout-geometry.json`，不冒称制造过真实OS授权失败。

**最终门禁与清理。** 所有代理源码停写后，`pnpm check`6/6、`pnpm test`98/98；真实资产普通原生全量race17.979秒、e2e原生全量race27.439秒，均通过。服务端最终全量race为上节191.582/1.501/6.875秒，后续只改前端；public指纹不变。`pnpm build:server`与普通非e2e完整App+DMG均通过，MyGo阶段17.3秒/脚本17.5秒、普通App17.9MB/DMG6.5MB；adhoc本地签名，不与旧Tauri异条件比较。最终DMG校验及普通包排除e2e/automation/测试dispatch见`round12-artifact-report.json`、`round12-dmg-verify.log`。

两轮全部自建GUI/Chrome/观察SSE/Vite、节点/生产Agent/API/PG及root、socket、独立bundle缓存已清理，第二轮报告`testProxyJSONRestored:true`、`cleaned:true`、`rootRetained:false`。原主进程PID/启动时间保持36715/36763/36795/12027，生产App359未操作；原3100实例不是最新代码的启动证明，最新API真实验收用独立49742/52475。构建只原子替换本地二进制产物，没有停止原API。宿主代理文件mtime/size仍1791888658/21576。

`git diff --check`与本轮生产改动残留扫描通过，无新增生产依赖/Mock/调试入口；旧同进程stand-in、生命周期toast路径、全账号冒充团队断连、原始ledger投影、死disable分支及重复用量缓存放行已清理。没有提交、推送、发布、部署或线上写入。

仍未完成：宿主代理授权/真实字段恢复、Windows实机/跨机器Agent与安装、正式签名公证、公开GitHub/镜像发行下载、旧1.1.x实际过渡安装（自动过渡仍未实现/实测）、系统邮件应用、自然24小时删除。Linux代理实现仍明确未支持；不以可交叉编译代替功能完成。自然样本仍最早2026-11-18 03:58:13上海时间再验，未改ctime/内容/权限/时钟或安排自动化。完整设置/其余高级业务仍需逐项审计，不因98项通过而宣布目标完成。

### 第12节逐文件改动索引

#### 原生进程与事件

| 文件 | 修改 |
| --- | --- |
| `apps/desktop/native/proxy.go` | 共用独立watchdog launcher，普通环境不变 |
| `apps/desktop/native/proxy_e2e_darwin.go` | 真独立子进程、严格隔离环境、删除stand-in |
| `apps/desktop/native/proxy_e2e_darwin_test.go` | 受控目标与真实子进程等待，避免testrunner误杀 |
| `apps/desktop/native/proxy_watchdog_e2e_darwin_test.go` | EOF、父强杀、ownership、缺字段与真Xray |
| `apps/desktop/native/proxy_watchdog_e2e_helper_darwin_test.go` | 仅测试角色分发、进程身份及清理 |
| `apps/desktop/native/runtime.go` | 运行中断及代理恢复结果typed事件 |
| `apps/desktop/native/main.go` | 启动恢复失败单独事件 |
| `apps/desktop/native/shell.go` | 托盘失败单独事件 |
| `apps/desktop/native/lifecycle_events_test.go` | 非退出不能误发退出失败的真实行为红绿 |

#### 桌面反馈及验证

| 文件 | 修改 |
| --- | --- |
| `apps/desktop/src/App.tsx` | 生命周期状态、条件宿主、成功重连清旧中断 |
| `apps/desktop/src/lib/nativeLifecycle.ts` | typed订阅、完整原因与上下文presentation |
| `apps/desktop/src/lib/nativeShell.ts`、`apps/desktop/src/lib/runtime.ts` | 移除废弃单一退出监听出口 |
| `apps/desktop/src/components/NativeLifecycleFeedback.tsx`、同目录`NativeLifecycleFeedback.module.css` | NoticeRow两行预览、详情及关闭，局部样式 |
| `apps/desktop/src/components/LoginScreen.tsx`、同目录`LoginScreen.css` | 独立保留登录错误，仅有反馈时紧凑gap |
| `apps/desktop/src/styles.css` | 仅desktop-main条件反馈grid |
| `apps/desktop/test/native-lifecycle.regression.ts`、`exit-cleanup-notice.regression.ts` | payload、effect、状态清理与卸载 |
| `apps/desktop/test/native-lifecycle-layout.browser.ts`、`fixtures/native-lifecycle-layout.tsx` | 真实组件布局、命中、详情、长原因、双错误登录 |
| `apps/desktop/test/fixtures/frontend-export-contract.json` | 删除废弃监听出口快照 |

#### Go团队契约与累计用量

| 文件 | 修改 |
| --- | --- |
| `apps/server/internal/api/account_disable.go` | 共用账号禁用事务 |
| `apps/server/internal/api/team_disconnect.go` | 精确团队撤销、完整DTO、统一锁序 |
| `apps/server/internal/api/teams.go` | 分离移出与断连、复用统一usage、移除原始投影 |
| `apps/server/internal/api/users.go` | 复用账号禁用事务，无两套算法 |
| `apps/server/internal/api/runtime_locks.go` | 订阅锁阶段单独复用，保留锁规则 |
| `apps/server/internal/api/team_disconnect_test.go` | HTTP/范围/DTO/SSE/heartbeat/管理员保护 |
| `apps/server/internal/api/team_disconnect_concurrency_test.go` | 真实双请求行锁屏障/NOWAIT |
| `apps/server/internal/api/team_usage.go` | 唯一批量聚合、历史GB/真实字节兼容 |
| `apps/server/internal/api/team_usage_test.go` | 多条/多订阅/未知节点/历史/隔离与权限 |

#### 后台团队操作

| 文件 | 修改 |
| --- | --- |
| `apps/admin/src/App.tsx` | 团队动作接线、成功关闭、cache版本/会话归属与SSE原位更新 |
| `apps/admin/src/features/customers/CustomerWorkspace.tsx` | 当前转换与选择成员入口 |
| `apps/admin/src/features/customers/CustomerMembers.tsx` | 团队断连/成员重置，准确累计口径 |
| `apps/admin/src/features/customers/types.ts` | 动作类型 |
| `apps/admin/src/features/customers/TeamTrafficResetModal.tsx` | 不默认选人、明确目标、忙态/错误 |
| `apps/admin/src/features/modals/AdminModals.tsx` | 禁用全账号文案与提交门禁 |
| `apps/admin/test/customer-actions.browser.ts` | 当前实际App组件正常/错误/重试与门禁 |
| `apps/admin/test/fixtures/customer-actions.tsx`、`customer-actions-data.ts` | 仅测试入口及DTO，不进入生产 |
| `apps/admin/test/admin-information-architecture.regression.ts`、`app-header-refresh.regression.ts`、`team-subscription-form.regression.ts` | 正确调用链、AST提取及替换旧误断言 |

#### 后台节点状态及缓存验证

| 文件 | 修改 |
| --- | --- |
| `apps/admin/src/utils/node-status.ts` | 分离Agent/内核状态与关注等级 |
| `apps/admin/src/pages/OverviewPage.tsx` | 正确健康标签/异常计数 |
| `apps/admin/src/pages/NodesPage.tsx` | 正确控制链路及内核关注 |
| `apps/admin/src/features/nodes/NodeControlCenter.tsx` | 分别呈现Agent与Xray状态 |
| `apps/admin/test/node-status.regression.ts`、`overview-page.regression.ts` | 真DTO正反组合 |
| `apps/admin/test/team-usage-refresh.browser.ts` | 实际App、SSE、DOM/滚动/迟到响应 |
| `apps/admin/test/team-usage-request.regression.ts` | 请求epoch/version/force/去重/删除 |

#### 隔离入口与文档

| 文件 | 修改 |
| --- | --- |
| `tests/e2e/runtime-ui-isolation.mjs`、`runtime-ui-isolation.test.mjs` | 独立后台来源及显式环境输出/边界验证 |
| `tests/e2e/runtime-ui-README.md` | 真watchdog和独立后台的证据边界 |
| `docs/migration/local-verification-20261117.md` | 本节逐项证据/文件/命令及剩余项 |
| `docs/migration/mygo-rebuild.md` | 用新证据更新完成矩阵，不缩小目标 |
| `docs/migration/native-parity.md`、`server-parity.md`、`ui-qa.md` | 同步独立进程/真实团队计量/布局与未验边界 |

## 13. 更新安装边界、订阅白名单与工单设置契约

### 本轮实际修复

- 下载成功与复用已下载文件只标记就绪，不再提前调用原生开包命令。旧实现会在后台下载结束后真实断连并打开DMG，且早于渠道身份检查；生产hook提取执行的红测已捕获。显式安装现在核对当前、已完成、就绪包身份和渠道；macOS开包返回后再次核对身份才退出。强制更新倒计时仍调用同一显式安装动作。
- HTTP200忽略Range导致从零重传时，同时归零测速基线；旧实现用旧part偏移计算负速度，真实健康源在12.10秒被误判低速。另把真实45秒无数据超时与用户取消分开：停滞返回独立错误，第二健康源实际收到`Range: bytes=1-1`、补齐文件并通过SHA256；用户取消仍立即停止。没有放宽12秒低速宽限、45秒停滞或完整性门禁。
- 续期、变更套餐按旧DTO白名单剥除`usedTrafficGb/state`等额外字段；PATCH保留校正能力，显式重置保留最终结算门禁。真实旧API接受额外`usedTrafficGb:0`使0.25GB变成0；新API保留0.25GB。团队指定成员重置复用团队累计的唯一bytes/GB表达式，其他成员旧GB账本不再消失：私有schema混合账本应保留3GB，旧实现只保留1GB；另一团队不变。
- 切换已有工单地址或Client ID必须同时提供不同的新Webhook Secret。缺省、相同、加空白后相同、null共8个拒绝子例，设置整行/未读/请求/事件/代次均不变；合法轮换后旧签名401、新签名通过。已有连接行锁与原子清理顺序保留。
- 工单“测试连接”不再借用客户入口：保存凭据但关闭入口也可测试，显式测试始终重新附带10个资料字段，不沿用客户422负缓存。沿用旧版专用连接测试联系人，不发送管理员身份；真实422仍只无资料重试一次，客户入口继续保留10分钟抑制。票据地址/到期校验与正常入口共用；缺凭据、跨站票据及测试中配置变化不伪报通过。
- 根验证器原来只发现`.regression.ts`，漏掉既有安装交接`.regression.mjs`；现同时发现两种扩展名，本轮全量日志实际包含交接回归，不再仅靠专项手跑。

### 本轮逐文件索引

| 文件 | 修改 |
| --- | --- |
| `apps/desktop/src/hooks/useUpdateFlow.ts` | 移除下载/复用阶段的开包与相应死代码；安装身份门禁，必要提示按真实安装器行为描述 |
| `apps/desktop/test/silent-update-download.regression.ts` | macOS/Windows、后台/前台、新下载/复用零开包；旧身份与途中切渠道 |
| `apps/desktop/test/update-handoff.regression.mjs` | 显式安装身份/渠道/开包等待中变更拒绝；保留失败及强制交接回归 |
| `apps/desktop/native/download.go` | 200重传同步重置测速基线；取消原因区分停滞与用户取消 |
| `apps/desktop/native/download_test.go` | 真实健康重传、45秒停滞后第二源续传、主动取消及原文件保护 |
| `apps/desktop/test/download-mirror-ranking.regression.ts` | 执行生产hook停止规则，停滞换源、五类主动取消立即停止 |
| `apps/server/internal/api/subscriptions.go` | 续期/换套餐先应用旧DTO白名单，移除不可达清零分支 |
| `apps/server/internal/api/team_usage.go` | 提取唯一`ledgerTrafficBytesSQL`，维持原累计聚合语义 |
| `apps/server/internal/api/traffic_reset.go` | 成员重置复用同一bytes优先/旧GB回退口径 |
| `apps/server/internal/api/subscription_actions_test.go` | 真实HTTP白名单、PATCH/显式重置正向控制、混合账本与另一团队隔离 |
| `apps/server/internal/api/support_settings.go` | 已有连接切换必须轮换Webhook Secret |
| `apps/server/internal/api/support_rotation_test.go` | 8类原子拒绝、正常保留/轮换及新旧签名 |
| `apps/server/internal/api/support_launch_test.go` | 连接切换夹具显式提供新Secret，不放宽旧票据拒绝断言 |
| `apps/server/internal/api/support.go` | 移除借用客户入口的旧测试连接实现及失效import |
| `apps/server/internal/api/support_launch.go` | 显式属性重验参数、正常客户保留负缓存，共用真实票据校验 |
| `apps/server/internal/api/support_connection.go` | 唯一管理员连接预检，专用测试身份、全部字段、关闭入口可测、配置代次复核 |
| `apps/server/internal/api/support_connection_test.go` | 关闭入口、拒绝后重验/无字段重试、普通客户抑制、缺凭据及跨站票据 |
| `scripts/mygo-verify.mjs` | 全量发现TS和MJS回归，避免交接测试漏跑 |
| `docs/migration/local-verification-20261117.md`、`mygo-rebuild.md`、`native-parity.md`、`server-parity.md`、`ui-qa.md` | 同步本节证据和明确未完成项，不扩大已验范围 |

### 本轮最终验证和真实界面

- `pnpm check`：6/6条命令；`pnpm test`：99/99条命令，日志实际执行`update-handoff.regression.mjs`。日志`round13-{check,test}.log`。
- `go -C apps/server test -race ./... -count=1`：API245.992秒、config2.218秒、database11.148秒；全部数据库用例仍随机私有schema。专项订阅10个顶层28.332秒、完整support/旧工单11个顶层32.110秒，preflight新增3项7.015秒通过；红绿证据均保留。
- 显式`CHORDV_TEST_XRAY_DIR=apps/desktop/src-tauri/bin`、`CGO_ENABLED=1`：普通原生全量race80.293秒；真实`-tags=e2e`全量race87.611秒，分别见`round13-native-real-race.log`、`round13-native-e2e-real-race.log`。较早普通无资产75.277秒不用于真实资产结论；一次错误传入未定义`chordv_e2e`的75.269秒日志已改名`round13-native-ignored-tag-race.log`，不当e2e证据。
- 全新API65099/PG65100/本地工单provider65101/后台65102：新二进制真实HTTP与正常UI均通过。正常续期从2026-12-17顺延到2027-01-17，保持0.25GB；正常变更为5GB套餐仍保持0.25GB。关闭工单入口时正常点击测试连接200、全部资料接受，开关仍关闭。`round13-normal-ui-proof.json`、`round13-support-ui-proof.json`及`round13-api-green.json`为脱敏证据；provider不代表线上供应商。
- 布局已查看：1024×768与390×760续期窗口/按钮无横向溢出，390下预览和确认按钮完整；正常变更套餐与工单窗口截图已保存。最初CLI选错角色/会话关闭和短时旧操作通知遮挡的截图不作最终布局证明；最终重开独立上下文复验，`round13-renew-390.png`和`round13-support-disabled-tested-clean.png`已人工查看。未修改CSS或DOM结构，正常页面异常0。
- `pnpm build:server`、`pnpm build:desktop`、普通App的`codesign --verify --deep --strict`、`hdiutil verify`、`node --check scripts/mygo-verify.mjs`、`git diff --check`通过。没有生产Mock、新依赖或重复安装/重置路径；测试边界和本地provider只在测试/忽略审计目录。
- 普通App17.9MB，DMG6,852,096B；普通二进制SHA256为`87215eb9ca6f2fd36c8566a2f10a23ea7fd55bf7eeb01cd3a835ffa168627e66`，DMG为`877160fa5f5b8340b114eb1b0a0380c87dfa196538ff2587de9bf6e1db1ecfd6`。仅adhoc签名，普通构建标签为`mygo_nodownload,mygo_noinspector`，未启用e2e。详情`round13-artifact-report.json`。

### 隔离清理与仍未完成

- 自建`zdS2gO`与`3wMN03`两套API/PG/Vite/provider及浏览器均退出，7个自用端口无监听、两root及私有凭据均删除。主App359、supervisor36715、API36763、Vite36795、PG12027的PID/启动时间不变。主public User/Plan/Team/TeamMember/Subscription/TrafficLedger/SystemSetting/迁移整行摘要一致，私有schema0→0；见`round13-environment-cleaned.json`。更新了本地构建文件，但运行中主API36763仍是旧实例，不拿它证明新源码。
- 宿主代理文件mtime epoch1791888658、size21576不变；自然老化样本ctimeNs仍1794859092178170591，未改时钟/样本，仍最早11月18日03:58:13验真实24小时现存文件删除。
- **macOS自动替换/重启尚未实现**：当前原生只有打开DMG与普通退出，不把按钮名或手动安装当最终自动升级能力；这是后续需实现的缺口，不用改标签缩小目标。正式签名/公证、旧1.1.x过渡安装、公开GitHub/镜像发行链、宿主OS代理授权与实机恢复、Windows/跨机器实机仍未验；Linux系统代理明确未实现。
- 后续确定候选：订阅数字`"bad"`被通用`number()`转为0（未做真实破坏性红测）；Windows安装先永久shutdown再Start失败的生命周期缺口（尚未注入失败验证）；流量重置完成器缺请求代次复核（未确定性复现）。本轮未猜改这些范围，也未把renewable后端门禁称为迁移回归——旧版同样没有。
- 未提交、推送、发布或部署；本节只证明所列本地范围，完整目标仍未完成。

## 14. macOS 自动替换、安装交接及订阅数值校验

本轮继续完整迁移目标，不把“打开DMG后手动安装”当自动更新。用户明确暂不授权宿主系统代理修改，本轮只做本地隔离测试，不再申请或执行该写入。

### 实现与文件索引

完整56个代码/测试/文档文件的绝对路径与逐文件说明见`.tmp/ui-qa/round14-final-report.json`；Mac13文件独立索引见`mac-update-delivery-report.json`。以下为职责索引，测试不作为第二套生产实现：

| 文件/职责 | 本轮修改 |
| --- | --- |
| `apps/desktop/native/mac_update_darwin.go` | 准备/提交/取消单一流程；READY长等待不持锁；当前缓存/落盘pending与plan一致；已确认提交不能公开取消，丢确认仍可回收 |
| `mac_update_validation_darwin.go` | receipt/当前floor、公钥、规范路径、bundle树、单架构Mach-O、严格codesign/同Apple Team/anchor及已签名元数据；校验绝不执行候选程序，显式防当前版本/build降级 |
| `mac_update_files_darwin.go` | helper拥有的只读DMG挂载/ditto/detach；私有work/journal/report，target级跨DataDir锁，目录FD inode/device/type复核与原子RENAME_SWAP |
| `mac_update_helper_darwin.go` | 独立复制helper，私有管道授权及READY→提交/确认→EOF；EOF后还必须等待匹配父进程的kqueue EXIT；原子替换、OS拒绝启动则同swap回滚 |
| `mac_update_other.go`、`mac_update_restart_darwin.go`、`mac_update_restart_e2e_darwin.go` | 非Darwin明确不支持；普通包不含测试代理profile；仅e2e编译允许严格验证后的文件代理环境，不传automation |
| `mac_update_darwin_test.go`、`mac_update_boundary_darwin_test.go`、`mac_update_fixture_darwin_test.go`、`mac_update_holder_darwin_test.go`、`mac_update_wait_darwin_test.go`、`mac_update_restart_e2e_darwin_test.go` | 真实独立MyGo应用/DMG/签名/Ed25519 receipt、提交和丢确认、事件驱动父退出/挂载清理、并发target、待安装包变化及取消边界；详细准确文件名以JSON索引为准 |
| `native/main.go`、`config.go`、`build_info_test.go` | GUI前helper分支与五项构建信息早退出，默认build0；实际子进程不加载配置或创建DataDir |
| `native/installer.go`、`service.go`、`types.go`、`runtime.go` | Mac准备与提交接线、真实取消命令；同一安装预占锁禁重连；普通退出不冒充安装提交 |
| `native/installer_handoff.go`、两项handoff测试文件 | Windows/Mac共用验证→仅断开→启动/提交→报告→退出；启动失败保留同根上下文，报告失败仍退出；锁等待取消再次检查，不清理已取消请求 |
| `native/installer_launch_{windows,other,command}.go`及命令测试 | NSIS明确当前可执行目录，末尾无引号/D=，不加/S、不用shell；拒绝注入、盘符根和共享根，后台Wait回收 |
| `native/release_floor.go`、`installer_receipt_test.go` | 无当前仓库/验签公钥时拒绝持久pending；始终复验签名，不把旧floor当信任源 |
| `src/lib/nativeInstaller.ts`、`hooks/useUpdateFlow.ts` | typed取消职责适配器；同步防重复、准备后live身份/渠道复核、异常显式取消、取消失败明确报错；成功保持忙态到退出 |
| `src/App.tsx`、更新中心/版本弹窗/进度面板/运行组件banner | 基于安装状态禁用冲突连接、开关、检查、组件同步和关闭；暂停自动组件同步，保持旧视觉和CSS |
| `test/update-handoff.regression.mjs`、`silent-update-download.regression.ts`、`external-update-link.regression.ts`、更新中心fixture/browser | 实际hook片段、取消适配器、自动下载机会和真实浏览器防重/布局；旧runtime导出基线不变 |
| `test/windows-full-update-path.regression.ts`、`routing-rules.regression.ts` | Windows专用回归实际跑18项Go行为；移除路由测试里重复且要求错误永久shutdown的旧源码断言 |
| `scripts/mygo-desktop.mjs`、`mygo-desktop-metadata.mjs`及测试 | 用同一version/build/平台/架构参数在签名前写ChordVBuildInfo到Info.plist，后续只读密封字典，不尝试执行未知候选flag |
| `apps/server/internal/api/subscription_input.go`、`subscriptions.go`、`traffic_reset.go`、`subscription_numbers_test.go` | 订阅专用数值归一/有限范围，写入和重置marker前校验；普通reset保持旧userId白名单，不改通用number或结算锁序 |
| 本文与`mygo-rebuild.md`、`native-parity.md`、`server-parity.md`、`ui-qa.md` | 更新本节证据和明确未完成项；第13节“自动替换尚未实现”是历史状态，不再作为当前结论 |

### 实际红绿与完整门禁

- 数值117项真实HTTP非法矩阵全部400，六张私有表整行摘要不变；11种旧DTO合法转换保留（包含数字字符串等），显式null拒绝。旧实现`totalTrafficGb:"bad"`可触发续期重置并删除团队账本，红测保留。专项race55.193秒、有限值单测1.680秒；最终服务端全量race API255.042秒、config2.435秒、database7.844秒通过。
- 旧安装流程启动失败后永久取消根ctx，真实SSE旧流断开/新流及HTTP心跳失效、报告失败不退出均已红测；修复后同一根ctx的旧/新SSE和心跳存活。追加锁等待barrier取消先红（仍断开一次）后绿，未用sleep替代屏障。证据`.tmp/frontend-split/installer-handoff-{red,green}.log`、`installer-handoff-validation-final.log`及`.tmp/installer-context-{red,green}.log`。
- Mac最新专项race107.185秒通过；真正只读挂载、ditto、签名/密封元数据验证、detach、父EXIT、原子交换和open独立MyGo候选均执行。真实OS拒绝启动（候选最低系统版本99）恢复原inode/CDHash；准备中父SIGKILL由独立helper取消、卸载并清理。READY前真实stage barrier取消约24.9ms；公开取消在提交确认后被拒，报告写失败仍退出并替换。双有效渠道floor下pending变化拒绝、跨DataDir target锁、FD替换复核、防降级和候选校验不执行均有实际测试。全量日志`mac-update-race-green.log`，初绿不替代它。
- 主流程`CHORDV_TEST_XRAY_DIR=... CGO_ENABLED=1 go -C apps/desktop/native test -race ./... -count=1`普通全量186.363秒；真实`-tags=e2e`全量203.337秒，通过；不把编译或选定专项当全量。日志`round14-native-real-race.log`、`round14-native-e2e-real-race.log`。
- `pnpm check`6/6。首轮`pnpm test`98/99，失败仅为routing文件中过时重复的永久shutdown源码断言；没有把失败改成成功。清理这项已被专用18项真实Go行为覆盖的断言后，从头再次`pnpm test`，最终99/99条命令通过。原`round14-test.log`与最终`round14-test-final.log`均保留。
- `pnpm build:server`、`CHORDV_BUILD_NUMBER=14 pnpm build:desktop`、`node --check`、普通App的`codesign --verify --deep --strict`、`hdiutil verify`、`git diff --check`通过。Windows amd64/arm64只编译与vet通过，不冒充安装器实机执行；Linux仅编译/静态门禁，不宣称代理已支持。
- 新普通App18.1MB，DMG6,763,008B，build14。实际本地可执行文件`--chordv-build-info`输出与签名Info.plist的ChordVBuildInfo完全一致（1.1.12/14/local/macos/arm64）；普通二进制SHA256为`93e1a359ba36b2004ecc3dcf5752f3971766076e9279f86454e6dd68ddff37ee`，DMG为`107a5dcdf52e9e4e3f7319c619490c95824502cc1bb4ccef9c5032f80cdc40bc`。仅adhoc签名；普通tags为mygo_nodownload,mygo_noinspector，二进制无CHORDV_E2E_PROXY_STATE，见`round14-artifact-report.json`。
- 布局已检查并人工查看820×588/820×560/390×480的忙态截图，按钮loader在边界内，安装/渠道/关闭等实际不能重入；没有CSS改动。主流程查看`output/playwright/update-center-busy-{390x480,820x588}.png`及`update-progress-busy.png`。生产构建未带测试fixture，新接口不改变旧runtime导出；移除手动开DMG与永久shutdown路径，未新增生产Mock、依赖或双安装方案。

### 清理与未完成边界

- 最终无自有holder/helper或.chordv-mac-update挂载，临时App/work由测试清理。主App359、supervisor36715、API36763、Vite36795、PG12027的PID/启动时间不变；主public八表整行摘要一致，私有schema0→0。宿主代理mtime epoch1791888658、size21576不变。自然24小时样本ctimeNs仍1794859092178170591，没有改时钟/样本，仍待11月18日03:58:13后验。证据`round14-environment-cleaned.json`。
- `output/local/chordv-server`已原子替换为本轮构建，但运行中主API36763仍旧实例，没有重启，不拿它证明本轮新源码运行；本轮服务端证明来自真实私有schema HTTP和完整race。
- **仍未实现：新完整ChordV GUI健康确认及健康失败回滚、helper自身被强杀/断电后的自动journal回放。** open返回成功只表示OS接受启动请求；独立MyGo候选启动marker是另一个实际证据，不等于完整签名ChordV跨版本健康验证。备份保留取决于阶段：open成功后的正常清理会删除旧bundle，不能宣称所有崩溃均保留可回滚副本。
- 正式Developer ID/Apple anchor同团队正控、公证、公开GitHub/镜像完整投递、旧Tauri1.1.x过渡安装、Windows/Intel/旧macOS与跨机器实机仍未验。Linux系统代理明确未实现。宿主OS代理真实写入/逐字段恢复因用户明确暂不授权而不执行，隔离测试继续，不能用文件代理冒充OS验收。
- 未提交、推送、发布、部署或创建自动化；完整迁移目标仍未完成，后续优先补健康确认与持久恢复，而非用按钮文案缩小目标。

## 15. 新版本原生与首屏健康确认、备份门禁和恢复只读检查

本轮继续本地完整重构目标。用户明确暂不授权宿主系统代理修改，所有连接验证仍只使用隔离边界；没有生产App、主API或部署操作。

### 修改范围与唯一更新链

42个代码、测试和文档文件的绝对路径与逐文件说明见`.tmp/ui-qa/round15-final-report.json`。原生7文件专项见`round15-launch-proof/delivery.json`；该JSON的早期“完整GUI留root验证”是分工时点，不代替以下主流程实际结果。

- `main.go`、`types.go`、`service.go`、新`app_readiness.go`：区分普通显示窗口与`app_ready`；原生启动屏障、请求/服务存活、真实主窗口及退出门禁通过后才接受login/main首屏确认。普通启动无健康客户端，候选异常明确诊断并清理退出。
- 新`mac_update_health_{client,peer}_darwin.go`、`mac_update_health_darwin.go`、`mac_update_health_other.go`、`mac_update_launch_darwin.go`、`mac_update_process_darwin.go`：短路径0700/0600私有Unix socket、32字节挑战、内核peerPID/UID、微秒创建身份/libproc路径、运行中csops CDHash与已签名bundle inode/CDHash的两次复核；NSWorkspace创建新实例并取得真实PID。只注册kqueue EXIT，不以按名扫描或`open`返回码代替候选归属；超时无回调/身份不确定保留备份。测试清理完整GUI也只从LaunchServices精确bundle URL取得PID并复核内核路径、动态签名，不按进程名全杀。
- 新`mac_update_apply_darwin.go`和`mac_update_persistence_darwin.go`、现`helper/files/validation`：保留唯一授权/父EXIT/交换链，交换前O_EXCL固定A/B与helper事务并同步文件及目录；新版本原生和首屏两道门禁通过，再持久healthy和报告，最后才删旧副本。健康失败先确认精确候选退出，才能反向原子交换并尝试重开旧版；已健康但持久化/清理失败不杀健康GUI，保留能保留的资料。安装报告和journal增加候选PID/创建身份诊断。
- 新`mac_update_recovery_darwin.go`及测试、`mac-update-recovery-design.md`：从独立启动bundle与当前配置派生封装锚，检查plan/transaction/receipt与真实A/B两端签名及node/CDHash配对。检查不持变更锁，仅是快照，`MutationAuthorized=false`、`RequiresRevalidation=true`恒成立；尚未接启动、没有自动回滚/清理，也没有把自洽hash当认证intent。
- 前端`App.tsx`、`useAppReadiness.ts`、`nativeShell.ts`、`useAuthBootstrap.ts`与两项窗口布局模块：本地首屏不等待网络认证；实际DOM、布局、可命中控件提交后才发一次确认。窗口失效/失败不冒充完成，确认失败显示持久提示而不自行退出；认证代次和凭据写入串行阻止旧恢复覆盖新登录。未修改CSS或既有runtime导出基线。
- 原生/完整GUI、前端首屏/窗口/认证专项及四个旧hook测试适配：沿用原业务断言，新增的React useRef/useEffect仅补测试调度适配，不删掉退出、密码清理或连接失败断言。只在test或忽略审计目录保留故障夹具，无生产Mock、新依赖、测试健康绕过。

### 实际红绿、根因与完整GUI

- `NSWorkspace`独立证明两次新实例PID不同且对应真实MyGo WhenReady，最低系统99候选明确拒绝。正常专项与早期helper全链不一致，实测同一launcher在`init`中等待回调15秒超时、在main中立即收到拒绝；Go runtime的`main_init_done`门禁阻塞初始化期外部线程回调。修复的是测试分发入口：`TestMain`执行角色逻辑，不改生产launcher，不用open兜底。修复后真实父EOF/EXIT→安装→新版本确认和系统拒绝→原inode/CDHash回滚两项race26.987秒通过。初失败日志`round15-mac-update-{first,second}.log`、修复`round15-mac-update-testmain.log`均保留。
- 完整e2e首轮出现原生失败候选等待超时，未当成绿色。真实Unix子进程屏障实验：发失败后在服务端Accept前关socket，仍存活的child也10/10令`LOCAL_PEERPID`返回ENOTCONN，但缓冲消息和UID仍可读；连接保持打开则10/10读到真实PID。客户端改为记录原生错误、等服务端认证peer并发challenge后才发送failed并结束；不放宽peer门禁。子进程生产源码副本`-race`屏障正控10/10通过，确定性同进程挑战前错误门禁重复10次通过，完整e2e原生错误→精确退出→回滚重复3次45.183秒通过。证据`round15-launch-proof/{peer-close,native-error-barrier}`、`round15-native-error-challenge.log`、`round15-native-health-failure-repeat.log`；首轮失败`round15-native-e2e-real-race.log`保留。
- 正常MyGo健康、缺原生/前端、错ACK/session、外来peer、提前退出、OS拒绝、动态签名不匹配和PID身份变化均有真实进程专项。健康确认既不要求在线API，也不要求登录成功；两门禁任何一个缺失都不接受。
- **普通构建完整ChordV GUI已实测**：显式`CHORDV_TEST_FULL_GUI_APP=.../ChordV MyGo Local.app`，真实候选原封bundle和当前密封版本1.1.12/build15、真实DMG/receipt/父EXIT/原子交换、Go startup和实际React首屏确认后清理Work/journal；回环API端口1不可达、没有会话/代理journal。最终专项race21.923秒，GUI动作20.56秒，CDHash`43623a03d5c5f0d2697721154827cd9e74f51bc2`。不是简化MyGo marker、浏览器mock桥或e2e绕过；默认完整suite会显式跳过该需预建App的专项，另以`round15-full-gui-health-final.log`证明真实执行。

### 前端布局与门禁

旧初始化方法在saved-session bootstrap永久挂起时，实际完整App邮箱disabled，红测保留于`.tmp/frontend-split/app-readiness-red.log`。新流程真实浏览器可输入、能打开账号帮助并发login ACK；无会话也确认；窗口pending/failed零ACK；ACK拒绝有中文持久提示且不前端quit；新登录后释放旧请求，账户和持久凭据不被回灌。五项认证归属专项和窗口队列/导出基线保持。

已人工查看660×468、820×588、390×760的完整App登录截图、820×588干净主界面和ACK失败提示。最初截图的帮助过渡残影、夹具未匹配真实Notifications参数及测试公告遮挡已单独纠正重取，不把过渡图当最终布局证据；最终`app-readiness-offline-login-*`、`app-readiness-manual-login-820x588.png`与`app-readiness-ack-failed-660x468.png`均无裁切/横向溢出，既有视觉不变。浏览器隔离原生边界只证明前端，完整原生健康另有上述普通App真实闭环。

### 最终门禁与产物

- 最终 `pnpm check` 6/6；`pnpm test` 102/102条命令通过，分别见`round15-check-final.log`、`round15-test-final.log`。首轮98/102中三项旧hook测试缺新增React useRef/useEffect适配，一项浏览器使用全局dialog定位撞到过渡中两弹窗；保留原断言，补测试适配/精准弹窗定位后从头全量重跑，不把首轮失败改写成通过，`round15-test.log`保留。
- 显式真实Xray资产、CGO_ENABLED=1，普通原生完整race216.039秒，真正`-tags=e2e`完整race232.344秒通过；日志`round15-native-{real,e2e-real}-race-final.log`。普通完整GUI专项额外实际执行并通过，不能以默认需预建App时的skip替代。当前服务端本轮没有改代码，最终pnpm实际API集成50.422秒/config1.362秒/database6.126秒通过；未重复服务端完整race，第14节255.042秒仍是上一轮已验值，不冒称本轮race。
- `CHORDV_BUILD_NUMBER=15 pnpm build:desktop`、严格codesign、hdiutil verify、Go build-info与密封plist对照、生产/普通包残留扫描、`git diff --check`通过。Windows amd64/arm64的test交叉编译与vet、Linux amd64交叉编译/vet通过，只是静态门禁，不当实机运行/代理证明。`pnpm build:server`本轮未重跑：服务端未修改、主旧API也未重启，沿用上一轮产物但不拿旧实例证明新测试。

普通App18.2MiB（实际文件合计19,116,450B），DMG6,683,648B，build15。普通二进制SHA256`f936f6241d9a77a6e21bf293a02a7966466bb51e20f069b3044ee93b84622694`，DMG SHA256`914f38514b04e61050a77cf49c62d0c73ccbaf89c9b5b3c0f564ac0b1826020d`。严格codesign与DMG verify通过，实际`--chordv-build-info`和签名Info.plist完全一致；普通包无`CHORDV_E2E_PROXY_STATE`，仅adhoc签名，不称正式发行。构建耗时是本机缓存和并发测试条件，不与旧Tauri作不对等“质变”结论。证据`round15-artifact-report.json`。

### 清理与明确未完成

主App359、supervisor36715、API36763、Vite36795、PG12027的PID与启动时间不变；主public八表整行摘要一致、私有schema0→0。宿主代理文件mtime epoch1791888658、size21576不变，自然老化样本ctimeNs仍1794859092178170591。最终无自有更新App/helper进程、更新挂载或health socket目录；一处失败e2e助手强杀遗留socket已凭与该journal候选创建时间精确相同的birth epoch1794883156、UID/权限、唯一socket内容和无开放句柄确认归属后定向清理，未按泛前缀删除其他资产。证据`round15-environment-cleaned.json`、`round15-owned-orphan-cleaned.json`。证明材料与独立实验源码/包保留在忽略审计目录；不把保留证据称为运行残留。

- **未实现真正助手强杀/断电后的自动journal回放**：本轮只固定事务和只读检查，缺独立可信持久intent/启动交接；现有phase/digest自洽不授予修改权。助手已死且候选无法启动时，没有外部可信恢复入口可执行自动修复。备份只在健康通过并持久后正常删除；启动不确定/健康持久失败保留，不宣称任何断电均可自动恢复。
- 正式Developer ID、同Apple团队/anchor正控、公证、公开GitHub/镜像投递、旧Tauri1.1.x过渡、Windows/Intel/旧macOS与跨机器实机未验；Windows/Linux只有交叉编译/vet，Linux系统代理仍明确未实现。宿主OS代理写入/逐字段恢复因用户明确暂不授权而不执行，隔离测试不冒充OS验收。
- 自然24小时样本不改内容、权限、ctime或时钟，最早仍为11月18日03:58:13后验证；没有为等它创建自动化。未提交、推送、发布、部署；完整目标仍active，不标完成。

## 16. Agent 真实发布供给、策略布尔契约与持久文件系统锚

本轮仍只本地调试；用户暂不授权宿主系统代理写入，不执行线上、GitHub发布或系统安装。33个代码、测试、文档文件的绝对路径和逐文件说明见`.tmp/ui-qa/round16-final-report.json`；Agent20文件专项说明见`agent-release-supply-completion.md`。

### Agent 一键接入不再缺包

审计发现旧Go分发入口仅认DataDir/agent-dist，但生产构建和GitHub服务端归档没有供给Agent；原来用文本成功夹具和直接运行自编译Agent的e2e绕开此缺口，不能证明后台一键接入可用。现改为同次源码构建server与Linux amd64/arm64 Agent，版本/Commit/双架构SHA写清单，清单SHA编译进server。运行中实例在New构造时固定实际exe旁release目录，不随current符号链接重新解析，不读DataDir，不做备用下载真相或发布中心。

单一投递链：现有GitHub签名清单→完整server归档SHA/长度→server内嵌Agent清单SHA→两架构文件SHA→真实Go可执行文件的包路径/linux/架构/CGO=0/唯一内嵌Version和Commit。现有归档同时携带agent-dist和SERVER-CONFIG.md，部署/回滚必须切换整个不可变版本目录，不只换server。正常start.sh也构建配套Agent；裸go run没有构建锚时明确503，不能偷偷从DataDir取包。旧文本成功夹具已换真实Go Agent，故意破损文本只保留负测。

主流程在源码停写后重新构建两份真实Linux backend包，再跑`node scripts/mygo-agent-distribution-e2e.mjs`：已有stageServer归档、临时Ed25519签名/验签/原文篡改拒绝、实际归档SHA/长度、随机私有schema HTTP创建节点→脚本→两架构下载及错版本/架构/篡改/令牌未消费均通过；HTTP组4.344秒。另把带实际编译锚的原生测试exe放在解压目录，从任意cwd走生产os.Executable解析，无私有路径注入，HTTP双架构下载0.06秒通过。全新DataDir保持空，不把手工塞资产当完成；没有执行脚本root/systemd部分。证据`agent-release-supply-e2e.json`、`round16-agent-release-final.log`、`round16-linux-{x64,arm64}-build.log`。

发布脚本专项20/20已由专项代理运行，默认mygo-verify会发现现有.github/scripts/*.test.mjs；核心Go测试默认执行，需显式归档的两个额外测试由上述真实runner实际执行，不以默认skip代替。proof只存临时公钥/签名、清单和归档SHA/长度/schemaID，不含注册token、安装脚本或私钥。HEAD397a64de9cc345049f886e64cc19f46d887f8304只是dirty本地源码的共同构建元数据，不冒称远端已包含这些修改；没有生产签名/上传/发布。

### 策略PATCH保持旧DTO的布尔边界

旧ValidateIf/IsBoolean只接受true/false或缺省，新Go路径曾把字符串/数字交给PG隐式转换。48项真实HTTP红测中33项被错误接受并改变PolicyProfile（包括"false"/"yes"/"on"/"1"/数字0和1），另15项原本已拒绝，不把所有样本都描述成漏洞。现仅在savePolicy访问数据库前检查blockAds/chinaDirect/aiServicesProxy的JSON bool；未改通用转换或modes既有校验。

修复后48项全部400，每次该私有schema的48表整行摘要均不变；true/false、缺省保留、未知字段白名单、另schema隔离，以及重复/空/未知/默认模式不在允许列表等控制保留。专项race7.354秒、go vet通过，public九表无变化、8个专项schema清零。旧class-validator46样本对照及真实红绿见`.tmp/policy-boolean-{legacy-contract.json,red.log,green.log,result.json}`。

### 持久文件系统身份：已写入真实更新事务，但没有自动恢复

`mac_update_filesystem_darwin.go`以真实fgetattrlist读取卷UUID和文件ID，附加目录创建时间防止删除后ID复用；在目录FD上核对卷、文件ID与inode，交换前把原A、候选B、Work和父目录四端身份写入独占事务。正常交换仍使用即时dev/inode和目录FD CAS，持久记录不替代运行期并发门禁。

新事务的只读恢复检查按UUID/文件ID/创建时间及完整签名/元数据配对；旧记录保留原先只读逻辑，不补造授权。实测同卷不同目录ID不同，真实原子交换/回滚保持A/B持久身份，外部重建目录被拒，符号链接/普通文件/缺失路径被拒。模拟落盘旧device变化可正确分类，创建时间篡改不接受；这是模型测试，不是实际重启。专项race4.009秒，日志`round16-filesystem-green.log`。

新进程测试实际执行A/B签名bundle中的测试二进制，由其os.Executable派生锚，不继承检查缓存：交换后仍停留swap_pending的journal被识别为candidate_installed；把phase改healthy也仍`MutationAuthorized=false`。fresh-process race8.802秒，`round16-filesystem-new-process.log`。尚未接自动回放、可信授权或新父GUI退出恢复交接，不能把这些只读证明叫成SIGKILL/断电自动恢复。

### 传统Keychain方案被实际证伪，未接生产

仅在独立目录自建私有file-based Keychain进行真实A/B/C实验，口令只在controller内存；用户login/default及搜索列表未改。默认decrypt ACL拒绝C读取，但C能把item data改成已知值，A随后成功读到新值；收紧Encrypt/ChangeACL为A/B/helper后C仍能更新，A/B均成功读取已知值；旧ModifyAttributesAndData对照同样能覆盖。因此传统generic-password条目不构成本设计需要的同UID恢复intent/HMAC完整性锚，没有添加弱Keychain provider、trusted=true、同目录明文MAC key或自动回放兜底。

裸复制GUI Mach-O脱离签名Info.plist，SecTrustedApplication不能当有效helper；完整签名Helper.app正控能读取，不能为了裸helper放宽ACL。C改ACL超时不是拒绝证据；metadata/retarget未在识别到强制prompt调用链后继续盲试。独立进程实证UI开关只影响调用进程；但是部分legacy路径直接构造prompt credentials，不能把该开关当所有API绝不交互的保证。

首次per-query禁UI参数没有阻止legacy请求，留下一个系统窗口；停止自有client和删除临时keychain未自动撤销窗口。主流程AX核对文本明确为本次“ChordV Keychain Proof C”访问“anchor-proof”后只点击“拒绝”，没有输入口令或选择允许，随后AX与CGWindow均确认可见窗口0。后续获准的非交互单项与矩阵无新可见窗口；所有临时keychain已Lock后删除、自有worker为0、用户list/default逐字一致。没有向宿主SecurityAgent发信号，不宣称已审计OS所有后台内部写入。完整原始状态、源代码、清理和资料索引见`round16-keychain-proof/delivery.json`。

后续可信候选是有正式代码身份、受授权共享access-group的Data Protection Keychain；仅手填adhoc entitlements不构成该授权。当前没有正式Team/profile正控，也未对宿主DP/default keychain写入，不能宣布此方案已实现。Apple对受限entitlement/profile授权与裸可执行文件限制的说明见[TN3125](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles)，不同Mac Keychain实现见[TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)。

### 全量验证与产物

- `pnpm check`6/6、`pnpm test`102/102条命令通过，含全部现有浏览器回归；日志`round16-{check,test}.log`。本轮没有UI/CSS修改，布局影响已审阅，普通完整GUI启动也另有实际验证，不把后端测试当布局截图。
- 显式真实Xray资产、CGO_ENABLED=1，普通原生全量race237.745秒、真正-tags=e2e全量258.556秒通过；`round16-native-{real,e2e-real}-race.log`。普通build16完整ChordV/React更新健康专项race24.402秒（实际GUI22.99秒），无代理journal、回环API端口1不可达；`round16-full-gui-health.log`。
- **显式数据库的服务端完整race**：API298.829秒、config2.080秒、database11.818秒，421项pass、0fail。仅跳过非默认的历史契约生成器与两项需归档/专用exe输入的测试，后两项由真实归档runner另行执行；没有API因缺DB而skip。JSONL和逐项skip审计见`round16-server-real-race{.jsonl,-summary.json}`。较早未注入DB环境的28.887秒日志已重命名`round16-server-no-db-race.log`，不用于数据库或完整API证明。
- `pnpm build:server`、`CHORDV_BUILD_NUMBER=16 pnpm build:desktop`、两份当前源码Linux release构建、Node语法、gofmt/diff check、严格codesign、DMG verify、实际build-info与密封plist对照、普通包无e2e profile均通过。Windows amd64/arm64、Linux amd64原生test交叉编译/vet通过，不称实机。没有启动主服务/迁移主数据库。
- 普通App19,116,834B（约18.2MiB），DMG6,688,768B；二进制SHA256`6ba2added9f90dc0e845f6a70665579c353860fcb9da9a7fb3fade79f3a714d1`，DMG SHA256`086c61528296428a903720a609ab73c4177750f64be65e19873df77458228afd`；1.1.12/build16/local/macos/arm64，仍仅adhoc。普通macOS服务端0.0.34和两架构Agent清单锚均已实际验真，详见`round16-artifact-report.json`。缓存/并发条件下的耗时不与旧Tauri做不对等体积/速度结论。

### 清理与未完成边界

主App359、supervisor36715、API36763、Vite36795、PG12027的PID/启动时间不变；主public九表（本轮含PolicyProfile）整行摘要不变，私有schema最终0。宿主代理mtime epoch1791888658、size21576不变，自然样本ctimeNs1794859092178170591不变。最终无自有更新App/helper、health socket或更新挂载；临时private keychain文件全部移除，CGWindow可见SecurityAgent0，用户list/default与实验前逐字相同。主API36763仍旧运行实例，新backend产物没有替换或重启它；最新源码证明来自随机私有schema/API测试及实际归档HTTP，而不是旧主API。证据round16-environment-cleaned.json。审计包/源码和脱敏报告保留在忽略目录，不当进程残留。

真正自动journal恢复、可信intent/healthy seal、新父GUI退出交接仍未实现；本轮证据反而排除了一个不合格的授权方案。正式Developer ID/profile/同Team正控、公证、公开GitHub/镜像投递、旧Tauri过渡、Windows/Intel/旧macOS/跨机器实机和Linux root/systemd实际安装未验；Linux客户端系统代理明确未实现。宿主代理写入/恢复继续按用户明确不授权而不执行，不以隔离文件代理冒充。自然老化样本未动，最早仍11月18日03:58:13后验真实24小时。未提交、推送、发布、部署或创建自动化；完整迁移目标仍active。

## 17. 团队断连参数、工单凭据、组件取消与真实磁盘空间

继续本地业务一致性验收，不把旧回归通过当成所有handler已逐项等价。25个代码/测试/文档文件的绝对路径和逐文件说明见`.tmp/ui-qa/round17-final-report.json`；已有用户diff和ignored资产保留，没有提交、发布、部署或宿主代理写入。

### 团队断连非法输入不得触发真实操作

旧KickTeamMemberDto的IsOptional+IsBoolean允许true/false、缺省和null。新Go此前把其他类型静默转false，11种非法disableAccount都HTTP200并真实撤销租约/停用绑定/创建命令，真实admin SSE出现session_revoked和subscription_updated；字符串"true"不等于合法true，反而只断连不禁用账号。红测见`.tmp/team-kick-boolean-red.log`，旧DTO实际校验结果见同前缀legacy-contract.json。

修复仅`team_disconnect.go`入口专用类型检查，任何事务/写入前拒绝非null非bool，不改通用boolean或锁序。11负向HTTP全400，该私有schema48表整行摘要、事件sequence不变，真实SSE barrier无业务事件；true/false/缺省/null四正控保留，未知字段忽略、其他成员/最后管理员、跨订阅边界和双HTTP锁序既有控制均过。6项专项race26.008秒，public11表不变、15个记录内schema清零。索引`.tmp/team-kick-boolean-result.json`。

### 工单接入凭据恢复旧DTO/helper契约

实际执行旧397a64d精确DTO、真实Nest ValidationPipe、完整achord helper及applyConfigUpdate，42个边界样本不是源码猜测。Go原弱检查允许非ASCII/tab/错误类型等污染配置，NUL三例实际500，padded合法512字符凭据反而因raw长度被拒。新增专属`support_credentials.go`只归一baseUrl/clientId/clientSecret/webhookSecret：旧原始UTF16长度、精确JS trim（BOM可trim，U+0085不可trim）、ClientID≤191且无冒号、Secret≤512且仅非空可打印ASCII。未更改通用text/body和enabled字段；保持省略、null显式清除、启用前完整性、切换连接须轮换Webhook Secret等既有门禁。

最新33个负向样本HTTP400且设置整行/generation/epoch/未读/请求/事件摘要不变；6个地址/ID空值分支、191/512边界、trim、省略保留、Secret null清除及启用门禁控制通过。与既有接入/Secret轮换/Webhook顺序去重/旧工单迁移等12个顶层专项race46.431秒、vet和React接入设置回归通过。专属源码仅三文件，详见`round17-support-credentials-{completion.md,proof.json}`；初红样本扩展后负测数不同，不把初红21/23失败和最终33例混称同一矩阵。proof不含凭据正文，`round17-old-support-contract.json`只记录case/status。

### 下载取消在提交前保护旧组件

真实签名Ed25519清单与完整part恢复夹具红测：在verifying/extracting事件cancelDownload后，原实现仍覆盖旧组件/metadata、删除archive并发completed；不是“取消按钮有事件”就算通过。现在component取得operationMu后检查child ctx，接入唯一`copyAtomicContext`，分块复制、读取后和最终rename前都检查取消。旧copyAtomic接口只用Background委托，所有Mac helper/测试/Xray旧调用点已审，不保留两套复制实现；权限、fsync、临时文件清理语义保持。

8种direct/zip安装分支涵盖事件取消、真实Mutex等待后取消、正常成功、completed后取消；内部reader屏障实测首块已落暂存后取消，旧文件逐字不变且无temp残留；旧接口和正常复制正控通过。专项含既有component契约重复10次3.663秒、vet/diffcheck通过。证据`round17-desktop-component-cancel/{red.log,green.log,repeated-green.log,delivery.json}`。rename是明确提交点，之后取消不反报“旧文件保留”；metadata仍是独立写入，失败语义没有假称跨文件事务。提取/整体hash阶段不保证即时中断、已阻塞OS读需返回后观察ctx，但取消提交前不会覆盖安装目标。

### 恢复旧存储页实际可用空间

旧storage-catalog使用真实statfs可用块数，新Go此前永久写diskFreeBytes:null，导致现有“所在磁盘可用”行永不显示。真实私有schema HTTP扫描SSE红测确认null，不拿手写快照当完成。新Linux/macOS实现从已经打开的DataDir root目录FD做Fstatfs，以用户可用Bavail×Bsize为准；不重新按可能已改的路径选卷，不以文件容量或全盘Bfree冒充。乘法溢出或超JavaScript精确整数范围拒绝，失败保留null并加明确warning，不伪造0；其他服务端平台明确未实现。

扫描SSE complete、GET列表及持久snapshot包含同一真实数值；root路径被重命名后仍可查询既有FD同卷，closed root不产生假容量；精确乘法边界通过。专项race3.119秒，日志`round17-storage-space-{red,green}.log`。标准库实现，没有新生产依赖。

独立临时PG/API/Vite、正常Chrome登录→系统设置→管理文件→扫描，真实SSE complete显示可用空间，两条本轮新建真实文件仍受保护，未依赖旧主API。1000宽弹窗900，390宽弹窗351/页面scrollWidth390；新磁盘提示317宽正常换行，表格保留原有横向滚动可到“操作”列，清理按钮未误启用。主流程已人工查看正常和底部/横向滚动截图。

真实停自有API后500错误样本暴露另一布局缺陷：存储组件把完整JSON当错误文字，390下Alert client315/scroll339裁切。红图保留为`output/playwright/round17-storage/storage-390-real-api-error.png`，未因外框在界面内就判通过。root最小修复5个错误入口复用现有readError，仅补bare HTTP三位状态中文映射，具体后端业务说明和请求编号继续保留；仅存储Alert的局部CSS让body收缩、message断行/保留换行，不污染全局。新增15项实际组件初载/列表/扫描/操作/分页×3错误路径回归，加既有reader500/503/requestId红绿。

同一环境HMR、API仍停止的相同500样本复验：390 Alert315/315、内部283/283，1000内部816/816，中文错误完整可见、不再rawJSON，无横向溢出；旧扫描快照/磁盘行/表格仍保留，按钮不遮挡。主流程已查看两张fixed图，`round17-storage-alert-{390,1000}-fixed.json`记录实测宽度和局部CSS。恢复自有API后，重新扫描实际返回HTTP200/SSE complete，Alert数量归零并显示所在磁盘可用14.90GB；390和1000两张恢复图已人工查看。临时PG/API/Vite及Chrome均退出，临时根与凭据删除，三个端口均关闭，见`round17-storage-ui-proof.json`。UI使用Playwright Skill；当前无直接Computer Use运行入口可用，Jev桥未执行，不冒称插件缺失。

### 最终统一门禁与普通产物

- UI修复前`pnpm check`6/6、`pnpm test`102/102通过，日志`round17-{check,test}.log`保留。新增存储错误回归后从头统一重跑，最终`pnpm check`6/6、`pnpm test`103/103条命令通过，见`round17-{check,test}-final.log`；不是把旧全绿作为新前端验证。
- 显式真实Xray资产、CGO_ENABLED=1，普通原生完整race250.559秒、真正-tags=e2e完整251.886秒通过；`round17-native-{real,e2e-real}-race.log`。普通build17完整ChordV/React真实DMG更新健康专项race23.673秒（GUI22.37秒），无代理journal、回环API端口1不可达，见`round17-full-gui-health.log`。
- 显式数据库服务端完整race：API349.348秒、config4.087秒、database15.603秒，484项pass、0fail。仅skip历史契约生成器及两项需显式真实归档/专用exe输入；后两项在最新Linux归档runner另行实际执行，没有业务测试因缺DB而skip。JSONL和skip审计`round17-server-real-race{.jsonl,-summary.json}`。
- `pnpm build:server`、`CHORDV_BUILD_NUMBER=17 pnpm build:desktop`、两份最终源码Linux x64/arm64 release构建、严格codesign、DMG verify、实际build-info与密封plist对照通过。UI修复后再次执行`pnpm build:server`并重新构建Linux x64/arm64归档，最新包又完成临时签名/归档/真实HTTP Agent下载闭环，HTTP组2.889秒、固定exe定位0.05秒；`round17-build-server-final.log`、`round17-linux-{x64,arm64}-build-final.log`和`round17-agent-release-final.log`。Windows amd64/arm64、Linux amd64/arm64服务端测试交叉编译/vet，Windows两架构/Linux amd64原生测试交叉编译/vet通过；不当实机安装证据。所有构建不启动/替换主API，不把旧进程36763当新源码验证。
- 普通App19,133,250B，DMG6,675,456B，1.1.12/build17/local/macos/arm64；二进制SHA256`d34beca7ca7855e4d9a58ecf12744e71b4cac603ebe05eab8a8100a7fc95e0ba`，DMG SHA256`b768de5572bbdc5703f4fcf39df0b4ca186cff977df21e5a954af340576f821b`。无e2e profile，仍仅adhoc；实际服务端0.0.34和双架构Agent编译锚已验，`round17-artifact-report.json`。dirty HEAD只是同次构建元数据，不表示远端已包含修改；缓存/并发测试耗时不与旧Tauri做不对等对比。

### 清理与未完成项

最终环境核验见`round17-environment-cleaned.json`：主public11表整行摘要与本轮基线完全一致，测试私有schema为0；生产App359、主supervisor36715、API36763、Vite36795及PG12027的PID和启动时间未变。宿主代理配置mtime/size与基线一致，未写系统代理。自有更新进程、健康socket目录及更新挂载均无残留；存储UI三个自有进程已退出，临时根和凭据已删除，全部临时端口关闭。自然24小时样本ctimeNs仍1794859092178170591，本轮没有Keychain实验。当前API36763仍是原来的运行实例，没有以其冒充最终源码验证。

本轮仅存储Alert局部CSS与错误内容接线改动，实际双视口正常/故障态布局已复核；不把没改布局结构当跳过理由。旧弱凭据检查/平行复制逻辑已替换，无新生产Mock/依赖/测试开关。真正可信恢复授权及journal自动回放、正式Developer ID/profile/公证/同Team正控、旧Tauri过渡、Windows/Intel/旧macOS/跨机器实机、Linux root/systemd实际安装与公开GitHub/镜像投递仍未完成；Linux客户端系统代理仍未实现。已询问正式签名资源是否可提供，不发送/索取聊天中的私钥或密码，未收到资源不妨碍继续本地业务。宿主代理按用户明确暂不授权仍不执行；未再做Keychain实验或触发授权窗。自然24小时样本未改，最早仍11月18日03:58:13后验。完整迁移目标active，不标完成。


## 18. 完整冷启动、套餐安全契约、发行实物校验与GNOME代理

继续完整迁移，不以第17轮全绿替代剩余功能。第18轮逐文件索引与最终门禁见`.tmp/ui-qa/round18-final-report.json`；所有操作仅本地，不提交/推送/发布/部署，不改宿主代理/Keychain，不重启现有生产App及主API/Vite/PG。

### 启动期取消不能遗留自有数据库

实际独立源码快照从空目录运行supervisor，在创建真实PG日志后发送SIGTERM：旧一次性shutdown先把stopping置true，database句柄却尚未返回，后续catch再次shutdown直接返回，30秒后supervisor和自有PG仍存活。原真实探针与隔离重放均观察到该缺陷；`round18-supervisor/startup-stop-red.json`记录明确自有PID及目录，测试只停止这些自有对象，不按进程名清理其他PG。

`mygo-local.mjs`改为可重复收尾、每个已启动子进程只关闭一次，禁止停止后新增构建子进程，数据库句柄返回后再次纳入收尾；`mygo-local-db.mjs`的stop共享同一Promise，启动失败也等待PG退出后关闭日志。两个真实启动期SIGINT/SIGTERM回归和已有空库重启/并发重复stop均通过。绿探针supervisor正常结束取消分支、自有PG退出，四个测试端口释放，无构建manifest；不是只测内存布尔值。初始化中的外部initdb命令不保证即时中断，但完成后会停止自有数据库，不宣称SIGKILL/断电恢复。

完整独立快照另用真正`bash ./start.sh --create-admin`创建一次性管理员，随后两次普通`bash ./start.sh`从同一隔离数据重启：正常凭据HTTP登录、实际后台HTML、health 0.0.34、两架构Agent下载SHA与同次manifest一致、真实创建节点及安装脚本HTTP200/绑定版本与两架构SHA、bash -n、错版本404均通过。每次SIGTERM后API/Vite/PG及四端口均退出；最后根/凭据删除。未执行安装脚本、未root/systemd安装；复用依赖缓存不冒称全新联网安装。第一轮探针错用`/api/admin/auth/login`得到404，纠正为真实既有`/api/auth/admin/login`后完整重跑；首错和退出时Vite EPIPE保留，不改生产路由迎合探针。证据`round18-supervisor/cold-start-proof.json`及`cold-start-first-wrong-route.*`。

### 套餐安全PUT只修改安全字段

旧UpdatePlanSecurityDto及精确service读/写/catch分支用真实Prisma6.19.2、原Plan DDL和随机私有schema执行37样本：19个200、15个400、3个503。不冒称整个旧Nest/异步供给服务；首次VM跨realm Number未转换的错误证据另存并排除，修正后完整重跑。

新Go原先共用套餐编辑入口，PUT可夹带name/scope/renewable/isActive/totalTrafficGb修改套餐，缺省也200写入发事件；合法数字串和101反而拒绝。现仅PUT专属归一并剥除额外字段：必填、有限数且>=1；按真实旧Number转换保留true/数字串/科学/进制字符串，按实测Prisma行为对正分数截断。旧int32越界返回503，先保留不存在套餐404；普通POST/PATCH原1..100校验不变，通用number/事务和会话收敛逻辑未另建一套。21组拒绝逐次比较全48表摘要及真实SSE barrier零业务事件，18种旧合法输入、夹带字段白名单、普通编辑/404和真实3会话降至1的最旧逐出正控通过。5顶层专项race9.158秒、vet通过；证据`round18-server-contract/round18-server-report.json`。

### 正式发行验证实际安装包，不信任改名或外置描述

旧stageDesktop接受普通真实local DMG并按调用者99.0.0重命名为正式资产，SHA正确却未检查实际版本/build/mode/架构。新Go linker buildID记录规范version/build/mode/platform/architecture/真实HEAD，已实证与trimpath和原ldflags兼容；它是受平台签名保护的元数据，不是独立信任根，dirty HEAD不代表远端含未提交源码。

macOS stage只读挂载真正DMG，检查唯一固定ChordV.app、密封plist、真实Go包/CPU/CGO/内嵌身份和严格codesign；正式stage还强制DeveloperID与stapler。Windows只在对应runner校验installer/source/payload有效Authenticode及同签名者，固定7z仅输出固定ChordV.exe成员，真实PE/Go身份与同次源exe字节摘要一致，不执行候选或把任意归档路径落盘。stage descriptor→签名manifest→publisher再次绑定同一build/source/target，缺验证硬拒绝。

实际完整MyGo ad-hoc release身份App+DMG内容正控通过，错版本/build/mode/架构/提交均拒；普通local改成正式文件名仍拒，进一步完整构建正式App名/密封plist mode=release、二进制身份却local的DMG，明确mode mismatch，证明不是只靠名字/plist。该ad-hoc正控进入正式stage仍拒DeveloperID，未调用notary/Keychain。四目标Mach-O/PE静态读取与Windows source/payload摘要对照另验，发行专项29/29通过；Windows实际NSIS7z/Authenticode成功路径及正式签名公证仍未验。临时完整包与只读挂载均清理；证据`round18-release-audit/completion.md`与`full-mygo-package-proof.json`。

### Linux补GNOME设置适配，保留实机边界

旧非Mac/Win适配直接返回未支持，且用整个/proc/PID/stat作进程身份，CPU/内存等计数变化就无法识别同一进程。现Linux专属读取PID/starttime及boot-id，正确跨comm空格/括号解析，exe另验。GNOME桌面登录用户验证专用运行目录UID/0700与本地D-Bus会话，只调用固定gsettings schema/key、参数数组和有界超时；未知桌面/KDE/root/缺组件明确拒绝。watchdog仅Linux保留所需会话环境，不传HTTP_PROXY等变量；不读/存认证密码，带认证代理拒接管。

GNOME快照保留原GVariant字面量和忽略列表，写前预检policy、mode先none、逐字段对照/读回、目标mode最后提交；取消/部分失败只尝试恢复本次可证明自有状态，外来字段或恢复失败保留journal且不杀进程。root复核又红测出“已经恢复原状态但mode被策略锁定”仍报失败/无谓切模式，补真无操作分支，none/manual/auto三模式正控通过。gsettings多字段CLI没有跨应用原子CAS，check→set间竞争窗口没有被伪称消除。

真实Homebrew GLib gsettings配官方GNOME schema、强制keyfile及独立HOME/XDG_CONFIG_HOME完成接管/逐字恢复、部分写失败恢复、认证拒绝与不执行字符串文本；没有宿主DBus或系统代理写入。root最终专项race9.819秒含幂等修复；纯解析/模型及两架构Linux测试交叉编译通过。真实Linux执行请求一直没有分配容器ID、无测试输出，检查仍活跃后只取消本轮3个确切Docker客户端；未启动/重启daemon、未动既有容器。空CID/日志不算Linux runtime成功，生产GNOME/dconf/独立watchdog与KDE实机仍未完成。证据`round18-linux-proxy/root-final-keyfile-race.log`、`idempotent-restore-red.log`及`owned-docker-clients-stop.json`。

官方契约核对：[GNOME代理schema](https://github.com/GNOME/gsettings-desktop-schemas/blob/master/schemas/org.gnome.system.proxy.gschema.xml.in)、[Linux proc字段](https://www.kernel.org/doc/html/latest/filesystems/proc.html)。官方schema已下载到本轮证据目录；proc文档第二次抓取429，没有当成新成功抓取证据。

### 最终门禁、产物与边界

- `pnpm check`6/6；最终`pnpm test`103/103条命令通过，日志`round18-{check,test}-final.log`。首轮全量102/103因新启动测试继承了主验证器的数据库环境，尚未启动目标私有PG即被目录校验拒绝；只修测试子进程显式覆盖本次三项凭据，所有断言保留，继承主环境19/19和最终全量从头重跑通过。首错保留`round18-test-first-isolation-failure.log`，不改写为成功。
- 显式真实DB完整race：API362.044秒（JSON包pass362.045）、config3.973秒、database16.240秒，489pass/0fail；三个明确opt-in skip仍是历史生成器和真实归档/固定exe两项，后两项已由最新供给runner实际另验。JSONL/审计`round18-server-real-race{.jsonl,-summary.json}`。
- 真实Xray资产加显式官方GNOME schema，普通native完整race265.131秒，真正-tags=e2e完整257.391秒；普通build18完整GUI原生+React健康ACK race26.694秒（GUI25.06），API回环端口1、无proxy journal。Windows/Linux两架构native/server测试交叉编译及vet通过，不作为目标OS执行证据。
- 最终`pnpm build:server`、`CHORDV_BUILD_NUMBER=18 pnpm build:desktop`、Linux x64/arm64 release构建、真实临时签名/归档/HTTP Agent供给均通过；供给HTTP组6.401秒、固定exe0.05秒。普通MyGo打包阶段8.8秒仅当前缓存/并发条件，不与旧Tauri或此前19.1秒作不对等提速比较。
- 普通App19,133,538B，DMG6,678,016B，1.1.12/build18/local/macos/arm64；binary SHA256 `459037cd46d0af3a5a5f0708c76ea114c3313d14e62e8dcd3d5409518f1d9945`，DMG `ef5d0f977393207d6f3c41fbb5f3463602b3829134a8dc00e38969d3d4a990e7`。密封plist/早退构建信息/Go linker身份一致，strict codesign及DMG verify通过，仍仅adhoc。最终server0.0.34 SHA256 `ffd554c0e406b138c5c4c81c37a9ce940a7119d4a22d8f23fa8a2c645c59a902`，详见`round18-artifact-report.json`。

产物信息探针首次错误使用`--build-info`，启动了本次普通Local包PID8899，而不是读取早退信息；未操作现有App359。确认仅本次精确可执行文件/启动时间后，TERM未退出才停止该自有PID，且只移除实际新建的空Local配置目录和无打开者的私有socket；无会话/代理journal、主环境指纹未变。记录`round18-artifact-first-wrong-argument.json`。重新核对源码后使用桌面`--chordv-build-info`、服务端`--version`，显式私有数据目录/回环端口1/5秒上限，早退未创建目录；不把首次误启动当元数据验证通过。

本轮没有前端组件/CSS修改；仍审阅布局调用影响，统一测试包含现有双视口浏览器回归，普通build18另有完整真实GUI首屏/更新健康验收，不把仅HTML可访问当渲染通过。旧一次性shutdown和PUT误共用逻辑已替换；无新生产Mock/依赖，保留原有用户diff和ignored真实Xray资产。

最终`round18-environment-cleaned.json`确认主public11表整行摘要与本轮基线一致、测试schema0；生产App359、主supervisor36715/API36763/Vite36795/PG12027的PID与启动时间不变。宿主代理mtime/size与基线一致；本次runtime进程/目录、更新验证挂载均为0，冷启动凭据与根已删除。自然样本ctimeNs仍1794859092178170591。普通包编译没有替换运行中主API，不把旧实例当最终源码证据。用户已明确“暂不提供，继续本地开发”，因此正式证书/profile/公证验收保留未完成，不继续等待资源、不降低生产发行门禁。

完整目标仍active：可信intent与更新journal自动回放、正式DeveloperID/profile/公证、旧Tauri过渡、Windows/Intel/旧macOS/跨机器及Linux GNOME/root/systemd真实安装、公开GitHub/镜像投递尚未全部完成。系统代理按用户明确暂不授权不执行；用户暂不提供正式资源，继续本地开发，不开展新的Keychain实验。自然24小时样本仍未到11月18日03:58:13，不改样本/ctime/时钟，不建自动化。


## 19. 组件成对恢复、Linux实际运行、节点PATCH与旧版过渡实证

继续完整迁移，只本地调试。用户仍明确暂不授权宿主系统代理写入、暂不提供正式签名资源；不重启现有App/主API/Vite/PG，不提交/推送/发布/部署。逐文件和最终门禁索引为`.tmp/ui-qa/round19-final-report.json`，不能用此轮局部完成替代整体目标。

### 组件文件与校验记录必须成对可恢复

真实临时Ed25519签名清单和完整part恢复红测：metadata路径为目录时，旧实现先覆盖已安装文件，随后写记录失败，最终报失败却丢掉原文件。证据`round19-component-commit/red.log`。不以“后续校验会失败”替代保护原资产。

现下载在operationMu内先准备文件/记录、原版本同目录硬链接备份及持久intent，再进入两个rename的成对提交。不是宣称两个普通rename就是OS级原子事务：中断窗口由固定kind恢复协议封闭；pending存在时组件记录读取明确拒绝ready，连接也不能跳过。每次启动及下一次安装先处理已有pending：完整旧对仅清准备资料，完整新对保留新版本，单边新/旧混合恢复旧对，初装中断恢复为缺省。真实子写进程在准备后/仅文件/完整对/仅记录四阶段exit23且不跑defer，另一个真实新进程启动恢复；旧版本、metadata字节/权限及inode都保留，初装和已有版本共8个分支。

新元数据先准备，错误在替换前发现；提交前取消保留原对，文件rename后即使取消也完成/恢复整对，不把新文件配旧记录。恢复重新核对当前确认清单receipt；direct文件绑定签名SHA/大小，zip另复核保留的签名压缩包和唯一entry解压SHA/大小，不信任journal里自填installed SHA。错误签名、伪造direct/zip内容、压缩包变更、备份篡改、外来当前文件/记录、符号链接或未知work文件均拒绝，保留资料，不改外来文件。路径操作基于Go os.Root，只有固定bin/kind/协议文件；不递归清理未知数据。进程退出恢复不等于断电实机验证；Windows目录fsync未实现、不宣称跨平台掉电耐久。同目录硬链接不可用时在替换前失败，不悄悄改用会丢原inode/ACL的备份。

9个顶层专项race16.159秒通过，包含原第17轮8种取消/成功分支；完整普通/e2e另验。测试重命名失败接缝仅为内部Go函数参数，没有生产环境开关或远端调用。原copyAtomic接口及唯一分块复制函数保留，字节复制未并存两套；组件安装不再直接“copy目标→写metadata”。证据`round19-component-commit/summary-proof.json`。这是托管组件恢复，不是签名App自动intent/journal恢复授权，不能混称后者已完成。

### Linux实际执行，不拿交叉编译当运行

已证实本机现有Docker daemon可执行无host bind的独立容器；之前挂起请求的根因未进一步认定，不能仅凭无输出断言Linux执行器不可用。没有启停daemon、没有拉镜像、没有挂载宿主home/项目/DBus。使用现有postgres:16固定image ID、network none、只读根、65534非root和独立tmpfs，通过stdin仅送测试二进制进入自有/tmp。容器名/ID记录，逐个精确停止删除，原有容器保持不动。

旧Linux完整/proc/stat作为身份的真实红：分配内存后内核stat计数变化，同一PID被误认；旧GNOME desired三模式也拒绝。当前最终源码实际Linux arm64执行转绿：PID/starttime/boot-id稳定、exe路径读取、非GNOME拒绝、GNOME模型/幂等恢复、全套组件成对恢复及新进程退出恢复均通过。`TestGNOMEActualGSettingsIsolatedKeyfile`在该镜像因没有显式schema而skip，不能当Linux桌面dconf测试；真正GLib独立keyfile仍由Mac专项显式官方schema另验。证据`round19-linux-runtime/{execution-proof.json,linux-red.log,linux-green.log}`。最终Linux二进制来自当前native源码，前轮旧二进制仅作红对照；无宿主代理写入。

### 节点PATCH完整恢复旧输入和保存条件

旧DTO/helper/保存表达式75样本实证19接受/56拒绝；新Go曾接受字符串/数字bool落库，却不进入相应撤销/同步分支。现只在Node PATCH前置7字段白名单/严格类型/显式null拒绝；name/provider/tags精确JS trim、空标签推导、国家/区域正规化及完整旧启用就绪条件恢复。只有实际isActive转换触发撤销/同步，空/仅额外字段不写库不发节点事件；同值显式字段按旧Prisma实际保存行为处理，不把它与缺省混同。实际停用→会话撤销/账号停用→HTTP Agent回执→重新启用/ENSURE_USER通过，不把观察器合成负控当物理Xray执行。

国家数据由当前共享countries.ts+锁定ISO7.14.0生成750代码/534名称/102多字符大写展开，附来源SHA和MIT许可；非ignored的`mygo-node-country-data.mjs`默认/--check只读，--write显式重生成，现有tsx/TypeScript执行当前共享源码，不依赖已退役API或缓存绝对路径。源码/锁版本/原始ISO输入/实际映射漂移均会失败，统一check/test接入此检查。root复核发现不能将本机Node25的Unicode版本字符串作为CI要求，于是去掉非语义运行机元字段而仍逐项比较实际映射；Node20.19.0（项目.nvmrc）、24.22.1、25.5.0真实检查和5项回归均通过。Node20仅从官方固定包+官方SHASUMS核验后在临时目录运行，未安装或改系统PATH，已清理；root另一次重复下载发生IncompleteRead没有作为通过证据。

初始7项Node专项race32.368秒、56非法字段+10就绪拒绝、全48表摘要、真实admin/client SSE与8类事件观测负控通过，全部国家和Unicode边界对照。最终全量普通测试又实际发现replay多出1而SSE无事件，不能把该全量103/104说成通过：日志保留`round19-test-first.log`，先记录确切事件再修根因，最终记录见本节末。Node专项完整原证据`round19-node-contract/round19-node-report.json`。

### 全量暴露跨schema命令通知污染，修生产作用域而非放宽观察器

首次普通全量103/104时，拒绝请求仍400、48表摘要不变、admin/client SSE为空，但replay序列多1；首错未打印多出的原文，不冒称首错正文已直接记录。随后用两个真实私有schema相同nodeId、同schema第二Server及只通过PG通知的屏障，实际复现双向foreign command_ready。再以两个独立测试进程各10次并行，精确重现400/全48表不变/SSE=[]而replay含另一进程nodeId的command_ready；不是presence计时器问题。红证据`notification-scope-red.log`及`observer-concurrent-red-{1,2}.log`。

根因是PostgreSQL LISTEN/NOTIFY频道为数据库级，而原生产逻辑所有schema共用chordv_go_agent_commands，foreign提示被写入本schema内存hub。现producer在当前queryer/事务、listener每次acquire和重连都使用同一数据库表达式：public保留原频道，其他schema为固定前缀+md5(current_schema())，私有频道57字节，LISTEN通过pgx.Identifier转义，payload仍原nodeId。只读事务核对public兼容，没有向主public频道发送测试通知、不重启旧主API。非public旧实例仍监听原频道，若实际部署多实例私有schema须同批升级/重新监听；不宣称跨版本私有频道兼容。

同ID跨schema双向负控、同schema第二Server真实Agent SSE交付正控、唯一测试application_name的listener专属backend断开后持久catch-up和随后新命令交付均通过；不按通用进程名关闭任何主连接。Node拒绝测试保留全作用域replay和双SSE断言，没有忽略command_ready，也没有调整presence时序赌绿。最终10项Node专项race、并行压力和完整门禁见本轮补充报告与本节末。修复前共享频道可能已向旧主本地hub投递提示，主数据/主PID不变不代表其全部内存状态未变；修复后私有新频道不再通知public。

### 旧版自动升级：证实安装协议不兼容，生产继续封锁

从397a64d真实Cargo.lock/Windows更新入口/旧安装模板核对，官方tauri-plugin-updater2.11.0与minisign0.2.5源码包SHA逐字节匹配原锁。仅旧Windows注册官方插件；Mac旧发布未用它。官方CLI2.10.1临时key签当前完整MyGo build18真实包，原锁编译的真实官方库完成check/download验签、篡改拒绝、临时Installed.app tar替换；同签DMG虽下载验签通过，install仍拒绝且原临时marker不变。BSD tar默认AppleDouble条目还真实造成红，COPYFILE_DISABLE=1且单一.app根后转绿。未执行候选App、未碰系统安装目录/Keychain/正式私钥，不把Mac库实验称旧Mac用户升级。

已确证Windows NSIS缺口：旧库传/P /UPDATE /R /ARGS、旧默认LocalAppData/ChordV与Uninstall/ChordV；MyGo默认Programs/ChordV与Uninstall/app.chordv.desktop且未解析这些旧参数。只有旧Minisign签名不能解决路径、注册表、静默更新/重启/参数转发或旧别名清理；实际Windows安装矩阵7组未运行。因此生产端点仍无条件204、stage无论key有无均disabled、签清单和publisher拒绝任何legacy条目/verified:true，不能自声明解锁。Go投影/包络原型只留明确_test.go，没有生产平行旧栈或可任意换key配置。正常新客户端仍以GitHub唯一真相更新，不恢复发布中心。

发行专项27/27、Go兼容端点专项race1.732秒/vet通过。真实库原始记录、Windows逐项可执行矩阵、12文件说明在`round19-legacy-transition/completion.md`及`actual-old-plugin-proof.json`；资源已清理。结论是阻断原因已验证，不是旧用户生产自动迁移完成。

### 最终门禁与普通产物

- 最终`pnpm check`7/7、`pnpm test`104/104条命令通过；首轮103/104日志保留`round19-test-first.log`，修复前完整race498pass另存`round19-server-before-scope-race{.jsonl,-summary.json}`，不冒称这些是通知修复后的最终源码。
- 通知修复后显式真实DB完整race：API383.333秒、config1.965秒、database8.345秒，501pass/0fail；3项明确opt-in skip仍为历史Prisma生成器、真实归档及固定exe，其中后两项已由最终供给runner另行实际执行。`round19-server-real-race{.jsonl,-summary.json}`记录完整结果；JSONL按LF解析，合法JSON字符串内的Unicode NEL不能用Python splitlines误拆成两条记录。
- Node专项10/10 race35.848秒；三个并行组普通拒绝20次、race拒绝10次、隔离/public只读/重连各5次全部exit0，所有自有句柄收取终态，无放宽业务事件断言。详见`round19-node-contract/round19-notification-isolation-report.json`与最终10文件SHA。
- 真Xray资产及显式官方GNOME schema下，native普通完整race263.423秒、真正-tags=e2e完整race279.514秒；通知修复只改server，不重复声称native长测重跑。普通build19完整真实GUI原生+React更新健康race27.719秒（GUI25.44），API回环端口1、无proxy journal。Windows/Linux两架构native/server测试交叉编译及vet最终通过，不当目标OS实机运行证据。
- 最终`pnpm build:server`、Linux x64/arm64 release重建，以及`node scripts/mygo-agent-distribution-e2e.mjs`全部通过；真实临时签名/归档/HTTP供给组8.092秒、生产固定exe分支0.09秒，未安装root/systemd。`round19-backend-final.log`、`round19-agent-release-supply-final.json`为通知修复后产物；先前供给7.669秒不混称最终。
- 普通桌面`CHORDV_BUILD_NUMBER=19 pnpm build:desktop`生成App19,216,354B、DMG6,685,184B，1.1.12/build19/local/macos/arm64；binary SHA256 `39a55e422ad543585abb049ecae6033d878e8c75e2fda096606b2fdf85c5e844`，DMG `e731f4e75755fa7fcccfca22cb4e274ee32566fa84d5bf562450f05788546d1e`。密封plist/早退信息/Go linker buildID一致，strict codesign与DMG verify通过，仍仅adhoc。MyGo打包阶段19.2秒只代表当次缓存/并发条件，不作Tauri不对等性能比较。
- 最终server0.0.34 SHA256 `3edcfe9861c882cc5bfec91024f8e49cd101f94e07b64bfbf061bbeb6e5fae10`，Agent manifest SHA256 `69f126e2cd59e6693167c4c1cb98cfb08c29af5e9bd7b6740b80959f7408d5c3`；`round19-artifact-report.json`。服务端重建未替换仍在运行的旧主API；dirty HEAD元数据不证明远端提交包含本地改动。桌面源码未受通知改动影响，未无谓重建已验普通DMG。

本轮没有React组件/CSS改动；仍审查布局影响，沿用既有启动错误/下载进度/恢复失败正常流呈现，统一测试继续运行现有真实浏览器布局回归；普通build19另有完整真实原生+React首屏更新健康验收，不拿只读HTTP HTML代替渲染。没有新增生产依赖/Mock，不手改用户ignored真实Xray资产。测试中的公开签名、临时provider和内部故障接缝均隔离在测试/本轮证据，不进生产逻辑。

最终`round19-environment-cleaned.json`确认主public11表整行摘要与本轮before一致、测试schema0；生产App359、主supervisor36715/API36763/Vite36795/PG12027的PID和启动时间均不变。宿主代理mtimeMs1791888658550.031/size21576与基线一致；本轮两个确切自有容器均已删除、更新只读挂载0，全部root及agent验证句柄已收取终态。临时签名私钥/应用/供给归档目录均由各runner finally清理，没有新Keychain实验、推送、发布或部署。共享NOTIFY修复前可能已触达旧主本地内存hub的边界如上保留，不笼统宣称全部内存状态未变。自然样本ctimeNs仍1794859092178170591，未改内容/权限/时钟。

完整目标保持active：真正可信App intent/自动更新journal回放、正式签名公证/旧Tauri Windows实机迁移、GNOME用户桌面dconf/宿主代理及跨机器/Windows/Intel/旧macOS/root-systemd实际安装、公开GitHub/镜像投递仍未全部完成。用户暂不提供证书，继续本地开发，不再等待/索取正式资源、不放宽发行门禁；宿主代理仍不执行写入。自然24小时样本最早11月18日03:58:13上海，未改ctime/内容/权限/时钟，不建自动化。


## 20. 真实Linux dconf/独立watchdog、新建节点契约与Windows安装边界

继续本地重构；不把之前已完成的第19轮复述当新进展。本轮不触碰线上、宿主系统代理、Keychain或现有App/主API/Vite/PG；用户暂不提供正式签名资源，不再次索取。逐文件最终索引`.tmp/ui-qa/round20-final-report.json`。

### 真实dconf发现会话profile丢失，最小修复而非换存储兜底

使用本机既有固定postgres:16 arm64 image，创建独立builder仅安装官方发行版glib/dconf/dbus/GNOME schema包，再commit到本次专用image。最终runtime network none、只读根、65534非root、独立tmpfs及init reaper，不挂宿主home/项目/DBus，不启停daemon或原有容器。测试二进制仅通过stdin送入自有/tmp；每项用dbus-run-session新建总线、独立HOME/XDG_CONFIG_HOME/0700 XDG_RUNTIME_DIR以及只含user-db:chordv_integration的自有profile。不是keyfile模拟，也不是完整图形GNOME桌面。

旧生产gnomeSessionEnvironment丢弃DCONF_PROFILE；真实gsettings在指定profile已写mode auto/http8181，但原linuxGNOMEBackend读到默认user库的none/http8080等默认值，真实红在`round20-linux-dconf/profile-red.log`。现仅在原白名单保留DCONF_PROFILE，让生产gsettings与独立watchdog使用与桌面会话一致的profile；仍强制dconf，未允许HTTP_PROXY/GSETTINGS_BACKEND或任意环境全量透传。profile中的换行/NUL等按既有检查拒绝。

真实Linux最终六个顶层测试含一个子进程helper，实际五场景：会话profile、接管/逐字恢复、真实takeProxy→startProxyWatchdog→生产main子入口的EOF恢复和精确自有target退出、真实holder被SIGKILL后内核pipe EOF→独立watchdog恢复与target退出、外来http.host修改保留且有限重试后journal/error保留并不杀target。SIGKILL场景通过/proc精确子进程参数与PID/starttime/boot-id/exe绑定，pidfd内核退出事件等待，不按名字杀进程或用业务轮询猜退出。成功后确认指定dconf数据库存在、默认user库不存在。

最初夹具误用带连字符的dconf数据库名称，造成D-Bus object-path断言超时；修成chordv_integration后才取得上述产品红测，初错保留`profile-red-initial-invalid-db-name.*`，不算产品缺陷。初轮容器PID1仅sleep，退出的会话进程成zombie；该确切容器已删除，最终改--init，终态ps仅docker-init/sleep及检查自身，无dconf/watchdog/target或zombie。所有确切builder、两代runtime及本次child image已清理，原固定image仍保留；`cleanup-proof.json`及`extra-cleanup-proof.json`。

新增Ubuntu isolated dconf/race CI job，不运行GUI或访问宿主会话；本地Linux实际执行非race，Mac模型专项race1.826秒，不能冒称新workflow已远端跑过。完整native真Xray+显式官方GNOME schema普通race267.469秒、e2e race274.922秒均通过。证据`round20-linux-dconf/summary-proof.json`。D-Bus隔离做法对应[官方dbus-run-session说明](https://dbus.freedesktop.org/doc/dbus-run-session.1.html)，profile语义对应[GNOME配置说明](https://teams.pages.gitlab.gnome.org/Websites/help.gnome.org/system-admin-guide/dconf-profiles.html.eo)；工具无法open时未把它当新抓取成功，查询返回的官方说明和容器实际行为交叉核验。

### 新建Agent节点入口的旧DTO和实际保存语义

本轮不是重复Node PATCH：对应POST /api/admin/nodes/agent-native。读取397a64d真实CreateAgentNodeDto、原服务前三段校验/normalizePanelInbound及node.create.data表达式，以真实class-validator/validator.js执行96样本（34接受/62拒绝）；没有把这称整个Nest HTTP/Prisma/令牌链实跑。先前Go只检查name，错误isActive/recommended类型、panelInbound标量和超长元数据会200创建Node+AgentRegisterToken并发事件，nullable/default/trim也不一致，真实HTTP红3项2失败保留`round20-server-contract/red.log`。

现仅新建入口调用专属归一：严格字段类型、IsOptional显式null、country/region/provider长度、标签每项长度，名称先validator.js呈现序列计长后服务UTF-16 trim长度；JS trim不误删NEL，FE0E/FE0F与emoji边界按旧实证。tags原空串/空白/重复保留，不强行套用PATCH标签规则；country缺省null、地区/服务商未指定、recommended缺省false；isActive即便合法true也不提前激活。panelInbound顶层对象与原rotateKeys:true拒绝恢复，既有内部normalizeInbound及本地地址隔离未改，不将此专项夸大成整个旧panel内部helper等价审计。

4项真实HTTP race7.777秒、普通-count=5共20项8.523秒通过；62非法请求每次全48表整行摘要不变、eventHub序列不变、真实管理员SSE经唯一marker屏障零业务事件。10组nullable/default/Unicode合法创建每次单节点+单令牌摘要/前缀、24h有效期、不存明文及一次node_access_updated；白名单外字段不落库、实际HTTP注册仍待入站校验才能启用、原本地合法panel正控通过。仅三源码文件，原缺省补丁循环已替换，无新依赖/生产Mock；27个明确自有schema清理，主public11表摘要不变。逐文件SHA与证据`round20-server-contract/round20-server-report.json`。

### Windows实际完整NSIS包接入受限兼容，不能据编译绿解锁旧升级

本轮实际新增7文件：构建资源owned列表生成器、installer/paths/registry/install-actions四个NSIS模块、默认可发现Node专项，以及正式Windows build入口接入；Local身份和其他平台不接管旧安装。仅从构建时精确资源生成删除权限，拒绝符号链接/非普通文件/保留名/大小写路径冲突/ADS，不信安装目录内可改写清单。路径只接受本用户profile独立应用根，逐级拒绝reparse point；旧/新HKCU32/64视图只认完整已知键、DisplayName/MainBinaryName/根/精确UninstallString，歧义拒绝，不猜默认位置或执行旧卸载器。

可确认旧安装必须显式/UPDATE，受限/S /UPDATE /R /ARGS实现与原quote-aware GetOptions同源，原始命令行保留/D=，超长拒绝；旧默认/P明确退出2，不悄悄映射/S，因为锁定MyGo0.9.1 include位于MUI页面声明后，passive页面语义未实现。原更新互斥及有限可写等待保留，不新增按名全机杀；MyGo原CloseApp按安装根前缀识别实例后优雅关闭/超时强制退出。历史exe别名限定同目录刷新到新主程序，成功才退旧注册表，只删三项已知bin seeds，不递归删旧数据。

卸载un.onInit在MyGo删快捷方式/新键之前先核对；customUnInstall仅Delete编译内owned文件及非递归空目录，Return让模板末尾RMDir /r不可达。真实默认MyGo完整baseline包和最终hook完整Windows/amd64包均已用本机makensis3.11真实编译，并保存原始NSIS/-PPO展开作对照；默认缺/P处理且会递归卸载，新包有/P拒绝及Return控制流。6项新测试和桌面联合12/12通过。baseline NSIS6,707,484B，最终6,715,738B（增8,254B）；实际exe同为19,451,392B。最终NSIS SHA256 ef3e8aa8958ea139e4e8c705c4ed4d584d7ad5046a994d82b74028c4f1fb88f4；独立unsigned/local内容夹具不能发布，不与Tauri作不对等速度比较。

严格边界：没有Windows动态运行，/P仍未支持，实际旧官方调用不满足，因此旧自动过渡没有完成。复制/新键写入先于customInstall，后续别名失败可留下新旧键/部分payload，未实现跨文件/注册表事务回滚；卸载模板也先删快捷方式/新键再进入收尾，未冒称失败可回滚。路径检查不是抗同账户并发替换的句柄事务，Exec返回不是新App健康；profile外自定义路径、真实参数转发/快捷方式/卸载数据Hash/双安装/取消/磁盘满/权限/Windows ARM64均未验。正式签名检查和旧端点204/stage disabled/publisher拒绝非空legacy仍未改，不能拿content fixture或verified:true解锁。

源码写入疑点经mtime/实际patch范围复核均落代理自身写入，无外部写入证据，快照保留且未回滚。最初toolchain缓存定位及-PPO保留注释的证据断言错误都保留，最终实际完整包从头重跑；主流程首次check与Windows MyGo临时syso生成/删除并行导致vet引用已删syso，6/7失败已收终态，保留`round20-check-first-concurrent-build.log`，不改产品迎合错误编排。代理停写/全部构建终态后，主流程再串行Mac build20→GUI→check→test。详细逐文件/命令/未验`round20-windows-transition/completion.md`及source-final.sha256；临时config/wrapper/bindings/syso均清理。

### 最终门禁、产物和边界

- 全部源码冻结和所有MyGo构建终态后严格串行完成Mac build20→真实GUI→`pnpm check`7/7→`pnpm test`104/104；首轮并发syso错误保留，不算最终绿。统一test默认发现新Windows6项（本机makensis实际运行），未以静态测试替代Windows动态验收。`round20-{check,test}-final.log`。
- 显式真实DB完整race：API375.130秒（JSON包pass375.131）、config2.151秒、database11.777秒，505pass/0fail。3项明确opt-in skip为历史Prisma生成器/真实归档/固定exe；后两项已由最新真实供给runner另行实际执行。`round20-server-real-race{.jsonl,-summary.json}`；按LF解析JSONL，不误拆合法字符串中的Unicode NEL。
- native真Xray+显式官方GNOME schema完整普通race267.469秒、真正e2e race274.922秒；build20真实完整原生+React更新健康race25.849秒（GUI24.20），API回环端口1、无proxy journal。Mac模型race1.826秒和真实Linux非race dconf五场景另验；Windows/Linux两架构native/server测试交叉编译与vet最终通过，不当目标OS执行证据。
- 最终Mac backend与Linux x64/arm64 release重建、实际临时Ed25519签名/真实归档/HTTP Agent供给均通过，HTTP组7.142秒、生产固定exe路径0.07秒；未运行root/systemd安装。证据`round20-backend-final.log`、`round20-agent-release-supply-final.json`。后台JS大于500kB chunk警告仍保留，不调高阈值或顺手重构。
- 普通Mac App19,216,354B、DMG6,685,184B，1.1.12/build20/local/macos/arm64；binary SHA256 `743c5900b1019baadfac5e8361dfccdaa0c7abeb383692976bf74886b878a7c1`，DMG `d41d28f406d44434c078680c03e9547c4200c8cd8ad7bb66217ce0c56bf02b55`。密封plist、早退信息及linker身份一致，strict codesign/DMG verify通过，仅adhoc。MyGo阶段8.1秒属于本次缓存/串行条件，不与前轮并发19.2秒或Tauri对比。
- 最终server0.0.34 SHA256 `486b37770e8dae976df1fef6450d6a8100f59239c1fcbc84a2b2b6ad5656cdf4`、Agent manifest `69f126e2cd59e6693167c4c1cb98cfb08c29af5e9bd7b6740b80959f7408d5c3`；`round20-artifact-report.json`。内嵌dirty HEAD仅本地元数据，不表示远端已包含未提交变更。

本轮无React/CSS改动，已检查既有恢复错误/创建入口/构建改动的布局影响；统一真实浏览器回归与build20完整GUI首屏健康通过，Windows安装器可视布局无运行环境未验。旧创建默认循环被专属归一替换，GNOME复用单一白名单和生产代理链，installer复用MyGo扩展而不恢复Tauri运行栈；无新生产Mock/依赖/演示入口，用户已有diff及ignored真实Xray资产保留。

最终`round20-environment-cleaned.json`复核public11表与本轮before整行摘要一致、私有schema0，主App359/supervisor36715/API36763/Vite36795/PG12027的PID及启动时间不变；宿主代理mtimeMs1791888658550.031/size21576未改。本轮确切builder、两代runtime及专用child image均删除、既有postgres固定image不变，更新挂载0；所有root/agent测试与构建句柄终态已收取。自然样本ctimeNs1794859092178170591不变。前轮旧共享NOTIFY可能触达旧主本地内存hub的历史边界仍保留，不笼统宣称主内存从未变化。

整体目标保持active：签名App可信intent/更新journal自动回放、正式DeveloperID/profile/公证与Authenticode、旧Windows默认/P及实际迁移、完整GNOME图形登录环境/物理Xray OS代理流量、宿主代理授权、Windows/Intel/旧macOS/跨机器/Linux root-systemd、公开GitHub/镜像投递仍未全验。用户暂不提供正式资源且暂不授权宿主代理，继续本地不降低门禁；自然24h样本最早11月18日03:58:13，未修改时钟/样本或创建自动化。


## 21. Windows原生passive、Linux恢复命名空间与路由CRUD契约

上一轮为实际进展，本轮继续真实重构而非缩小完成条件。只本地；正式签名资源仍按用户暂不提供处理，宿主代理仍按暂不授权不写，不重启现有App/主API/Vite/PG，不提交推送发布部署。逐文件最终索引`.tmp/ui-qa/round21-final-report.json`。

### Linux journal必须恢复到同一配置空间

真实Linux独立D-Bus/dconf红测：保持相同profile路径但将内容从A数据库改为B，B里的可见代理值又恰等于原owned值；旧journal仅比较值，实际把A的原快照写到B、删掉恢复记录，而A仍残留代理。`round21-linux-namespace/namespace-red.log`记录实际覆盖及证据丢失，不以模型推断替代。

现proxySetting新增可省略scope；真实GNOME后端绑定UID、规范化用户配置路径、runtime路径、profile路径及内容SHA256。每个backend固定环境，不随全局环境漂移；每次gsettings调用前后重新核对profile身份。desired/影子快照/partial ownership保留scope，恢复要求当前/Before/Owned scope相同，目标不同或旧无scope记录保留设置与journal，不杀记录target，不猜配置空间。scope是防止误恢复的目标指纹，不是认证完整性锚，更不是签名App可信intent；同UID篡改journal不因这项哈希获得防护承诺。

显式profile缺失不猜默认；仅隐式缺省profile缺文件时按官方user-db:user回退。profile限普通文件/64KiB，O_NONBLOCK/O_NOFOLLOW打开后fstat，不对FIFO阻塞读；配置路径按现有祖先解析symlink。相同路径内容变化、配置/runtime路径变化会改变scope，回到原始profile则原scope恢复；格式错误scope、跨空间write/partial ownership及旧无scope均有负控。

真实Linux最终同路径A/B内容变化、已捕获backend拒绝静默追随、B值相同也不覆盖、journal保留/target存活、恢复原profile后逐字恢复并终止自有target通过；原五项dconf/EOF/父SIGKILL/foreign流程全部复跑通过。两个新Linux纯测试及两个跨平台scope模型测试通过，GLib keyfile项仍未在容器设schema而明确skip，Mac模型race1.757秒另验。gsettings与profile文件仍非原子CAS，不能声称消除检查与写入之间全部并发竞争。

为避免MyGo生成syso影响Go工具，Linux绿编译使用逐文件SHA记录的独立native源码快照，而不是原目录并行编译；最终将复核所有原源码SHA匹配。初次ignored runner未给含竖线的regex加shell引用，真实退出127保留`harness-unquoted-pattern.*`，只修runner参数引用后重跑，不算产品缺陷。最终--init/network none/只读/65534容器终态仅init/sleep与检查自身，无残留target/watchdog/zombie；确切builder/两代runtime/本次child image全部已删，原postgres固定image不动。证据`round21-linux-namespace/summary-proof.json`。profile语义核对[GNOME官方说明](https://help.gnome.org/system-admin-guide/dconf-profiles.html.it)，不以查询摘要替代实际双库验证。

### 原生/P passive不再拒绝；仅变换锁定MyGo生成NSIS的三行

读取锁定MyGo0.9.1 nsis.go及本机NSIS3.11 Pages/Directory/Finish宏，确认PRE定义在页面展开时立即消费，不能在后置include补绑定。原Tauri锁定模板采用PRE Abort跳目录/完成页、成功末尾SetAutoClose；本轮按此原生语义实现，不/P→/S、不GUI自动点击、不恢复Tauri栈或维护第二份安装器。

正式Windows构建先保留原签名/证书检查，再验证无Replace的MyGo0.9.1及nsis.go SHA256，预解析真实makensis绝对路径。host-native临时Go launcher只转发到绝对Node wrapper，解决Windows Go exec不能直接执行shebang/.cmd。wrapper在真实makensis前只接受完整唯一5页/固定header/BOM/LF/正式身份/include位置的原NSIS，原其余字节不变，仅增加guard及DIR/FINISH PRE三行；重复/缺失/额外/重排/错版/已变换均拒绝，不改module cache。原progress页不变，/P跳目录/完成、显示进度、成功自动结束；/P或/S更新允许/R，参数仍用原GetOptions，不通过shell启动候选。

初实现只从PATH找编译器，root复核指出这收窄原MyGo支持ProgramFiles已装NSIS的路径且可能破坏现有GitHub runner。已恢复优先PATH、再仅Windows探测原两处ProgramFiles安装目录并realpath，不下载、不松版本校验；明确fake exe仅用于发现顺序/缺失/目录伪装测试，未执行。该小修只改发现逻辑，不变NSIS变换或已编译三包路径，新增分支未在Windows实测。

真实默认完整amd64 baseline、passive amd64/arm64均走生产prepare/launcher/Node wrapper/真正NSIS链编译，捕获真实原始/变换/PPO并逐字核对恰三行注入。12个完整实际生成源变异在编译器调用前拒绝，正控确认编译器标记确实可达；不是短合成fixture替代实际生成源。最终桌面Node19/19通过（修发现前18/18），真正makensis编译和注入guard缺失真实编译拒绝均验；退出42、argv/stdin/cwd及MYGO_SIGNER/MYGO_SIGN_SETTINGS/证书密码环境透明透传，测试用明确虚构值，不把它当Authenticode验签。原!uninstfinalize字节保留。Windows host launcher交叉编PE未在Windows运行，Mac host launcher已实际完成NSIS编译。

三包均unsigned/local content fixture不能发布：baseline NSIS6,711,447B、amd64 passive6,715,744B、arm64 passive6,085,389B；最终SHA分别`01dbf345bb4f61b52de1294d6129326c92b5a149657b9162bf697c0184844749`、`419624fccde41378c2b4a783dba270d41cb2e88431802da76e259c611f519d91`、`84838c56aba7b30a31b27f6e74437bcea0b3ef08e3d438dd34eed52dd7872c60`。无需将不同架构或缓存计时互作性能结论。

仍无Windows动态运行：实际进度/自动结束/ARGS中文空格斜杠空串/旧根替换/快捷方式与别名/重启就绪/卸载数据Hash及故障恢复未验。第20轮NSIS非事务、部分payload/新旧键、并发路径替换边界延续，不能据编译绿解锁旧用户迁移；legacy204/stage disabled/publisher硬门禁未改。所有临时config/launcher/副本/bindings/watchers/syso清理、所有构建句柄终态，主流程收到冻结才构建Mac21。详细逐文件/命令/布局/未验及最终SHA在`round21-windows-passive/completion.md`。

### 路由规则CRUD完整旧输入和副作用契约

读取397a64d实际Create/UpdateRoutingRuleDto、完整ClientRoutingRuleService/helpers及原异常filter，以真实Prisma6.19.2、原DDL/索引和随机私有schema执行83样本：35成功、45拒400、3拒500；鉴权和publisher为明确夹具适配，不冒称旧Nest HTTP整机。旧名称按validator.js字符数校验后JS trim/UTF16截80，POST enabled:null存true，PATCH enabled:null及切片分裂代理对为原Prisma/filter500无写无事件，value/action:null为helper400。空或只有额外字段PATCH原Prisma不改updatedAt，但仍向本人和管理员各推一次policy_updated。

原Go enabled字符串/数值可被SQL强转、中文名称按字节误拒/name不trim、合法连字符关键词误用domainLabel拒绝、100上限409而非400、DELETE漏deletedId，均有真实HTTP红4项全失败。现仅routing.go和专属routing_input.go恢复严格白名单/类型、nullable、原长度/截断/trim/helper顺序；关键词允许单独“- / --- / -a / a-”，domain仍逐label约束，IPv4文本按原归domain，不引入CIDR/正则/协议URL新语法。原每用户advisory锁、事务和所有权先于helper保持；非法URL+会分裂UTF16的name按原先value再name先返400，不颠倒为500。

最终4项HTTP race22.165秒、普通3次12/12共20.761秒/vet通过；63拒绝逐次全48表摘要/序列不变及管理员/本人/其他用户三路真实SSE零业务事件。10合法value、7名称、null/default/空更新/启停/所有权/DELETE deletedId、100上限400及重复409事务均正反控；本人和管理员各一次policy_updated，其他人零事件，不靠放宽过滤。25自有schema和生成Prisma client已清理，无活动自有句柄；4文件最终SHA与证据`round21-server-contract/round21-server-report.json`。本轮保持旧500错误边界为兼容事实，不把这些无写拒绝称合法保存成功；panel入站内部完整审计未借本轮宣称完成。

### 首轮全量103/104：启动取消测试不再依赖文件事件到达时序

首轮pnpm test确实103/104失败，失败命令内两项启动期SIGINT/SIGTERM测试尚未发出信号，supervisor已完成快PG初始化并进入fixture未提供的SYSTEM_VERSION，退出ENOENT；不能把它说成新生产取消逻辑失败，也不能补假版本让信号晚到而误过。原日志`round21-test-first.log`保留。fs.watch日志创建通知不构成父/子进程先后屏障；真实PG已启动与父进程收到FSEvents是两个时序。

仅修测试：通过现有CHORDV_LOCAL_PG_BIN测试目录原样symlink真实postgres/initdb/psql/createdb/pg_ctl；pg_isready适配先真实执行且仅成功0后由私有Unix IPC暂挂退出结果，因此原生产ensureLocalDatabase仍未返回、database变量仍undefined。parent核对真实专属PG PID/realpath，发SIG；--import仅观察实际JS signal事件并回执，同次emit中的生产shutdown已设stopping=true，再放行readiness结果。原supervisor和DB生产源码未改、无新增运行时测试开关，无伪造ready或mock数据库。观察器额外signal listener会改变默认OS终止行为，因此证据仅覆盖生产JS信号处理/晚返回DB句柄收尾，不扩大为默认OS信号行为验收。

原断言保留：supervisor非signal/code1退出、取消文案、没有SYSTEM_VERSION/源码提交/构建越界、真实postmaster.pid消失、四端口关闭。最终专项2/2、2.509秒通过；独立副本仅加回原one-shot shutdown的if(stopping)return，真实PG/相同屏障下再次因PG残留不退出而红（仅诊断副本timeout8秒），负控`one-shot-mutant-final-red.log`，证明屏障没有掩盖原缺陷。失败清理用真实pg_ctl -w/-t10等已验证自有PG关闭，pg_ctl与生产shutdown竞争时仅pidfile已消失才接受非零，再验端口后删除目录；嵌套finally保证IPC关闭，不用return吞测试错误。

第一版新夹具误用/var与/private/var字符串比较，测试抛错且旧finally跳过IPC关闭，已记录`first-harness-path-alias.log`；只停止那次明确Node92633/92634，确认两自有PG已退出后清四个确切临时目录。现改realpath并保证失败路径收尾，未操作主PG。测试helper仅在tests/e2e，不进生产。修复后从头重跑完整check/test，最终结果如下，不把首次失败改写成功。

### 最终门禁与边界

- 最终check7/7、test104/104条命令从头通过，包含修改后的启动取消屏障、真实PG正控/旧one-shot变异负控，以及Windows19项桌面合同。首轮103/104及新夹具alias失败原日志保留，不改写为成功；没有为测试放宽生产约束。
- 显式真实DB完整race：API409.561秒（JSON包pass409.562）、config1.943秒、database8.161秒，509pass/0fail；3项明确opt-in跳过为历史Prisma生成器及归档/固定exe，后两项已经最终真实Agent供给另行执行。round21-server-real-race{.jsonl,-summary.json}按LF解析，不误拆合法Unicode NEL。
- native真Xray与显式官方GNOME schema完整普通race265.992秒、真正e2e race273.916秒；build21真实完整原生+React更新健康race25.559秒（GUI23.99），API回环端口1、无proxy journal。Linux真实namespace/原看护流程及Mac模型race1.757秒另验；Windows/Linux两架构native/server测试交叉编译和vet通过，不当目标OS运行证据。
- 最终Mac backend及Linux x64/arm64 release重建、真实临时Ed25519/双架构归档/HTTP Agent供给通过，HTTP组10.058秒、固定exe路径0.10秒；不运行root/systemd安装。round21-backend-final.log与round21-agent-release-supply-final.json。后台chunk大于500kB警告保留，不调阈值换绿。
- 普通App19,216,354B、DMG6,686,720B，1.1.12/build21/local/macos/arm64；binary SHA256 4b3c4cf5562809ecee7d6fc83ea104878d0e27c734788ee5eb950482c070fd7d，DMG 5cdd778253172e1e74f1c039d5610b8f1aae5f96a4c70326cb7d5edff9ff277b。密封plist/早退信息/Go linker身份一致，strict codesign和DMG verify通过，仅adhoc。MyGo17.3秒为本次缓存/磁盘条件，不与Tauri或前轮作异条件提速比较。
- 最终server0.0.34 SHA256 c53f7be6d3c8951dbdfff3c5d4ff7d043aa38989ef28e8f1fdbdd058540749ca，Agent manifest 69f126e2cd59e6693167c4c1cb98cfb08c29af5e9bd7b6740b80959f7408d5c3；round21-artifact-report.json。dirty HEAD不代表远端包含未提交修改；构建没有替换旧主API进程。

本轮无React/CSS修改，检查恢复错误/路由调用的布局影响，统一真实浏览器回归和普通build21完整GUI首屏通过；Windows安装器可视布局无运行环境未验。旧路由输入和/P拒绝被单一正确实现替换，恢复快照scope没有另建代理存储，测试去掉易迟到fs.watch触发；无新生产依赖/Mock/演示入口，原用户diff与ignored真实Xray资产保护。

最终round21-environment-cleaned.json确认public11表与本轮基线整行摘要一致、私有schema0；主App359/supervisor36715/API36763/Vite36795/PG12027的PID/启动时间不变。宿主代理mtimeMs1791888658550.031/size21576未改；确切builder/两代runtime/本次child image、临时config/launcher/Prisma与启动测试目录清理，既有postgres固定image未动，更新挂载0，所有root/agent句柄已收终态。自然样本ctimeNs1794859092178170591不变。旧共享NOTIFY曾可能触达主本地内存hub的前轮边界仍保留，不笼统宣称主内存从未变化。

整体仍active：签名App可信intent/自动journal回放、正式DeveloperID/profile/公证与Authenticode、Windows真实旧updater/P/参数/故障恢复/数据与快捷方式迁移、完整GNOME桌面/物理Linux OS代理流量、宿主代理及Windows/Intel/旧macOS/跨机器/root-systemd、公开GitHub/镜像投递和panel入站内部完整审计均未全验。scope只是防错目标哈希、不是同UID篡改完整性锚，旧无scope GNOME journal保留并拒绝自动恢复。用户资源暂不提供、宿主代理暂不授权，不再索取或降低门禁；自然24h样本最早11月18日03:58:13上海，不改样本/时钟、不创建自动化。

## 22. 官方Linux Xray真实流量、面板旧契约与Windows执行验收接线

Linux新增4个测试文件改动，无native生产改动。固定官方v26.11.9 Linux arm64归档SHA256为64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be，与GitHub API digest一致；两GEO按现锁重新下载到测试证据目录，原ignored资产未改。初始私网echo超时实证来自新版Freedom默认finalRules，不是应用故障；仅测试peer允许当前回环echo确切端口，没有在应用配置关闭策略。首次TLS下载失败改用正常证书校验curl，未弱化TLS；未成功的源构建不是执行资产。证据在.tmp/ui-qa/round22-linux-runtime。

真实dconf/DBus以及官方Xray两个进程完成连接、106496字节往返/重连、错误用户负控、实际内核崩溃、父SIGKILL独立看护恢复；全GNOME/dconf组通过。未设keyfile schema项保留skip；Linux本轮非race、无完整图形登录桌面。HTTP消费者读取真实GNOME值后显式设代理，heartbeat为明确本地fixture，不把两者升级成自动代理发现或真实服务端鉴权证据。

服务端5文件按职责移出唯一normalizer/parser实现，243旧输入由真实旧代码生成：168 normalizer（58通过/110拒绝）、75 parser（30通过/45拒绝）；75解析HTTP、100非法排队全48表及SSE无副作用、58合法spec真实payload全等、规范公钥/长SNI经真实Agent SSE和回执激活。专项race7项8.852秒、普通重复21项通过、vet通过；19个自有schema清理。原nodeHostAllowed未改，旧public predicate与当前local/production策略差异明确保留；不接线上面板，不宣称parsePanelReport/commandResult负分支全审。

Windows新增八个验收工具/workflow文件；锁旧公开Minisign签名、当前canonical QA Go身份与实际NSIS payload，只允许可丢弃普通测试账户、SID/profile与不超过8小时lease。计划运行真实默认/P、自定义/S、参数、别名/快捷方式/注册表、未知文件hash、负控和真卸载；本轮无Windows运行。25项Node桌面/Windows合同、官方PowerShell7.4.6真解析四个PS文件/C#编译/六组参数编码合同/非Windows前置拒绝通过；代理快照变化/读取失败先落failed报告再非零退出，不自动恢复代理、保留原错误。CIM/WinEvent只作外部观察，不是Go内部args或应用健康；工作流未触发，legacy始终disabled。

最终check7/7、test104/104条命令通过；显式真实DB完整race516pass/0fail，包耗时和opt-in skip逐项保存在round22-server-real-race-summary.json。native真Xray完整普通/e2e race分别276.332/272.542秒，普通build22真实原生+React更新健康22.455秒；Windows/Linux双架构测试交叉编译与vet通过，不是目标OS运行。

Mac backend与Linux x64/arm64 release产物重新构建，本地临时Ed25519/双架构归档/真实HTTP Agent供给通过；未执行root/systemd安装或部署。App 19216354B、DMG 6686208B，1.1.12/build22/local/macos/arm64；密封plist、早退信息和canonical Go buildID一致，strict codesign与DMG verify通过，仅adhoc。binary SHA256 ce90c0460fb53e5f3c81ac232a932084f7a9acab593179c449329989b32c8489，DMG SHA256 dae1387f53c01b6ffe30782824a996a7bccc3a531e6563e24564840bb65eb2a2。服务端0.0.34 SHA256 af7812d3729b93e1c8e091b1525718ba8c2713548e7c6fe46f55ccd60f244ccc；完整身份见round22-artifact-report.json。构建耗时仅本机缓存条件，不与旧Tauri异条件比较；后台chunk警告保留。

无React/CSS修改，已检查panel错误/返回与原表单调用链影响，统一真实浏览器回归及普通build22完整GUI健康通过；Windows安装器可视布局未验。旧normalizer/parser单一替换无并行入口，无新生产Mock/依赖/演示按钮；Linux heartbeat及parser oracle均明确隔离测试夹具。原用户diff和ignored真实Xray/GEO保护。

round22-environment-cleaned.json确认public11表摘要不变、私有schema0；主App359、supervisor36715、旧API36763、Vite36795、PG12027的PID/启动时间未变。宿主代理mtimeMs1791888658550.031/size21576未变；本轮builder/runtime/child image和PowerShell容器精确清理，既有postgres image保持；更新挂载0，自有测试句柄终态。自然样本ctimeNs1794859092178170591保持。旧共享NOTIFY可能曾触达旧主本地内存hub的前轮边界不抹除。

整体目标仍active：正式DeveloperID/profile/公证与Authenticode资源暂不提供，宿主代理写入暂不授权；不重复索取、不降低门禁。可信App intent/自动更新journal授权恢复、Windows真实旧updater/P/参数/健康/失败恢复、完整GNOME桌面自动代理发现、Intel/旧macOS/跨机器/root-systemd与公开GitHub/镜像投递未完成。GNOME scope仅防错目标哈希、不是同UID完整性锚；parsePanelReport/commandResult全部类型负分支尚未完整审计。自然24h样本最早11月18日03:58:13上海，不改时钟/样本、不设自动化。

## 23. 默认GNOME/GIO真实HTTP代理消费、panel回执事务与真旧包输入

Linux测试在独立无网络/只读root/nobody/init容器、私有DBus/dconf下运行，容器私有hosts仅将chordv-proxy-target.test映射回环；没有host mounts或宿主代理写入。官方GLib2.84.4/glib-networking2.80.1构建C消费者，g_proxy_resolver_get_default与g_socket_client_new的默认对象必须一致，proxy列表严格唯一且协商事件必达；不是Go读配置后手工设代理。实际UUID负控在已协商代理后unexpected EOF、echo计数仍1，正确UUID后重连再次全字节通过；helper超时和非网络进程异常不能算负控成功。两个真实变异分别发现直接连接旁路与负控失效；3次正常重复通过。完整组22顶层：21pass/1个未设schema的keyfile skip，Linux非race。独立只读审阅的两项验收缺口已修正并实际重跑。初次apt下载EOF失败保留，原builder重试正常取得包并继续，未重建假环境或弱化校验。精确清理本轮builder/runtime/child image；原锁GEO与ignored资产不改。证据round23-linux-gio。

Windows canonical QA真实Go/MyGo x64程序/完整NSIS及独立QA前端build23重新构建，203项源码/前端/工具输入聚合SHA前后一致；纯内容检查使用同一原合同代码，CLI仍先拒绝非Windows。实际旧build27公开NSIS/.sig逐项SHA与GitHub digest一致且固定旧钥验签通过；实际v1.1.12 tag不等于release.target_commitish，相关旧Windows合同逐字对照与run27/head_sha397a64d来源证据保留，不声称全仓相同。真实旧manufacturer经锁定Tauri渲染器/NSIS模板推导为chordv，与PE交叉相符；只追加QA已有键拒绝，不自动清理。真包正控与6个完整资产负控、26 Node合同、官方PowerShell真parse/C#通过；CLI非Windows拒绝且runtime输出未创建。内容报告windowsRuntimeExecuted=false、runtimePreflightAccepted=false、productionTransitionEnabled=false；输入zip不是正式发布或Windows已安装证明。证据round23-windows-canonical。

面板回执已修复严格DTO/字段比较、生命周期与事务应用、实际tag冻结/dedupe释放/failed错误原文，并实证157旧输入和17真实旧事务。保留Go Agent持久缓存completed回执的ACK200幂等协议，不机械复刻旧404；failed仍采用Go指数退避。失效panel任务现于claim事务取消并释放key、保留审计且不阻塞后续合法命令；Node只读MVCC避免反向锁，commit后有取消才发一次后台SSE。13专项race20.484秒、重复39顶层执行、32组并发与94个自有schema精确清理通过。完整逐文件说明见round23-completion.md。

最终check7/7、test104/104条命令通过，显式真实DB完整race562pass/0fail；包耗时/3项opt-in跳过及2个无测试包逐项保存在round23-server-real-race-summary.json，归档/固定exe两项另已实际执行。真资产native完整普通/e2e race277.887/272.766秒，普通Mac build23完整原生+React更新健康26.404秒；Windows/Linux双架构测试交叉编译+vet通过，不冒充实机运行。Mac backend、Linux x64/arm64包及临时Ed25519/双架构真实Agent HTTP供给重新验证通过，未安装root/systemd或部署。

普通App 19216354B、DMG 6686208B，1.1.12/build23/local/macos/arm64；密封plist/早退信息/canonical buildID一致，strict codesign和DMG verify通过，仅adhoc。binary SHA256 4757940998fcec5b909b2ed8f8e3b61e2344b78605cf31d35704546f647c6d11，DMG 1de78d7ac92989f45bcd5c1e7bc2d45d79b0e71fe950584c944d3dc58f93bd4c。server0.0.34 SHA256 e590d26ef79463f2494f00a66c8db727de9eab304d1fafaf7020dfd768aef858；完整产物见round23-artifact-report.json。本机缓存构建耗时不作Tauri异条件提速结论，后台chunk>500kB警告保留。

无React/CSS修改，已检查panel调用链及既有cancelled错误状态，统一真实浏览器和普通build23真实GUI健康通过；Windows视觉未验。旧回执比较单一替换，无新增生产Mock/依赖/演示入口；GIO消费者/旧oracle仅隔离测试，原用户diff与ignored资产保护。round23-environment-cleaned.json确认public11表摘要不变、私有schema0；主App359/supervisor36715/旧API36763/Vite36795/PG12027的PID/启动时间未改，宿主代理mtimeMs1791888658550.031/size21576保持，更新挂载0。所有自有句柄终态、Linux builder/runtime/child image及PowerShell容器清理，基础postgres镜像保留；自然ctimeNs1794859092178170591未改。旧共享NOTIFY可能触达主本地内存hub的前轮边界仍保留。

整体仍active：正式DeveloperID/profile/公证/Authenticode资源暂不提供，宿主代理写入暂不授权，不重复索取或放宽门禁。Windows真实安装/旧updater选版/内部ARGS/健康/失败恢复和签名App可信intent/更新授权journal恢复仍未完成；GNOME本轮仅HTTP系统默认GIO，不是完整GUI/WebKit/HTTPS/SOCKS/KDE/PAC或真实服务端租约。Intel/旧macOS/跨机器/root-systemd/公开GitHub与镜像投递未验；真实旧输入已经备齐，不再把缺旧包作为阻碍。tag/releaseTarget差异、QA23低于旧27非正式发行计数、MVCC在途回执仍可能一次400/409均明确保留。自然24h样本最早11月18日03:58:13上海，不改样本/时钟，不设自动化。

## 24. 11月17日至18日：公告写契约、发布来源与Linux真实测试门禁

公告原DTO+完整旧service在私有Prisma/PostgreSQL执行258样本（109接受/147拒绝/2旧Date503），7个模式转换、客户端10字段投影/双降序/删除级联、真实admin/client SSE已核；原读状态保留。新更新采用行锁事务，16组并发mode/countdown为串行等价，提交阶段延迟约束失败48表/SSE零副作用。旧不能转Date的输入前置400为明确修正；UTC原表不能证明非UTC无时区输入；主流程额外发现并修复time.Local/DST歧义，四TZ44原Date及四TZ各258 HTTP/DB/SSE通过。39个本轮自有schema/Prisma临时资源已精确清理。证据round24-server-announcements。

发布器修复默认分支/既有tag漂移、旧channel未验签且引用可变ref、最低版本能签出客户端拒读清单三项真实问题。先补8项全部红，最终新增11/11、publisher17/17通过；仅离线fixtureHTTP，无真实GitHub写入。新tag绑定manifest sourceCommit，已有tag有界解析核对；每次CAS都以parent SHA读JSON/.sig并固定钥验原始字节及身份，再比较floor；最低版本单一SemVer比较、签前规范化且<=version。公开后补channel恢复/生产legacy投影/正式签名仍未完成，未降低任何门禁。证据.tmp/release-contract-round24。

Linux CI此前新的真实场景因无资产/探针会skip，本轮补固定测试锁和复用GEO的准备脚本、真实消费者编译和十项必pass的JSON门禁。两个架构真实资产正常fetch/Hash/长度/ELF检查通过；arm64无hosts别名下22/22及GIO三重复通过，默认代理传输106496字节、wrongUUID拒绝/断开恢复均保留，另非echo端口直达200而经代理拒绝。测试peerForceIP+固定DNS+显式catchall block仅为隔离夹具。实际unset GIO造成Go SKIP/退出0，Node门禁必须exit1；不是仅静态字符串测试。amd64模拟容器仅实际Xray CLI版本通过，未冒充x64 GIO/完整workflow。Ubuntu24 x64 workflow本地已接线但没有触发；本地Linux非race，不是GUI/HTTPS/SOCKS或真实后台鉴权证明。证据round24-linux-ci。

环境复核额外查明：既有public-before只选11个表，public实际48个；新断言误把11当总表数曾失败，未执行任何DB写入。按内嵌迁移CREATE/DROP序列核对实际48表名一致，并将全量摘要新存round24-all-public-baseline.json供后续使用；历史11抽样相等不等于其余37表已有前后证据。该边界在最终报告明示，不用期末快照伪造期初状态。

最终公告写/读/删除恢复原契约，UTC-only参考表遗漏的无TZ datetime/DST根因也已修复：四TZ44个原Date表达式对照、四TZ各258条真实HTTP/DB/SSE全部通过；不改全局time.Local/通用date，date-only/显式zone语义保留。第一版check7/7、test104/104、真实DB race575pass仍另存round24-first-*，不将第一次全绿误当时区正确证明。公告39个初批+34个时区批精确自有schema、Prisma客户端/引擎和CPU临时程序清理；原11个抽样public表摘要未改。

修后最终check7/7、test104/104条命令通过，显式真实DB完整race580pass/0fail；包耗时/opt-in跳过逐项记录round24-server-real-race-summary.json。真资产native普通/e2e完整race292.726/269.629秒，普通build24完整原生+React更新健康22.13秒。Windows/Linux双架构测试交叉编译与vet通过，不当实机运行；Mac backend和Linux x64/arm64包修后重建，真实临时Ed25519/双架构归档/HTTP Agent供给通过，未安装root/systemd或部署。

普通App 19216354B、DMG 6686720B，1.1.12/build24/local/macos/arm64；密封plist/早退信息/canonical Go buildID一致，strict codesign与DMG verify通过，仅adhoc。binary SHA256 99eb961f1ed186f54c3db2fcf67e1405cba13a58dbaa73a264663806f227e0ef、DMG 06dc20ff1d7850301c07a21d7d45ce958f13183eed3144ba51a8ee23d37f2fe4。server0.0.34 SHA256 2d5c70c83e0801a24b439a90b66fbe6d33bfcd6bf26fbc1ff17ec0868db778fc，完整产物在round24-artifact-report.json。本机缓存条件构建耗时不用于宣称相对Tauri的质变，后台chunk>500kB警告保留。

发布sourceCommit/tag绑定、固定parent SHA原文验签旧channel、最低版本规范化与<=version已修并离线红绿证明；公开后补channel恢复/生产legacy typed投影/正式新SemVer和签名仍未完成，没有降低门禁或写GitHub。Linux准备脚本实际下载两架构官方锁资产，GEO复用原生产锁而不新增发布targets；无hosts实际arm64组22/22、十项必pass门禁和真实SKIP拒绝、GIO三重复通过。仅本地x64模拟容器CLI正控，hosted Ubuntu24 x64 job已接线未触发，本地Linux非race，不是完整GUI/HTTPS/SOCKS或真实后台租约。

无React/CSS修改，已检查公告倒计时/保存/投影事件调用链与Linux测试隔离；统一真实浏览器回归和build24 GUI健康通过，新公告完整真实桌面操作/Windows安装器视觉未验。旧公告实现单一替换，无新生产Mock/依赖/演示入口；旧oracle、ELF头部及HTTP请求fixture仅测试，不拿合成数据充真实资产证据。

round24-environment-cleaned.json确认11个抽样public表摘要不变（public实际48表，与迁移表名契约一致；本轮末尾新捕获全48摘要仅供后续比较，不追认此前37个未采样表）、私有schema0；主App359/supervisor36715/旧API36763/Vite36795/PG12027 PID/启动时间未改，宿主代理mtimeMs1791888658550.031/size21576保持，更新挂载0；本轮builder/runtime/x64 CLI容器和child image精确清理、基础镜像保留，所有自有句柄终态。自然样本ctimeNs1794859092178170591不变；旧共享NOTIFY可能触达主本地内存hub的前轮边界保留。

整体仍active：正式DeveloperID/profile/公证/Authenticode暂不提供，宿主代理写入暂不授权；不重复索取或放宽发行约束。本机只读盘点未发现Windows VM工具，未创建VM或下载ISO，已询问可用测试环境信息且没有以未回复停止本地开发。真实Windows/旧official updater/内部ARGS/健康/失败恢复、可信App intent/自动更新journal授权恢复、完整Linux GUI/跨机器/Intel/旧macOS/root-systemd、公开GitHub/镜像投递仍未完成；其他设置业务不能因本轮公告实证而冒称全审。自然24h样本最早11月18日03:58:13上海，尚未到期，不改样本/时钟或创建自动化。

## 25. 本地发布恢复、计量保留与当前真实内核复核

第25轮仅本地：显式resume-channel已用当前双架构真实Go归档/临时Ed25519/回环HTTP验证7场景，47项发布测试通过；所有恢复只写渠道，未写GitHub或放松legacy门禁。服务端补回计量30天已入账payload清空、90天resolved异常、30天Webhook保留任务，每表5000×40/跳锁/逐块提交，17/43分固定小时，失败下一小时继续；批次行/hash/序列/水位保留。订阅提示改为当前用户最新有效租约/在线健康Agent/90秒宽限，显式message，不被团队其他节点污染；旧16案例与13项专项race、真实旧boot重放/终结水位通过。134注册实现不是134端点行为全等价证明。

最终check7/7、test104/104条命令通过；显式真实DB完整race 648 pass/0 fail，跳过与包终态见round25-server-real-race-summary.json。当前锁Xray/GEO的Mac普通/e2e完整race 264.587/274.032秒；共享peer的Linux22/22、十项必pass与GIO三重复通过。Windows/Linux双架构测试交叉编译/vet通过，不当实机执行。Mac backend及Linux双架构包已重建，真实Agent HTTP供给与更新后真实归档恢复再次通过。桌面生产源码未改，不无意义重建：复核既有build24身份/strict adhoc签名/DMG与真实GUI健康23.571秒，不声称新build25产物。

未修改React/CSS；已核对MeteringFloatingBanner状态条件、portal、data-metering-notice与两种中文消息消费链；统一浏览器回归和现有build24完整原生+React健康通过。静态另发现手机定位选择器依赖.desktop-app--mobile祖先，但banner portal在body，现规则不能按该祖先生效；尚未专门复现/修复计量异常手机定位，不把通用绿测冒充该视觉场景通过。

全48张public表名及行摘要与本轮期初相同，私有schema0；旧ignored六文件、主App/本地API/Vite/PG进程、宿主代理mtime/size、自然样本ctime保持。精确删除本轮Linux容器/child image与临时Prisma client，保留既有基础镜像和隔离证据；无提交/推送/发布/部署/主服务重启。单一替换旧全订阅CASE与发布合同/CAS，Linux/Mac共用测试peer，无新生产Mock/依赖。整体目标仍active，正式DeveloperID/profile/公证与Authenticode暂不提供；宿主系统代理写入暂不授权。保持正式门禁，不重复索取、不做Keychain实验。其他未完成项见round25-completion.md，不把局部测试绿缩成目标完成。

## 26. 计量提示定位与用户安全写入契约

第26轮推进真实目标：先用浏览器证实计量提示Portal脱离.desktop-app--mobile祖先导致遮住导航，随后只移除Portal，复用原有CSS；不加新卡片、重复平台逻辑或全局样式。已实际核对截图与几何：修前390×844下banner.bottom=826/nav.top=758，提示覆盖导航；移除Portal后752/758，间隔6px。Chrome真实组件/完整生产CSS＋代表性应用壳，Android/iOS平台类、320—844宽/390—844高、横屏、同步浮层、正常/空消息/转场共14场景通过；桌面820×588提示与浮层几何逐字段等于修前基线。最终收窄Vite根目录后14场景再次通过，截图位于output/playwright/round26-metering-layout。不是iOS设备/WebKit/Android原生整机或Windows WebView实机证据。

用户安全PUT从通用用户编辑拆成专属白名单：缺省/null/只有额外字段都清override恢复套餐策略，额外password/role/status/displayName/authVersion等忽略不落库；复用已有Number/Min1/正小数截断，存在用户时int32越界503，缺用户先404，非法DTO先400。原Nest DTO＋完整原方法＋真实Prisma6.19.2/原模型私有schema实证48条，原27条红现绿；只读/写入全48表及三方SSE、3条真实HTTP租约同步逐出2条通过。专项5项×2次race34.983秒/vet通过。普通PATCH、共享plans/users/concurrency/events与round25的16冻结源码未改；原pending/通用租约差异明确保留，不用窄测试冒称完整后端等价。

最终check7/7、test104/104条命令通过；显式真实DB全量race 700项pass/0fail，逐项skip及包终态见round26-server-real-race-summary.json。首次全量为103/104：App启动夹具bootstrap提供维护公告、刷新却返回空列表，真实截图只有关闭提示。该场景计量status=ok/message=null，Portal前后都不渲染，不把夹具竞态归咎生产修复；现只把测试读模型按用户统一，该启动用例原断言/超时/生产启动代码未改，专项与3次重复通过后完整重跑。第二轮103/104为回执重试时间断言；原失败未记原始时间、加诊断20次未复现，未追认唯一成因。独立只读PG证明TIMESTAMP(3)舍入会让合法120秒被原纳秒下界误拒、错误121秒被原上界接受，现上下界均按毫秒比较且上界收紧到120秒，119/121反控拒绝、120正控通过，实际回执race30次41.489秒通过；生产重试源码未改。两次失败原文保留round26-test-first.log/second.log，修后pnpm check/test与完整race均从头重新执行，未靠重复至绿替代已核实的断言/夹具修正。新普通Mac build26、backend macOS arm64/Linux x64+arm64重新构建，真实双架构Agent归档/HTTP供给通过；Windows/Linux双架构测试编译/vet不当实机。新build26完整原生＋React GUI健康26.008秒，密封plist/早退信息/canonical buildID、strict adhoc codesign与DMG verify均核。完整产物字节数/hash见round26-artifact-report.json；本机缓存构建6.4秒不用于异条件比较或宣称相对旧技术栈质变。

全48张public表名/行摘要与本轮期初相同，私有schema0、临时Prisma与自有浏览器/回环fixture服务精确清理；主App/旧本地API/Vite/PG PID与启动时间、宿主代理mtime/size、旧ignored六文件与自然样本ctime未变。未提交/推送/发布/部署/重启主服务；无新生产Mock、依赖、演示入口，旧安全PUT通用入口已单一替换。整体仍active，未完成项见round26-completion.md。

## 27. 租约、认证恢复与签名发布协议

本轮先按旧方法真实差分，修正服务端默认TTL/HB/grace为1800/30/300秒、过期+宽限半开硬截止、逐出排序/默认3/正override及终态原因/撤销时间/审计持久化，重复心跳不重复生成终态审计。保留同步事务收敛、最后有效租约离开才停共享UUID并排DISABLE，不机械退回旧异步行为。实际又复现跨用户互换Node的40P01（500/200），现完整Sub→Binding→Node稳定预锁后200/200；Plan范围后插入Sub再补锁也实证40P01，现事务内冻结已锁Sub集合，任何Node阶段未知Sub在补锁前409并全事务回滚，正常无插入200/200、显式重提收敛。59顶层相关race及旧v1/v2反控保留，不宣称所有业务锁序已被普遍证明。

Native从第一次临时失败计宽限，401刷新网络/5xx不当立即终态；显式terminal、旧运行指针保护及清理失败journal/可操作持久反馈均落地。桌面UI不另设判停计时；Web/Android只有匹配active+有效续期才成功，typed2xx过期立即终止，503文字不升级成撤权，定时/恢复单飞、旧回复围栏与结果副作用去重。认证真实6项迟到错误、手动刷新迟到先红后绿；App使用hook唯一归属出口，旧保存与新登录走同一串行队列，同用户退出重登也隔离。

私有源码与公开产物库分离已从设计进入schema2生产实现：签入canonical repo，真实源码身份仍绑定实际包；公开tag仅指向零父commit/两普通blob的M与raw.sig，不复制私有Git对象，create-only不覆盖。producer/JS/Native授权/receipt/server投影接通，schema1保留旧语义，旧Tauri204与正式签名门禁不松。新本轮Linux双架构真实归档+RAM临时Ed25519+真正Git/回环HTTP再次通过6场景/101请求，原bundle恢复后仅补channel与原文no-op、raw.sig/父历史负控均过。

最终pnpm check9/9、test110/110；显式真实DB全量race818项pass（API628.837秒）、Native完整e2e/race398项pass（307.626秒），共享协议独立race亦过。新普通Mac local build27实际应用19,266,594字节、DMG6,676,992字节，strict adhoc/密封身份/DMG通过；完整原生+React GUI健康25.823秒，API回环port1、无代理journal。macOS本机服务端/Linux x64+arm64已重建，Agent真实归档/HTTP供给与Linux/Windows双架构仅交叉编译/vet通过；缓存MyGo步骤报告6.6秒不作异条件性能对照或“质变”证明。

自然样本未改时钟/内容/mtime/ctime，实际到龄前SSE扫描拒清理/HTTP400；上海03:58:53年龄86441.710秒，实际扫描判可清、HTTP200由生产cleanup删除原82字节样本，持久任务0、实际重扫无条目、新邻近文件保留。public全部48表名/完整行摘要未变、private schema0；主App/本地旧API/Vite/PG PID与启动时间、宿主代理mtime/size、旧ignored6资产均不变。未提交、推送、发布、部署或重启主服务，未用正式签名资源或做Keychain实验；整体目标仍active。

原始失败完整保留：首次中间check7/7、test106/106与旧DB779/Native396不是最终源码。最终第一次全量109/110的唯一失败来自新完整App夹具SSE握手返回ok而非streamId，触发浏览器fallback；旧hostname路由允许其他本地端口，造成新身份另一次恢复遇到旧身份专用假回复。只修测试streamId/open、按token归属回复与精确fixture-origin，三保护断言逐字保留；故意损坏握手仍被网络守卫抓住，旧裸App在正确夹具下两保护仍红，独立真实订阅/hook/路由矩阵复核通过。不能回溯声称此前没有本地API读请求或进程日志/内存改变；最终不转发到非fixture origin，public行摘要不变。

显式DB race第一次撞Go默认整包600秒上限：208顶层已过、2资产门槛skip，当前用例仅1秒且栈在正常bcrypt登录，0单测fail/0 DATA RACE/0 40P01。7项剩余tail在180秒预算下55项含子例通过；只把外层整包预算设900秒，不改生产timer/任何单测断言，再完整818项通过。超时跳过t.Cleanup遗留的唯一schema经OID/xmin、迁移/唯一测试admin时间及空Subscription核实，精确DROP；同名同时间空临时目录只rmdir，两次public48摘要一致。外层初版zsh把status当可写变量另有记录错误，内核NOTE_EXITSTATUS证实首次Go真实返回1（非掩盖成绿）；最终rc记录与工具终态均0。

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

第29轮修复macOS更新镜像归属/attached-only清理及取消中断attach的根因；隔离当前后台+生产Agent+真实Xray链并退役旧public按行清理。最终Native e2e/race 499项、check9/9、test110/110、真实Agent链7项通过。

本轮本地1.1.12/build30，App 19283522字节，DMG 6669312字节；构建单次观察10.5秒（未清缓存，不是冷构建基准）。strict ad-hoc/DMG verify通过，无正式证书。

未修改前端UI/CSS；核对现有updateInstallBusy持续到取消完成以及invoke无额外JS超时。pnpm test重新执行浏览器布局断言；本轮未另做目标OS多尺寸视觉实机验收，沿用第28轮已查看的标准模式820/390和后台1024/390证据，不把源码/浏览器夹具当宿主代理状态证明。

保留原真实attached-only/缺work假成功红测试和partition权限红测试；首轮ownership夹具0644导致正控失败，已改成与生产私有copy一致的0600。真实stage与新reattach夹具均暴露entities[0]假设，现按明确整盘选择。首个完整Native为490 pass/3失败：旧成功报告同步时窗、parentkill中断attach、reattach夹具首项误读；首次pnpm test为109/110。测试成功等待只修VNODE谓词，未增加40/20秒预算或移动生产report/备份删除顺序；parentkill修的是生产有界capture与同步取消预算。5份精确失败夹具先保存诊断/全部文件SHA、两次确认无其attachment且无其进程后删除；没有detach或force，不能回溯称原过程从无失败或遗留，也不是生产pending自动恢复。

逐文件、完整验证和未验边界见 `.tmp/ui-qa/round29-completion.md` 与 `round29-final-report.json`，历史失败日志保留。

## 第30轮：状态迁移去重与恢复边界核验

第30轮修复相同启用保存重复供给、相同停用保存重复撤权；正常敏感编辑、真正启用、并发策略和订阅刷新保持。最终check9/9、test110/110；真实DB race986项（API 784.539秒），定向15项；当前Go后台＋生产Agent＋真实Xray10项通过，最终精确计费659456字节。旧真实服务图15例由root独立再现，122份HEAD源精确核对。

3份当前服务端/Agent/后台包已重新构建，实际Mac --version与133份源构建前后SHA核对；当前Linux双架构归档的真实Git/HTTP草稿恢复3模式、436请求通过，非GitHub云端。

没有改UI/CSS；保留现有客户端视觉。pnpm test已重新执行前后端浏览器布局断言；本轮未新增截图或做目标OS多尺寸实机布局验收。状态保存更少排命令，但正常account_updated发布路径保留，未改前端入口。

保留Go相同active真红（新增Node/Binding/ENSURE）和相同disabled真红（认证版本2→3、RefreshToken重复写）；物理Agent同active真红也实测Node revision2→3。初次物理观测误读不存在的directAppliedRevision列只算夹具错误，修正后才取得真实回归证据；两份失败报告保留、schema/进程先终态后仅清除各自精确临时目录。首次构建命令漏工具链PATH，Go1.23.2在GOTOOLCHAIN=local下拒绝，修正环境后3构建通过；未为此改生产构建器。旧oracle保留Unicode/DTD元数据/search_path/WorkLifecycle观察器原失败及修正，未改旧供给或认证逻辑。

逐文件及完整证据见 `.tmp/ui-qa/round30-completion.md` 与 `round30-final-report.json`；历史失败保留。
