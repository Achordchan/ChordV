# 本地界面与交互验收

所有记录仅针对独立本地 Go 服务及数据库，不使用线上会话或数据。不以脚本直接修改 React 状态、伪造接口或注入假原生桥接作为验收。

## 管理后台

| 状态/操作 | 功能证据 | 布局证据 | 状态 |
| --- | --- | --- | --- |
| 登录初始页、错误密码、正确登录 | 浏览器正常填写与提交；错误提示和真实会话 | 1440×1000 及窄视口截图，无字段/按钮遮挡 | 独立后台已正常填写错密码、出现真实错误，再正确登录；1024×768及1440×1000已查看 |
| 用户、套餐、订阅、团队 | 真实本地创建/编辑/列表刷新 | 表格、弹窗、加载/空状态 | 用户、套餐创建编辑、订阅开通及调整已过；团队创建、40GB共享订阅、添加/移除成员、负责人转移及负责人不可直接移除已过 |
| 节点与任务 | 本地测试节点注册/命令结果及刷新 | 节点、任务列表和抽屉 | 两个节点由真实Agent初始化；失败状态显式夹具。重建后ENSURE/ENABLE正常按钮均200、旧记录消失且新pending只各一条；B标记后过滤空态/查看全部已过；真实故障恢复非本UI专项证明 |
| 公告、路由、工单、图床、设置 | 真实本地接口操作与权限错误 | 密集表格/长文本/模态窗口 | 公告已过；图文成功/503文字保留/纯图失败草稿/延迟双击、预览/搜索/删除、工单关闭重开及只读切换已过；站点地址保存与Webhook随动、密钥掩码/清除自动停用及文件SSE扫描已过；其他设置仍未全验 |
| 去除发布中心 | 无旧入口/上传发布操作；GitHub 版本为只读 | 侧栏及底部版本信息 | 侧栏及只读版本已查看，源码与回归测试无旧入口 |
| 会话退出及断流 | 退出后不能继续查询；SSE 重连或明确错误 | 无无限加载及重复通知 | 后台真实改密撤销其他会话、正常退出/重新登录已过；透明本地转发器销毁SSE后由心跳超时检测重连并收敛，非即时恢复；未穷尽所有过期错误界面 |

## MyGo 客户端

| 状态/操作 | 功能证据 | 布局证据 | 状态 |
| --- | --- | --- | --- |
| 应用首次启动 | 实际 MyGo 进程/桥接就绪，无假成功 | 原生初始登录窗口；内容 660×440 与 macOS 标题栏留白 | 本机真实 MyGo 进程、窗口与截图已查看 |
| 登录错误、登录成功、退出登录 | 正常鼠标/键盘操作，真实 Go 鉴权及安全会话存储 | 主界面 820×560；切换过程中不裁切/错位 | 正常登录/退出、后台禁用自动退出和尺寸切换已过；错误密码前轮已验 |
| 无订阅、无节点、额度耗尽 | 明确业务状态；无伪造连接 | 主按钮与错误文案可见 | 无节点空态、真实管理调整用量后耗尽SSE/重登/恢复已过；额度单变量门禁有真实ControlPanel组件证据；不等同真实Agent流量触发 |
| 本地节点连接、切换、断开 | 真实子进程/端口、服务端租约、系统代理恢复 | 连接中/已连接/失败状态与真实运行状态一致 | 待验证 |
| 日志、路由、订阅、公告、帮助、设置 | 正常操作打开/关闭；信息来自实际状态 | 弹窗、抽屉、长文本、最低尺寸截图 | 原有诊断/订阅/路由/公告已过；帮助开关、记住邮箱、关闭说明、三种未连接模式、更新开关/日志、本地文件复制与Finder入口及原生隐藏恢复已过；帮助外部邮件客户端未验，真实连接视觉仍未验 |
| 工单窗口 | 独立本地 provider，经真实 Go 签票/兑换；桥消息与 SSE，关闭/重开/过期 | 900×680含32px原生标题栏；门户、加载提示与失效提示无横向溢出 | ready、未读7→0、窗口复用、关闭/失效后重新签票、两次加载窗取消后迟到结果不复活均已过 |
| GitHub 未配置、更新/组件下载 | 不访问默认线上发布仓库；签名/哈希/取消/续传 | 缺失配置及进度/失败状态不挡主操作 | 真实 MyGo 已复测未配置态：无下载失败、重下按钮、空进度条或遮挡浮层；已有组件不被误判的分支有真实 hook 测试 |

## 必测异常

- 窗口或会话在异步操作完成前关闭/退出：迟到响应不能恢复旧账户或连接。
- 服务断流、错误凭据、重复点击：不会创建重复连接、无限业务轮询或假成功。
- 内核或主进程异常退出：界面按真实状态变化，系统代理可恢复原始值。

## 证据记录

截图和运行日志放项目忽略目录 `.tmp/ui-qa`；仅完成实际查看的状态才标记通过。

2026-11-17：本轮普通控件创建的独立客户、套餐、订阅均带 `e2e-ui-` 前缀，不是生产 Mock。证据：`admin-subscription-created.png`、`mygo-subscription-sse-30gb.png`、`mygo-revoked-session-login.png`。真实原生输入通过 macOS 鼠标/键盘完成；Socket `eval` 只读取 DOM、窗口尺寸或等待观察到的状态，不修改 React 状态或替代原生桥接。登录总尺寸为 660×468、主窗口为 820×588，其中 28px 是标题栏。

最终重新打包查看 `mygo-source-unconfigured-fixed.png`，底部自定义分流及连接诊断可见，DOM 浮层和进度条均为 0；同一进程正常退出登录后，登录窗口为 660×468、登录按钮可用、浮层为 0，证据 `mygo-source-logout-clean.png`。后台另查看 1024×768 的客户页（`admin-customer-1024.png`），无横向溢出，内容按页面纵向滚动；团队创建表单已打开检查，但未将未保存表单算作团队业务通过。本轮两批临时 UI 数据均按明确 UUID 清理为 0，保留原有管理员、客户和节点。

后续实测已经完成团队完整操作：`admin-team-create.png`、`admin-team-members.png`、`admin-team-owner-transferred.png`、`mygo-team-main.png`；后台“开通订阅”原来只修改隐藏状态，现已改为真正打开绑定所选团队的表单。普通成员移出后真实原生客户端撤权回到登录页，本轮团队/用户/套餐/订阅数据按明确 ID 清理为0。

两条强制公告经 SSE 顺序弹出，初始确认按钮不可用，5秒后才可正常点击；确认落库且没有被错误记为 passive seen。证据 `mygo-announcement-countdown.png`、`mygo-announcement-ready.png`。后台保存后弹窗不关闭的问题已修复；服务端恢复 forced 直接 ack、passive 才 seen 的兼容契约，事务提交后推送当前用户的实际更新 ID。真实路由界面截图为 `mygo-routing-created-edited.png`；缺少 GEO 时明确报错，全局模式真实查询成功，没有伪造命中。

独立工单环境第一阶段使用 API/PG/provider 49646/49647/49648，全部绑定回环地址；GUI PID192正常退出，supervisor85031收到SIGINT后自身与API85062、PG85043均退出，三个监听端口关闭且临时目录删除。脱敏报告 `.tmp/ui-qa/support-e2e-phase1-report.json` 记录 issued=redeemed=3、replayed=0，事件为 ready→unread7→unread0→close→ready→session-expired→ready。工单窗口2复用后关闭，重开窗口3，过期后再开窗口4；最终URL为`/portal`且无票据片段。截图 `mygo-support-portal.png`、`mygo-support-unread-seven.png`、`mygo-support-session-expired.png`、`mygo-support-reopened-after-expiry.png`。主页面只读原生调用允许，工单远端页明确被 Untrusted 拒绝；不以 `window.mygo` 对象存在与否代替权限检验。此前坐标点击未触发的过期动作改用 macOS 可访问性按钮正常点击，并重新观察失效状态，未把未触发点击计为通过。

第二阶段重新创建独立 API/PG/provider 60664/60665/60666，启动器以真实登录→bootstrap→logout 确认1小时1GB有效个人订阅后才 ready。测试门户两次安排仅当前联系人的下一次签票延迟3秒，原生加载窗口3、5分别在710ms和616ms由正常系统关闭按钮关闭；10.9秒和13.6秒后再次观察都只有主窗口，没有迟到复活。两次之后正常入口均立即打开新门户，最终窗口6为`/portal`且无片段。第一张加载捕获早于页面就绪、是白屏，不用于布局通过依据；补充观察到真实加载文案后截图 `mygo-support-cancel-loading-ready.png`，确认转圈、标题、说明均可见。门户新增按钮不溢出，证据 `mygo-support-delay-controls.png`、`mygo-support-reopened-after-cancel.png`。

最终脱敏报告 `.tmp/ui-qa/support-e2e-phase2-report.json` 为 issued=5、redeemed=3、delayArmed=delayStarted=delayCompleted=2、pendingDelays=0；两个迟到票据没有被兑换，不能把“关闭窗口”冒称“HTTP已取消”。请求取消/超时/停止provider不迟到签票由真实HTTP测试另行覆盖。GUI3240正常退出，supervisor2684、API2758和PG2735均退出0，监听端口关闭，独立临时目录删除；宿主`preferences.plist`修改时间仍为2026-10-13 18:50:58。原生输入曾因系统按键丢字符失败，最终通过正常系统粘贴与鼠标提交登录，逐类型保存并恢复原剪贴板，不把AX值变更或未触发的点击算作登录成功。

后台设置补充只读/草稿检查：正常打开工单接入表单，两个密钥均显示未设置、密码输入为空；无配置时“测试连接”明确显示未通过，没有伪造成功。修改地址但不保存后，“测试连接”立即禁用；关闭重开地址恢复空，未保存草稿没有持久化。长表单通过自身纵向滚动可到达保存与测试按钮，未把初始视口看不见底部按钮当成全设置布局通过。证据 `admin-support-settings-unconfigured.png`、`admin-support-settings-dirty.png`；未执行配置保存、清除密钥或线上请求。另查看同步任务真实空态和图床未配置表单，但空态截图不能替代失败任务重试/标记按钮或真实图床上传整链验收。

## 后台队列与图文回复专项清单

以下是待执行清单，不代表已经通过。使用新建的独立临时数据库/API、本机图床与独立Vite，不修改正在调试的3100/5174/55437环境；按正常后台控件操作，不直接修改React状态或替换真实API。

| 范围 | 正常交互与状态 | 功能证据 | 视觉/异常证据 |
| --- | --- | --- | --- |
| 失败任务 | 全局列表、节点过滤、重试、标记已处理、查看全部、处理后空态 | 真实POST返回jobs/summaries，旧任务消失；新命令只生成一次；其他目标不消失，摘要与SSE收敛 | 1440×1000与1024×768；任务长错误、重复点击/忙态、处理后控件不残留，不崩溃 |
| 图床 | 保存本机地址/Token、重开不回显密钥、留空保留、文件搜索/预览/删除 | 真实图床授权请求、PNG可渲染、删除后文件及列表消失，不把未配置当成功 | 配置/文件表/空态，长文件名和图片不横向溢出；不保存公网配置 |
| 图文回复 | 文字+图片成功、图床503时保留已保存文字、纯图片失败草稿、关闭/重开、切换只读 | 真实工单详情及消息条数、附件绑定/消费，失败状态与错误提示一致，无重复文字或假附件 | 普通/密集消息、图片预览、失败提示及草稿；窄视口操作可达，已关闭/只读不能继续提交 |

重试耗尽状态若通过测试SQL按明确ID准备，必须记作界面契约夹具，不宣称为真实Agent物理故障；物理Agent/Reality另有已运行整链。至少覆盖两条非顺利路径：重复动作期间的busy门禁、真实图床失败时的文字保存/纯图片不保存；外部生产图床与宿主代理不属于本专项的已通过范围。

### 专项实测结果

- 初次启动真实暴露psql在JSON后附带`INSERT 0 1`命令标签，准备失败且独立进程/目录已清理；修复为真实psql `-q`，仍直接解析完整JSON，不截尾兜底。真实临时PG的SELECT/INSERT/UPDATE RETURNING及SQL错误专项通过，之后重新prepare启动，不复用已删计划。
- 一期API/PG/图床/Vite为57229/57230/57231/57232，源码二进制SHA256为`d1729f894370af5eb4dd907ec4c63bb405a76ae476b8cd66b020ef63244fe682`。真实节点/绑定由生产Agent安装完成，停止Agent后再准备3条cancelled UI夹具；正常任务重试500是实际失败，不记通过。根因是通用records CTE别名result与任务result列同名，NULL被误当整行；私有schema红绿后两处改为`to_jsonb(result.*)`。另B成功标记200时全局A保留2条，但过滤页错误显示“最近0条仍有其他”，后由真实组件回归和条件渲染修复。
- 一期正常图文回复200/uploaded，消息1→2、附件0→1，浏览器实际PNG为480×240；预览、中文长文件名已查看。真实图床503时200/failed且文字只保存一次，消息2→3、附件仍1；纯图片503返回502且附件草稿保留、未创建消息。1500ms真实延迟期间正常双击只新增一条图文，消息3→4、附件1→2。1024×768详情使用原有整区滚动与吸底回复框，实际滚到末尾确认末条消息和发送入口均可达，无横向溢出；不把初始只看到部分历史记录当完整阅读证据。
- 图床Token输入留空正常保存后仍能鉴权读取文件；重开密钥不回显。真实搜索缩小为1行，确认删除返回稳定success/fileId/deleted/failed，正常成功通知且该图片URL实际404。provider报告uploaded2、deleted1、http503为2、延迟完成1；其余内存文件在stop清空，不把stop后的files=[]说成两张都曾被删除。
- 站点地址正常保存为同一API的localhost别名后，工单设置Webhook实际随动；通过正常表单配置本机支持站点并启用，旧工单回复/关闭入口立即消失，历史仍可读。正常清除Webhook Secret自动停用接入，旧工单恢复可写；两个密钥重开均不回显。关闭/重开工单、退出回登录页均通过。
- 二期65082/65083/65084/65085使用统一修复后的二进制`76eb3bea30e7c8c25eb39ebd91a9e44d4bf89ceeaf8ac26e1a6f2dafe9acaddd`，仍保留SQL NULL而非填{}。正常ENSURE/ENABLE重试都200且旧任务消失、节点A仅产生2条真实pending；B标记后正确显示空态，查看全部仍保留A。480×351空态弹窗在1024×768内完整可见，无横向溢出，页面异常0。随后正常文件扫描经SSE完成；没有把0可清理文件的页面当真正删除满24小时文件的证明。
- 两期均正常退出浏览器/Vite，再SIGINT独立supervisor；API、PG、图床、Xray helpers全部退出，监听关闭、临时根目录和凭据已删。一期另启本机支持provider也已先停。测试观察工具曾重建，仅重建已退出的自有测试浏览器，未因观察超时重启应用或数据库。

主要证据位于`.tmp/ui-qa/`：`admin-ticket-image-success.png`、`admin-ticket-preview.png`、`admin-ticket-partial-503.png`、`admin-ticket-1024-scrolled.png`、`admin-image-deleted.png`、`admin-ticket-readonly.png`、`admin-queue-filtered-empty-bug.png`、`admin-queue-filtered-empty-fixed-1024.png`、`admin-queue-retry-pending-fixed.png`、`admin-storage-scan.png`、`admin-queue-phase2-ui.json`及两期`admin-ui-phase*-report.json`。原先独立原生工单报告以`support-e2e-phase1/phase2-report.json`为准；初次后台wrapper在旧模块加载时曾覆盖output默认同名工单报告，现已分开报告文件，不能拿被覆盖的单文件替代此前原生GUI证据。

## 后台账号安全、策略与真实断流补验

- 使用新建的独立PG/API/后台（51487/51486/51488），禁用provider；正常浏览器登录，不改主3100/5174和public数据。错误当前密码真实返回403且仍可操作，密码不一致时保存禁用且不发送更新；正常改密200后当前会话保留，另一正常登录会话经SSE自动回登录页。重开安全表单仅保留账号、密码为空且修改开关重置；随后恢复原密码，正常退出并用原密码重新登录成功。没有输出密码、会话令牌或真实用户数据。
- 连接策略完整操作：默认模式不在允许模式时显示错误并禁用保存；正常保存全局/直连模式、广告拦截与AI路由，关闭重开从真实API读取；另一会话更新不会覆盖本地未保存草稿，丢弃草稿后重开读到最新服务器配置。最后恢复规则模式、三种允许模式、广告/大陆直连/AI代理的原值，重新读取确认。
- 初次浏览器offline测试没有证明已关闭现存SSE，不计作断流通过。之后仅在测试侧增加透明HTTP转发器（53195），不伪造API响应；明确销毁两条活跃SSE，断流期间从另一会话保存策略，旧视图不假装同步。Vite转发未立即通知下游结束，最终由现有心跳超时检测abort并重连，正常接收resync后自动显示新模式，无手工刷新、无重启API/数据库。报告保留实际请求时间和`net::ERR_ABORTED`，不将其写成固定3秒或60秒内恢复。
- 1024×768与1440×1000检查安全表单、模式选择、校验文案及保存入口。安全长表单通过正常滚轮滚动后当前密码、会话说明和底部按钮均可达；未用强制点击绕过遮挡。观察到原有右下角成功通知曾短暂覆盖保存按钮，通知消失后继续；该观察保留为后续层级改进项，不宣称所有通知叠层已验收。
- 所有自建浏览器、Vite、透明代理、API、PG正常停止，四个端口关闭、临时根目录及凭据删除；主supervisor25814/API25861/Vite25898/PG12027在本专项前后未变。宿主代理配置时间仍为2026-10-13 18:50:58。

脱敏报告：`.tmp/ui-qa/admin-settings-ui-report.json`、`admin-settings-proxy-report.json`。截图：`admin-security-wrong-current.png`、`admin-security-mismatch-1024.png`、`admin-security-scrolled-bottom-1024.png`、`admin-security-other-session-revoked.png`、`admin-policy-invalid-default-1024.png`、`admin-policy-changed-1024.png`、`admin-policy-real-stream-reconnected.png`、`admin-policy-restored-1440.png`。`admin-policy-toast-overlap.png`捕获时通知已消失，不能单独证明遮挡；真实遮挡同时见工具点击日志及`admin-security-scrolled-bottom-1024.png`。

后台队列二期报告的夹具来源标签另已精确修正：以原始明确job IDs/dedupe为来源，不再依据会被supersede修改的lastError。两份报告各2条来源标签false→true，9条任务和2条真实pending的身份/状态不变；`admin-ui-isolation.test.mjs`4项通过。纠正记录为`.tmp/ui-qa/admin-ui-fixture-origin-correction.json`，不把标签纠正写成重新运行业务或物理Agent故障验收。

## 客户端真实设置与凭据清理补验

独立本机API/PG为52368/52369，测试GUI使用独立bundle ID `app.chordv.settings.qa`、本地数据与自动化socket，不覆盖普通构建或生产App359。输入均为正常系统鼠标/键盘/可访问性控件，eval只读取DOM；没有点击连接、没有系统代理写入。源码并无独立设置页、开机自启动或可切换关闭策略控件，不虚构此类验收。

- 帮助正常打开/关闭，说明和联系邮箱可见。记住邮箱false→true→false→true；首次关闭说明取消记忆后刷新订阅重新出现，恢复记忆确认后重开不再出现。规则→全局→直连→规则均为未连接模式变化，不将其写成实际代理切换。
- 更新选项false/true→true/false，关闭重开保留，再恢复false/true；重新启动进程后配置仍为stable/on。更新日志先真实暴露“未配置GitHub”却显示网络失败/重试，修复后新GUI明确说明未配置且重试按钮0个。组件浏览器另覆盖已配置503→重试→空历史，未配置时0外部请求；旧stable重试延迟至beta已显示后才返回的红测先失败，修复为统一effect清理后不会覆盖新通道。
- 真实退出先暴露“记住邮箱”开启时内存密码仍64字符，持久存储实际只有email，未记录密码内容。修复后GUI34004正常登录→退出为email64/password0，正常退出并重开GUI36802仍email64/password0；取消记住邮箱后登录/退出同样password0且无持久凭据。实际hook回归还验证停止内核/清除存储失败也先清空密码，原异常不吞掉，不把失败冒称退出完成。
- 本地文件弹窗六行来自真实独立目录，首末行正常复制后与实际路径匹配并恢复剪贴板；系统滚动scrollTop81可到末行，无横向溢出。缺失末行路径的打开按钮实际在Finder选中其存在的独立上级目录，随后关闭自建Finder窗口。原生隐藏与红色关闭按钮只隐藏原窗口，系统显示菜单恢复，Cmd+Q退出，无第二GUI并行。

原生登录660×468、主界面820×588（含28px标题栏），文件弹窗560×529.1875；已查看普通/滚动/错误修复后截图，未改CSS。固定新GUI二进制SHA256为`5bc6e8421a24c1fe0ba8107f16913bac5f188bdb7698d61ed2bc0c94bdba4c54`，不将其当作正式发行包。最终所有自建GUI、supervisor27680/API27710/PG27691退出，端口/socket/临时根目录及独立bundle缓存删除；生产App359不动，宿主代理文件mtime/size原样。

完整报告`.tmp/ui-qa/client-settings-gui-report.json`，清理证明`client-settings-isolation-cleaned.json`；主要截图`mygo-settings-account-help.png`、`mygo-settings-close-hint-initial.png`、`mygo-settings-update-default.png`、`mygo-settings-update-changed.png`、`mygo-settings-release-history-unconfigured-fixed.png`、`mygo-settings-local-files.png`、`mygo-settings-local-files-scrolled.png`、`mygo-settings-logout-password-cleared-fixed.png`及`mygo-settings-reopened-email-only-fixed.png`。真实连接、额度耗尽、帮助邮件客户端实际启动仍未以这组未连接设置测试替代。

### 帮助邮件入口的追加边界修复

设置专项之后，源码复核确认现有发送邮件生成`mailto:`，原生却只允许HTTP/HTTPS；真实`DesktopService.Invoke`红测复现拒绝。现原生仅增加经过校验的单个收件人mailto，允许现模板的subject/body与正文LF，拒绝其他协议、未知/重复参数、多收件人、头注入/控制字符、多层编码和超过16KiB地址；HTTP/HTTPS中的编码控制字符也不再进入系统执行器。

原生测试只在串行测试进程临时替换包私有OS执行器，并用`t.Cleanup`恢复，生产默认仍为唯一`commandOutput`，无环境变量/配置旁路。验证真实Invoke至系统命令参数及错误传播，不启动邮件客户端、不发送邮件。前端捕获拒绝及`ok:false`，显示固定中文提示、保留联系邮箱；忙态防重复，关闭重开清错，旧弹窗迟到失败不能回灌新弹窗。

实际LoginScreen组件在独立Vite/Chrome测试中覆盖失败/false/成功和延迟忙态，测试原生传输替身仅存在于`test/fixtures/login-help-email.tsx`。主流程已独立查看稳定白底`login-help-email-reject.png`，660×468内内容与关闭/发送按钮可达；早先过渡透明截图已覆盖，不据旧截图验收。没有修改CSS、启动新整套服务或真正邮件应用，真实系统默认邮件客户端启动仍为未验证。

## 额度耗尽与后台通知收敛

### 真实额度状态

- 全新隔离API/PG为62963/62964，GUI使用`app.chordv.quota.qa`。真实管理员`PATCH /api/admin/subscriptions/{id}`调整usedTrafficGb 0→1→0，state输入active、由服务器计算为exhausted/active；不是SQL夹具或真实Agent流量计费。原生GUI不手工刷新，112ms左右收到耗尽SSE、116ms左右恢复，显示1GB→0GB→1GB。耗尽连接API真实409“当前订阅不可用”，并无专属exhausted code；独立DB租约/计费记录均0，节点0，sourceAction为adjusted。
- 耗尽重新登录实际暴露无节点误报：服务端故意不给非active订阅节点，客户端却提示未分配节点。只将该提示限定为active订阅且空节点；8个状态/节点组合回归先红后绿。修复GUI42594耗尽重登alerts为空，恢复后耗尽说明消失；有效订阅确实无节点时原提醒仍保留。
- 真实GUI基线与恢复都因组件未配置而禁用，未把disabled→disabled当额度门禁证明。独立实际ControlPanel组件仅改变额度，其他可连接条件保持满足，验证正常点击可用→耗尽禁用且回调不触发→恢复可用；只证明组件门禁，不证明物理连接。主流程查看`mygo-quota-exhausted-login-fixed.png`，其余稳定截图见报告。旧误导错误以真实DOM与hook红测为依据，`before-fix-state-only`截图没有拍到toast，不用作错误视觉证明。

全部自建GUI/API/PG/观察SSE/会话、socket、临时根与独立bundle缓存已清理；宿主代理未写，生产App359和主本地进程保持不变。报告`.tmp/ui-qa/client-quota-gui-report.json`、`client-quota-observations.json`、`client-quota-db-proof.json`、`client-quota-isolation-cleaned.json`。

### 通知与弹窗操作

- 通知遮挡已从“观察项”改为真实修复：单一`AdminNotifications`复用原Mantine store，将固定宿主节点移到最上层Modal/Drawer的独立反馈区；表单和反馈各自滚动，不点击穿透、不缩短6500ms、不关闭长错误或重建通知计时器。只识别Modal/Drawer内容，普通下拉浮层不接管；关闭弹窗后原通知节点回到页面、自动关闭及队列继续。CSS只在活动反馈容器/弹窗的模块作用域内生效。
- 初次组件红测正常保存后命中测试失败，实际按钮被通知覆盖。移入反馈区后另查出AI分段控件内部z-index=2穿出并盖住sticky底栏z-index=1；仅在该选择器加isolation隔离，不抬全局z-index。实际PoliciesPage、AccountSecurityModal、Drawer及嵌套Modal覆盖连续保存、全部队列关闭、长错误滚动/选取、关闭重开、DOM节点身份与onOpen不重复/自动消失；1440×1000、1024×768、390×640均检查。长错误回到页面后末尾请求编号仍可滚动读到，不受原200px动画上限截断。
- 一期真实隔离后台49402/49404正常连续保存200、通知在弹窗内，页面异常0；同时真实发现SSE刷新切骨架屏令滚动归零。随后`loadSettingsPolicy`对后台事件改静默刷新，并在响应提交前再次核对编辑/保存状态；初读骨架与失败错误门禁保留。两项新红测分别捕获loading=true和迟到覆盖，再先绿后复验，不把一期归零写成通过。
- 二期全新51919/51921后台再次正常保存，并由另一真实管理会话更新策略触发SSE：表单DOM仍是原节点，滚动143→143，页面异常0。再只延迟真实GET的发出，不伪造响应；请求在途时正常选择规则模式，迟到200没有覆盖草稿，关闭重开读到服务器直连模式。主流程独立查看`admin-feedback-policy-sse-scroll-preserved.png`，AI路由、保存按钮、反馈均可达。

两期独立PG/API/Vite、调试Vite和Chrome均停止，临时目录/凭据删除。证据`.tmp/ui-qa/admin-notifications-red.log`、`admin-notifications-green.log`、`admin-policy-refresh-red.log`、`admin-policy-refresh-race-red.log`、`admin-feedback-ui-phase1-report.json`、`admin-feedback-ui-report.json`；主要截图`admin-notifications-policy-red.png`、`admin-notifications-security-1024.png`、`admin-notifications-security-390.png`、`admin-notifications-drawer.png`、`admin-feedback-real-policy-1024.png`与`admin-feedback-policy-sse-scroll-preserved.png`。早先`admin-feedback-real-policy-scrolled.png`仍是归零状态，不用它证明修复后滚动保持。

## 真实连接与内核退出（文件代理隔离）

独立MyGo GUI正常系统输入完成B连接→断开→A连接，真实HTTP CONNECT经global-all-proxy规则、Xray及本机Reality节点往返每次65536字节一致；又在修复后重复A连接与真实流量。只终止核实父PID/路径后的自有Xray，看到真实异常与测试JSON恢复，不触宿主代理。

首轮发现异常时误写“内核已启动”且留旧端口；ControlPanel已改为真实状态/PID（Android为vpnActive）驱动运行标签和活跃端口。真实组件10场景×2视口先红后绿；修复版GUI60268/Xray60303重新验证异常、已停止、HTTP/SOCKS --及正常清理后已安装。主流程查看`runtime-gui-fixed-core-exit.png`、`runtime-control-stopped-390.png`，主视图820×588与移动组件均完整；没有CSS修改。

最终check6/6、test92/92；真实GUI证据`runtime-gui-final-proof.json`。全部自有GUI/echo/双Agent/双节点/API/PG及独立缓存/root/socket清理，原App359和主本地环境不动。手动预置资产不是GitHub下载安装证明；文件代理和同进程pipe stand-in不证明宿主代理、独立watchdog或父进程崩溃恢复。详见`local-verification-20261117.md`第11节，不沿用第一轮故障截图或旧SHA冒称修复后通过。

## 独立父进程强杀、团队范围与累计用量

最新以本地验证记录第12节为准：真MyGo父GUI65485被单独SIGKILL后，独立watchdog67649恢复文件代理、删除journal、杀自有Xray67647并退出；真实子进程与main路径，不再是同进程stand-in，仍不是宿主OS代理验收。

团队真实UI验证了初始空选的指定成员重置、默认团队断连保留成员/其他成员活跃租约、个人转团队停用而非删除历史。双真实生产Agent/Reality多批计量又暴露原始ledger与永久缓存错误：最终每用户3条实际账本，14680064B/29360128B→界面0.014/0.027；真实SSE更新保留原Modal/table，额外usage请求0，浏览器异常0。

生命周期持久提示现为正常流条件反馈，40px真实反馈不覆盖头部操作，个人/团队820×588主连接及诊断均可达；长57px反馈和660×468/390×760双错误登录另有真实组件点击/bounds证据。真GUI重连自动清除旧中断反馈，实际打开公告、诊断、完整详情和更多菜单。最终截图`lifecycle-feedback-real-team.png`、`team-usage-sse-real-fixed.png`已主流程查看；完整proof与失败观测边界见第12节。

最终check6/6、test98/98、普通/e2e真资产全量race及普通构建通过；两轮自建环境和独立缓存全部清理。正式签名、旧安装升级、宿主代理及其他实机仍未验。

## 第13节正常订阅与连接预检

全新65099API/65102后台正常点击续期，0.25GB保持并从12月17日顺延至1月17日；正常变更5GB套餐仍保留0.25GB。关闭工单入口时点击测试连接200、全部资料接受，测试前后开关仍关闭。390×760续期预览/确认按钮完整、无横向溢出；1024×768变更与工单窗口另验，页面异常0。未改CSS/DOM。证据`round13-normal-ui-proof.json`、`round13-support-ui-proof.json`，人工查看`round13-renew-390.png`与`round13-support-disabled-tested-clean.png`。

CLI错误角色探测/会话关闭与初次短时旧通知遮挡不算最终通过；已用既有Playwright运行时在可控独立上下文重验，没有安装新驱动或伪造HTTP响应。最终check6/6、test99/99、完整race/普通构建通过；两套自建环境全部清理，主服务/代理未改。真GUI自动安装、正式签名与旧版过渡仍未验；macOS自动复制替换/重启当前尚未实现。完整索引见本地验证第13节。

## 第14节本地自动安装与契约补充

安装忙态同步防重、Mac准备后身份/渠道变化及失败会显式取消，取消失败可见；安装时暂停自动组件同步并禁用连接、渠道、关闭、检查及冲突入口。820×588/820×560/390×480真实Chrome点击/几何与loader边界通过，主流程已查看output/playwright的update-center-busy与update-progress-busy截图；无CSS修改，旧runtime出口不变。最终check6/6、test99/99；独立候选原生替换/启动与拒绝回滚另有完整race证据，但完整新GUI健康/旧版本安装、正式签名及宿主代理未验；用户明确暂不授权宿主代理修改。第14节是最新权威范围。

### 第15节真实首屏就绪与离线恢复（2026-11-17）

真实完整App浏览器在saved-session认证永久挂起时仍能输入登录、打开帮助并发一次login ACK；窗口pending/failed不确认，ACK拒绝保留明确中文提示且不自行退出。新手动登录后释放旧网络请求，账号和落盘凭据保持新身份。最终660×468、820×588、390×760登录、820×588干净主屏与ACK失败截图已人工查看：过渡结束、测试公告和关闭说明已真正关闭，未拿中间残影图当通过证明；没有CSS改动。截图`.tmp/ui-qa/app-readiness-*.png`，红绿和五项认证归属日志`.tmp/frontend-split/app-readiness-*`。

浏览器隔离原生边界不代替真实程序：普通打包ChordV 1.1.12/build15另经真实DMG/签名receipt/父EXIT/原子交换后，由Go startup与实际React首屏双门禁完成健康确认（最终race21.923秒，API127.0.0.1:1不可达、无代理journal）。不操作生产App和宿主系统代理。完整门禁、42文件索引、签名公证及自动恢复未完成项详见`local-verification-20261117.md`第15节。

### 第17节：真实存储空间与错误态布局

独立临时PG/API/Vite，普通Chrome登录后台→系统设置→管理文件→扫描，真实SSE complete恢复磁盘可用空间提示，不用旧主API或注入假snapshot。1000/390正常态已查看，390表格在原有横向滚动容器内可到操作列，磁盘提示正常换行，fresh临时文件与保留文件均不可清理。

停自有API得到真实500后，390错误Alert内文字实际被裁切（client315/scroll339），红图保留，不以容器外框在viewport内当通过。只修本页5错误入口复用readError、bare HTTP通用中文映射和局部Alert body/message收缩断行；具体业务错误与请求编号保留，不改全局CSS。同一环境HMR和同样API停止态复验，390 Alert315/315、内部283/283，1000内部816/816，中文完整，旧结果保留；两张fixed图已人工查看。恢复自有API后HTTP200/SSE complete，Alert0、磁盘提示14.90GB；两张恢复图已查看，临时进程/根/凭据和端口全部清理。图片/量测见round17-storage-ui-proof.json和output/playwright/round17-storage/。最终check6/6、test103/103通过。完整门禁及25文件索引见local-verification-20261117.md第17节。


### 第18节：无前端改动的布局复核范围

本轮修改启动/服务端契约、发行内容校验及Linux代理适配，不改任何React组件/CSS。完整冷启动后台HTML和正常凭据登录是服务就绪证据，不当浏览器渲染截图。最终统一测试继续覆盖现有布局浏览器回归，普通build18实际完整GUI更新健康门禁另验；具体最终check6/6、test103/103通过；普通build18实际完整原生+React更新健康race26.694秒，最终结果见本地验证第18节。宿主代理/现有主GUI均未操作。


### 第19节：无前端改动的视觉边界

本轮仅原生组件持久一致性、Node业务契约与生成工具、旧发布协议阻断；无React/CSS改动。已检查新恢复错误沿用现有启动反馈/详情呈现；最终统一测试仍覆盖既有登录/忙/错误/双视口浏览器回归，普通build19实际完整GUI更新健康另验。Linux容器和Go测试不替代桌面视觉/宿主代理实机；具体最终门禁见本地验证第19节。


### 第20节：真实会话与安装契约补验

本轮不改React/CSS；GNOME会话profile和watchdog恢复仍走既有错误/恢复反馈，需沿用最终统一浏览器布局门禁，不把Linux后台测试当图形桌面视觉。具体本轮验证见本地验证第20节。


### 第21节：passive与恢复目标一致性

本轮恢复命名空间和路由契约不改React/CSS；Windows/P仅绑定原生目录/完成PRE并保留进度页，不把无Windows动态截图视为安装器视觉完成。统一浏览器和普通build21原生+React健康边界见本地验证第21节。

## 第22轮补充

第22轮未改React/CSS或任何界面组件。已检查panel返回/拒绝语义对PanelInboundForm调用链的影响，保留原payload和错误入口，未增加卡片/提示或测试按钮；Linux测试夹具仅test文件、Windows工具仅QA，不进入生产UI。最终全浏览器回归及普通Mac build22原生+React健康结果见local-verification-20261117第22节；Windows安装器可视布局/进度无目标系统未验。

## 第23轮补充

第23轮没有React/CSS组件修改。已检查panel回执返回/拒绝与useInboundDeployment：completed以exact command outcome确认，failed/cancelled已有中文失败状态；不新增兜底轮询或测试入口。Linux默认GIO/C消费者只在testdata/*_test.go，Windows修改只在QA。统一浏览器与普通Mac build23原生+React健康结果见第23节；Windows安装器真实视觉仍未验。

## 第24轮布局影响

无React/CSS/组件样式修改，检查公告App/AnnouncementDrawer countdownSeconds消费和后台公告保存调用链：后端恢复默认5秒/模式转换/公共字段与精确事件，不新增卡片、提示或测试入口。Linux改动仅测试/CI；发布器改动不进入UI。统一浏览器与普通Mac build24完整原生+React健康结果见第24节；Windows安装器视觉和新公告真实桌面操作未执行，不能用接口正控冒充。

## 25. 本地发布恢复、计量保留与当前真实内核复核

未修改React/CSS；已核对MeteringFloatingBanner状态条件、portal、data-metering-notice与两种中文消息消费链；统一浏览器回归和现有build24完整原生+React健康通过。静态另发现手机定位选择器依赖.desktop-app--mobile祖先，但banner portal在body，现规则不能按该祖先生效；尚未专门复现/修复计量异常手机定位，不把通用绿测冒充该视觉场景通过。

未改UI源码；普通build24真实GUI健康仅证明无网络启动/更新ACK，不是计量异常/Windows视觉验收。

## 26. 计量提示定位与用户安全写入契约

已实际核对截图与几何：修前390×844下banner.bottom=826/nav.top=758，提示覆盖导航；移除Portal后752/758，间隔6px。Chrome真实组件/完整生产CSS＋代表性应用壳，Android/iOS平台类、320—844宽/390—844高、横屏、同步浮层、正常/空消息/转场共14场景通过；桌面820×588提示与浮层几何逐字段等于修前基线。最终收窄Vite根目录后14场景再次通过，截图位于output/playwright/round26-metering-layout。不是iOS设备/WebKit/Android原生整机或Windows WebView实机证据。

唯一生产前端修改MeteringFloatingBanner.tsx；不新增CSS/全局样式/平台属性。初始临时Vite以项目根观看到DMG Applications链接产生HMR噪声，未执行安装/修改Applications；已收窄到apps/desktop根、favicon204并完整复跑14项，最终console0error/0warning，自有服务关闭。本轮未重跑完整原生e2e race：没有修改原生Go代码；新前端以完整浏览器回归、新build26真实GUI健康验证，原生普通组仍由pnpm test执行。布局CLI夹具/验证脚本仅留ignored证据，未接为仓库常驻CI入口。Node20.19未在本机执行，当前运行Node25.5。

## 27. 租约、认证恢复与签名发布协议

真实完整App隔离边界4项（含2认证子例）通过；首失败/503/2xx终态/旧响应/Native不双判停及lease-ended持久反馈均覆盖。820×588与390×760截图已查看，横向溢出检查通过；未改组件CSS/全局样式，不当作目标OS实机布局证明。

原始失败完整保留：首次中间check7/7、test106/106与旧DB779/Native396不是最终源码。最终第一次全量109/110的唯一失败来自新完整App夹具SSE握手返回ok而非streamId，触发浏览器fallback；旧hostname路由允许其他本地端口，造成新身份另一次恢复遇到旧身份专用假回复。只修测试streamId/open、按token归属回复与精确fixture-origin，三保护断言逐字保留；故意损坏握手仍被网络守卫抓住，旧裸App在正确夹具下两保护仍红，独立真实订阅/hook/路由矩阵复核通过。不能回溯声称此前没有本地API读请求或进程日志/内存改变；最终不转发到非fixture origin，public行摘要不变。

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

### Build 97 与旧版更新中心对照（820×560）

从两个生产前端产物分别登录同一临时 Go API / PostgreSQL 账号，点击主页“检查更新”。两版弹窗均为 500×504、左上角 (160, 28)，均可用可见标签打开和关闭测试版通道、进入更新日志、返回更新中心及按 Esc 关闭。新版底部“检查更新”的下边缘为 y=516，在弹窗下边缘 y=532 以内；旧版为 y≈551。新版在未配置 GitHub 仓库时显示“未配置来源”，日志页不提供无效重试，本次未调用旧版本查询或历史接口；旧版实测调用这两个本地兼容接口并收到 503。两版都未出现页面或弹窗横向溢出。截图与请求明细在本机 `.tmp/ui-qa/round103-update-ui-e0V5Ov/`。此项使用 Chrome 和阻断外部请求的本地环境，不代替真实 GitHub 下载、原生标题栏或已配置渠道的验收。

### Build 106 与旧版公告中心：已读互认及视觉对照

旧版 `397a64d` 与 Build 106 的生产前端连接同一独立回环 Go API / PostgreSQL。管理接口创建两条普通公告；同一临时账号从三个全新浏览器上下文依次登录旧版、新版、旧版。旧版阅读第一条；新版仍显示第二条未读，阅读第二条后切回第一条；重新登录旧版后两条均已读。服务端实际只收到两次 `POST /api/client/announcements/read`，两代客户端各一次、均返回 200，最后重新打开没有重复写入。

同一 Chrome、820×560 窗口内，三次弹窗的左上角都是 (100,70)，大小 620×420，无横向溢出，Esc 可关闭。两条已读且选中第一条时，对新旧截图的弹窗区域逐 RGB 像素比较，260,400 个像素中差异为 0。截图、HTTP 状态和像素统计：`.tmp/ui-qa/round113-announcements-2pSK24/`。这是浏览器内普通公告证据，不覆盖原生窗口外观、强制确认、倒计时或正在运行的旧客户端热切换。

### Build 106 与旧版：强制公告确认跨版本保留

在本地 Go 服务和独立 PostgreSQL 为同一临时账号先后创建两条公告。旧版 `397a64d` 登录后必须手动确认第一条；其后发布 5 秒倒计时公告，Build 106 在全新浏览器上下文中登录，只弹第二条。两次弹窗在 Esc 和点击背景后均保留，且未发确认请求；新版倒计时期间按钮禁用，结束后点击才提交。请求内容和响应逐条对照：各一条 `ack`，对应各自公告 ID，均返回 200。最后重新登录旧版，两条公告的详情均为已读，未重复提交。

同一 Chrome 的 820×560 窗口内，两种弹窗定位完成后均为 x=180、y≈196.95、宽460、高≈166.09。第一次在旧版入场转场中取样得到 y≈169.09，与稳定位置不同，未作为最终视觉结论；另建新库，等待实际居中后完整复跑。证据：`.tmp/ui-qa/round114-confirm-t7tnp0/final-results.json`、`old.png`、`current.png`。倒计时是界面交互测试，不代表服务端强制计时或原生窗口验证；未连接线上。

### Build 106 → 116：真实公告推送不再重置倒计时

两份已打包版本的生产前端分别在同一 Chrome、同一临时 Go API/PostgreSQL 中登录。每轮创建 8 秒强制公告，在按钮显示剩余 4 秒时，通过管理员 API 修改同一公告的标题，不改 ID、模式或时长。前端通过当前已建立的 SSE（服务端事件推送）取得变更；没有刷新页面、注入事件或伪造响应。Build 106 显示新标题后回到了 8 秒，自提交修改到按钮可用实测 8,459 毫秒；Build 116 保持 4 秒，实测 3,898 毫秒。两次均无提前确认，实际点击后各收到且仅收到一条对应 ID 的 `ack`（HTTP 200）。计时为单次浏览器观测，不是精度保证。证据在 `.tmp/ui-qa/round117-live-countdown-Ed00gr/results.json`；本项不是原生 WebView/SSE 桥接测试。

### Build 116 安装包内的原生公告事件通道

将两个 Mac DMG 先前解出的可执行文件重新与各自已验证的包内 SHA-256 比对，再用独立数据目录和真实本地 API 签发的用户会话启动（不自动化登录表单）。分别在 ARM 原生与 Rosetta x64 进程中，待前端记录 `native stream opened` 后，通过管理 API 新建普通公告；仅截取新建操作之后的诊断记录，确认原生桥接发出 `announcement_updated`，React 的 `client-events-hook` 已接收。两次均未记录浏览器 fetch 备用流或产生系统代理恢复文件。证据：`.tmp/ui-qa/round118-native-events-hBnNBb/{result.json,intel-result.json}`。测试只证明打包应用的原生推送链，不把接收日志当成弹窗视觉或人工点击证据。临时应用进程、API、数据库已停止，临时客户端数据及会话已移除。

### Build 116：在包内原生窗口完成公告确认

对两个已核验摘要的 Mac 包内程序，分别使用本轮临时账号、独立会话与回环 Go API。通过 macOS 辅助功能只观察指定 PID 且可执行路径匹配的窗口，在按钮显示「请等待 5s」且禁用时，管理 API 改同一公告标题。两版窗口均显示新标题，且仍为 5 秒、按钮禁用；此时客户 API 的 `acknowledgedAt` 仍为空。按钮变为可用的「我知道了」后才对该按钮执行 AXPress，随后从客户 API 读到对应公告的确认时间，窗口内公告关闭。两次均记录原生事件，未走浏览器备用流。证据：`.tmp/ui-qa/round119-window-R1YUZA/{result.json,intel-result.json}`。ARM 原生执行，Intel 为 Rosetta；辅助功能观察证明控件状态和操作，不等于像素级截图比较。未改生产代码、未使用宿主系统代理。

### Build 150：与旧版客户端的视觉对照（2026-11-23）

在相同 Chrome 与窗口尺寸下，用旧版和 Build 150 生产前端对照。660×440 和 390×760 的登录页与账号帮助弹窗共四组截图逐像素相同。另以同一隔离账号登录本地 Go 服务，在 820×560 复核主页、分流、诊断：主要控件与弹窗位置一致，三页均无横向溢出。主页保留新版节点未分配提示，不还原旧版同步失败误报；分流弹窗内有 117 个差异像素，不能记为完全一致；诊断整页像素相同。截图、测量与接口结果在 `.tmp/ui-qa/round160-visual-L3DeT1/` 和 `.tmp/ui-qa/round161-signedin-U6P3xd/`。这些结果不包含系统标题栏、Windows 实机及深色模式。

Build 191 用同样三种窗口尺寸与旧版 `397a64d` 重新对照，共七组、十四张截图。两组尺寸下的登录与帮助、820×560 的连接诊断逐像素相同；主界面和分流弹窗主要控件坐标不变、无横向溢出。主页保留节点未分配说明并移除旧同步失败误报；分流弹窗内仍有 117 个差异像素（不把弹窗外的底层变化计入）。新旧两侧真实登录同一独立 Go 服务，登录、初始化和节点查询均返回 200，非回环请求被浏览器测试拦截。截图与量测见 `output/playwright/chordv-build191-visual/`，这不是 Windows 或原生标题栏的像素证明。
