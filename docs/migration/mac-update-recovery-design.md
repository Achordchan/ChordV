# macOS 更新 journal 持久恢复设计

状态：启动时已检查固定恢复记录是否存在，并通过现有通知提示结果待确认；不会读取记录中的路径或执行恢复。完整只读 inspector 仍是专项诊断，未接入自动回放。依据第 14 节及当前 mac_update*.go；已修好的准备取消、ARM 取消、target 锁与 FD 检查不是本轮新缺陷。健康 ACK 由原生主流程实现，本设计只消费其已验证结果。
边界：保留原目标路径；不操作宿主代理、不触碰主 App/服务/数据库、不添加后台服务。SIGKILL 验证不等于断电验证；open 返回成功不等于健康。

真实事务已增加卷 UUID、文件 ID、创建时间四端锚，新进程可只读检查；自动恢复仍未接线。第 16 节实证传统 file-based Keychain 即使收紧访问控制，仍不能作为受保护授权的完整性来源。第 192 轮已将正常更新助手换为完整 `helper.app`，解决裸 Mach-O 缺失签名 `Info.plist` 的问题。Data Protection Keychain 仍须正式签名、profile 和共享 access group 做正反验证，未引入普通文件密钥或弱 Keychain 实现。

## 1. 最小可实现范围与信任锚

第一版只恢复“原路径仍存在、旧/新 bundle 身份都可验证、已有可信持久 intent”的更新。交换前中断默认保留旧版、不擅自继续安装；交换后没有健康确认默认回滚；健康确认已持久化才提交并删除备份。目标缺失、第三个版本、身份不明、授权不足一律保留并诊断。
入口从当前进程 os.Executable 推导并验证正在启动的原 .app，得到 RecoveryAnchor；DataDir 来自已验证配置，不能从 journal 选取。journal.Target 必须精确等于该 anchor；Work 只能是该父目录中由本操作独占创建的固定名字，不能扫描并修改 journal 任意指定的路径。DataDir 不得位于 target 或 Work 内，以免交换同时移动恢复记录。
路径不是授权：同时校验签名、bundle ID、Team/模式、密封版本/build/架构、卷身份、目录文件身份。运行期继续用 device/inode 做 FD CAS；跨重启记录卷 UUID/文件 ID，不能把运行期 device 数值单独当永久身份。无法确认映射时停止，不放宽为“路径一样就行”。

0600、UID、plan digest 只能提供文件边界和一致性，不能抵抗同 UID 篡改；journal 与 plan 同时被重写后 SHA256 仍可自洽。即使 target 已夹住，攻击者仍可能伪造“本 target 应回滚”的旧记录。因此严格模式需要独立受保护的持久授权：
- 必须先验证具备正式代码身份、profile授权和共享access-group的Data Protection Keychain（或等效已实证完整性存储），再由原 GUI 在提交前建立安装级认证 intent，绑定操作 ID、固定 target/父目录、Work 身份、原 A/候选 B、plan digest、receipt digest、helper hash、允许的定向回滚与健康绑定；只让预期代码身份访问。不能把 MAC 密钥明文放回同一个 DataDir 就声称解决了同 UID 攻击。
- 恢复 GUI 重新验签并从受保护存储取得 intent，向可信 helper 经新建私有管道发本次能力授权。helper 独立复核父进程身份、锚与 receipt；不直接执行 journal 指向的 helper。授权原 A 的降级回滚仅限这一操作，不是绕过全局 floor 的通用入口；继续安装 B 仍受当前 floor 约束。
- 没有这种信任锚时只显示“发现未完成更新，已保留恢复资料”，不自动 swap、删除备份或执行文件。本地 adhoc 夹具可验证状态机，但不能证明 Developer ID/Keychain 代码 ACL 的发行安全性；已获本应用信任的进程被攻陷、root/内核攻击不在这一保护承诺内。

## 2. 持久记录与状态矩阵

A = 提交前原 bundle；B = receipt 对应候选；T = 固定原 target；S = 该操作 Work/next.app。分别记录 A/B 的卷与 node、CDHash、bundle ID、Team、密封版本/build。交换前 S 是 B，交换后 S 是 A；不能把现有固定 next.app 的 verifyCandidate 原样用于交换后恢复。
plan/授权 intent 在提交前固定，不在恢复中重新生成；journal 记录操作 ID、schema、递增代次、plan/intent digest、target key、Work 身份、A/B、helper PID/创建身份/执行文件 hash、阶段与健康结果引用。健康结果绑定本操作、B 的 CDHash/build、一次性能力与进程身份，不接受一个普通文件里的 ok=true。
同一 target 锁 → 同一 DataDir 锁，顺序沿用正常 helper；拿不到锁则不修改。锁内重读所有记录与两个目录 FD。helper/候选存活不明或有不属于本次交接的实例时只观察；不能用 PID 单值杀进程、删除其备份。journal 的 phase 只是线索，实际 A/B 配对决定动作。

| 记录阶段/实际身份 | 恢复动作 | 不允许的动作 |
| --- | --- | --- |
| 无可信 intent、digest/receipt/anchor 不匹配 | 阻断，保留原始记录和目录，给诊断 | 从 journal 选择其他 target、helper 或 DataDir |
| 任意阶段，原 helper 仍持锁或身份仍存活/不明 | 返回 busy/deferred；不和它竞争 | 杀不明进程、回放、清理 |
| mounting/prepared/未确认提交；T=A，S=B 或本次已证明拥有的部分产物 | 取消未完成更新；只清已授权拥有的产物，挂载按实际 image/device 复核后卸载 | 把准备阶段当安装授权；递归删除不明条目 |
| swap_pending 或 rollback_pending；T=A、S=B，二者都验证通过 | 物理上已是原版；保留 A，结束失败/取消事务，幂等清 B | 因 phase 名再次 swap，把已回滚的 A 重新换走 |
| swap_pending/swapped/launch_requested/awaiting_health；T=B、S=A，没有可信健康记录 | 交接恢复 helper；相关进程确认退出后 CAS reverse swap，恢复 A | 将 open 成功视为提交；在运行中的 B 下直接换目录 |
| 健康确认已持久化/committed/cleanup_pending；T=B、S=A | 保持 B，复核 A 的精确身份后只删该备份；最后清 journal/intent | 未持久健康就删 A；删除第三个 bundle |
| 同上，T=B、S 已缺失且没有其他异常条目 | 视为提交后的部分清理，幂等完成剩余记录清理 | 再回滚、重新安装或伪造缺失的备份 |
| T/S 不属于精确 A/B、出现新升级 C、target 缺失，或无健康且 A 缺失 | 保留所有能保留的对象，报告 conflict/needs_manual_recovery | 覆盖用户新升级、恢复用户可能已卸载的 App、猜测旧副本 |

journal 或 plan 缺失不证明未 swap；未写出 swapped 也不证明 rename 没发生。旧 node/CDHash 不能匹配就不回滚。清理必须按操作 ID+代次+plan digest+target key CAS，不能沿用仅按 ID 的删除判断。挂载记录只能作为线索，不能对不匹配的外部挂载执行 detach。
有可信健康记录但进程后来正常退出，仍可提交；反之候选当前“进程活着”不是健康记录。健康状态的持久定义、超时与验证由统一 ACK 协议提供，不另造第二套健康判断。

## 3. 启动 B 正在运行时的恢复交接

在正常窗口、组件同步、连接与代理操作开放前检查恢复；当前调用进程 B 从实际已验证 bundle 得到锚。若另一完整实例已运行，遵守单实例策略，不绕开它启动另一个恢复者。
T=B/S=A 且需回滚时，从认证 intent 绑定的完整已签名 helper bundle 取得程序，或使用具备独立稳定DR的正式helper；复核其 hash 与已签名原 A 的关联。裸GUI Mach-O复制件缺签名Info.plist，不能用于Keychain代码身份授权。不能仅凭 plan.HelperSHA256 就执行复制件；验证失败保留资料，不从候选或网络找临时替代程序。
GUI B 创建新私有管道，发送受保护 intent 的能力、原 target、当前 B 的 PID/创建身份/可执行身份。恢复 helper 先取 target/DataDir 锁并复验 A/B/健康状态，注册当前 GUI B 的 NOTE_EXIT，回复 RECOVERY_READY。这个恢复入口不能复用要求“父进程必须是原 GUI A”的旧计划身份。
GUI 收到有效 READY 后保持 installing/recovery 门禁，正常清理自身资源并退出；helper 必须同时看到私有管道 EOF 与匹配的真实 NOTE_EXIT 才 reverse swap。READY 前失败，GUI 留在可诊断状态、不退出；锁等待取消、丢 ACK、不匹配 EXIT 均不能操作 target。
reverse swap 与正常 apply 复用同一 FD CAS 实现。恢复 A 后重新验证 A，写出恢复结果；如需重新打开 A，启动参数必须重新由当前受信配置与白名单构造，不执行 journal 附带的任意环境或命令。A 的重新启动不能被写成 B 更新健康成功。
若 helper 已死且 B 被 OS 拒绝启动或无法运行恢复入口，就没有“下一次 App 启动”可以执行这段代码。没有独立可信外部入口时第一版只能保留 journal/旧备份并提供诊断恢复，不能宣称自动修复这一场景；本方案不擅自增设 LaunchAgent、后台常驻或宿主服务。

## 4. 持久化与 Fsync 错误

在首次 swap 前固定并持久化授权 intent、plan、A/B 身份与候选产物；写 swap_pending 的文件和所在目录均同步后才交换。现 atomicJSON 只同步临时文件后 rename，新增恢复实现不能据此宣称 journal 的目录项已持久。
交换成功后同步 target 父目录与 Work，再持久写 swapped；Fsync 返回错误时重新观察 T/S，不能把“函数返回错误”当成“没有换过”。reverse swap 后同样复核两端：已经 T=A/S=B 就不能再换一次；同步仍失败时保留备份/记录并报告“物理恢复与持久化状态不同”，不能误称旧 App 一定仍在 S。
在启动请求前先持久记录健康等待上下文；open 只推进请求状态。可信 ACK 先持久化，再写 committed，才允许按精确 A 身份删除备份并同步 Work。备份删除后 journal 的删除也要同步父目录；intent 最后退休，所有步骤可重入。
持久失败默认保留证据，不调用不分角色的 RemoveAll。目录/文件同步的实际平台语义与硬件掉电保证必须单独验证；SIGKILL 测试只能证明进程中断恢复，不能替代 APFS/虚拟机断电测试。

## 5. 最小接口与文件建议

| 拟议文件 | 最小职责/接口 |
| --- | --- |
| mac_update_recovery_darwin.go | 已实现 deriveRecoveryAnchor(ctx,cfg,executable)、inspectMacUpdateRecovery(ctx,anchor)；只用派生锚，不接受 journal target 作为权威入参 |
| mac_update_recovery_state.go | decideMacRecovery(snapshot)；纯函数返回 noop/deferred/abort_prepared/rollback/finalize/conflict，供表驱动测试 |
| mac_update_recovery_helper_darwin.go | 受信私有管道与新父 B 的 READY/EOF/NOTE_EXIT；复用已有 targetLock、swap 与角色验证，不新增第二套安装逻辑 |
| mac_update_intent_darwin.go | TrustStore 取得/验证认证 intent；持久 journal 与按代次 CAS 清理；缺少锚明确 fail-closed，不接受调用者传 trusted=true |

后续最小接线位置：main 的早期恢复 helper 分支与 GUI 启动门禁；原 apply 的健康持久点/备份保留；角色验证从固定 next.app 提取为仅能读取锚派生 T/S 的内部函数。本轮仅设计，不修改这些共享文件，不与正在实现的健康 ACK 并行改写。
第一版不做全盘扫描、自动下载修复、任选路径恢复、无期限重试/轮询。有效记录但暂时 busy 可由明确后续启动/用户重试触发；后台长期监测不在本轮范围。

## 6. 私有真实 fixture 验证建议

- 进程中断矩阵：复用独立签名 A/B、真实只读 DMG、真实 rename 的私有 root；在 swap_pending 已持久、rename 后尚未写 swapped、swapped、启动请求前后、健康 ACK 前后、删除 A 前后设置事件 barrier。核对 PID+创建身份+helper 路径后只杀 fixture helper；用新进程读取落盘文件恢复，不用同进程补状态，不触碰主 App/服务/代理。SIGKILL 样本单独标注，不叫断电验收。
- 权限与竞态矩阵：A/B 两向配对、重复恢复、回滚后 Fsync 失败、健康后部分清理；同时运行恢复与正常更新、活 helper/复用 PID/无法确认身份、新升级 C、用户卸载、缺备份、损坏摘要/receipt/健康记录、符号/硬链接与父/Work FD 替换。所有拒绝样本要求两端与非所属文件哈希/身份不变；仅在独立夹具中设置真实权限失败或明确标注的故障注入，不改系统时钟。
- 协议与安全矩阵：B 的真实启动进程在 RECOVERY_READY 前必须存活；仅 EOF 不能换，匹配 NOTE_EXIT 后才恢复 A；候选校验 marker 不得出现，health ACK 丢失不能清 A。伪造同 UID 自洽 journal+plan 不能取得 TrustStore 授权；篡改目标到另一个合法 App 仍须被锚拒绝。Developer ID/Keychain ACL、公证与完整 GUI 健康另设正控，不能用 adhoc 或 open=0 代替。

## 7. 本轮交付范围

新增本设计文档、mac_update_recovery_darwin.go 与其测试；未修改已有 main/apply/shared，未接启动或自动恢复。inspector 从当前签名 bundle 封装锚、用 cfg 的公钥/仓库验证 receipt、读取固定 work 中的计划/事务、核对实际 A/B 双向配对、探测 helper 身份；所有结果 MutationAuthorized=false、RequiresRevalidation=true。它不持更新锁，因此只是只读快照，不提供执行凭据；Keychain/认证 intent、跨启动卷 UUID 锚和真正自动回放仍未实现。
仅执行无 App/无镜像挂载的 Go 专项：临时签名 Mach-O bundle、真实签名 receipt、私有 EOF helper 与目录交换；receipt 夹具不是实际 DMG，不冒充镜像/安装/健康验证。未访问数据库、未改宿主代理/主进程/部署。普通健康 ACK 与持久 transaction/journal 写入由 root 单独实现，不能把本设计文档当成那些共享改动的验收证据。
最终只读专项 go test -race -count=1 -run '^TestMacRecoveryInspection' -v ./...：4 个顶层测试、7 个边界子例通过，12.040 秒；go vet ./... 通过。日志 .tmp/mac-recovery-inspect-green.log、.tmp/mac-recovery-inspect-vet.log，清理摘要 .tmp/mac-recovery-inspect-result.json；4 个私有 work/helper 均无残留。未跑全量或真实启动恢复，不把 SIGKILL/断电恢复、完整 GUI 健康或正式签名条件当通过。

## 第30轮：状态迁移去重与恢复边界核验

第30轮只读复核：卷UUID/fileID/birth四端锚与fresh-process物理角色检查已实现；普通live更新的双ACK、回滚及严格自有DMG清理有第29轮证据。这些都不代表可信持久intent或自动journal replay已实现。

未来startup接线必须识别受认证的仍在进行的本次交接：原helper持锁等待B的Native/React ACK，B不能先无条件等待helper退出，否则互等。健康协议的环境PID不是持久intent授权；未来应把内核peer/start/CDHash、helper完整代码身份与本次generation绑定后，才允许有限初始化和ACK，同时禁新连接/新更新。

本轮未进行Keychain实验，用户暂不提供DeveloperID/profile；正式认证存储正控仍缺。不能用DataDir内MAC密钥、adhoc entitlement或旧file-based ACL替代；旧schema无认证记录只诊断/人工重授权，不能自动补签。完整恢复引擎/协议与认证provider均须完成后才可宣称自动恢复，B不能被OS启动且helper已死时还需独立受验恢复入口。

14项要求与23条验收矩阵的只读快照见 `.tmp/ui-qa/round30-native-recovery-audit.md` 和 `.tmp/ui-qa/round30-native-recovery-audit.json`；本节不引入任何新的自动mutation或已实现声明。

逐文件及完整证据见 `.tmp/ui-qa/round30-completion.md` 与 `round30-final-report.json`；历史失败保留。


## 第31轮：受授权反向交换执行器，尚未启用生产恢复

新增 `mac_update_replay_{snapshot,handoff}_darwin.go` 与 `mac_update_replay_darwin.go`，从“只读识别现场”前进一步到同一真实文件交换核心的受授权回滚。生产没有 authority 实现、可配置公钥、Native 命令或 main/startup 调用点；不能把本节写成自动 journal replay 完成，原只读 inspector 的权限不变。

### 本轮执行范围

- 无 provider 直接返回 needs_authority，连锁文件也不创建。存在 provider 时，锁路径只来自独立启动锚，严格按 target→DataDir 获取；DataDir 锁拒绝符号链接、错误类型/权限/UID/链接数。拒绝发生在持锁阶段时可能已创建规范锁文件，不扩张为所有拒绝入口都全树零写入。
- active capability 绑定完整 operation/generation/动作、UID、固定 target/DataDir/Work、plan/transaction 原文摘要、A/B 签名与版本/构建/架构、父/Work/A/B 持久卷/fileID/birth。普通 schema1 文件即使自行重算摘要也不产生 authority；本轮仅 `_test` controller 对自己独立创建且验证的 fixture 显式签发新授权，没有自动提升历史记录信任。
- T=A/S=B 返回 original_retained；T=B/S=A 且 controller 签发 hold_candidate 返回 healthy_retained，均保留双方及全部记录。普通 phase=healthy 或 healthy.json 不替代该能力。hold_candidate 仅测试受保护协议的动作分支，不证明真实 Native/React ACK 已写入正式认证存储。
- T=B/S=A 且精确 rollback_original 能力才进入新父 B 交接：从 os.Getppid 获取真实父身份，注册匹配 NOTE_EXIT，校验内核路径和运行签名哈希；READY 带随机挑战及 operation/generation，ARM 必须原样返回，随后 EOF，再等该真实父 EXIT。EOF 不等于进程退出，执行器不启动或终止任何进程。
- 退出后重读整份 active capability，重新验证全部文件角色和原 helper 已死，检查可见候选实例，再反向 CAS。原 swap 与 guarded swap 共用唯一实现；恢复额外把父/Work live node、birth/fileID 绑定到实际 RenameatxNp 使用的目录 FD，并核对命名关联。真实红测已证明仅有 A/B 子 inode 不足：同一 A 移入替换 Work 后旧无约束交换仍会成功。
- 路径不可读的同 UID 进程不直接忽略。fresh 内核不存在/zombie 可排除；仍活时，只有稳定 PID/start/UID 下取得明确不同于 B 的内核签名哈希才可排除。实际启动后 unlink 的独立 C/B 签名映像分别证明可排除和必须保留；不使用进程名白名单。
- 唯一应用数据变更是 B/A→A/B 一次反向交换。交换后保留两份 App、journal、plan、transaction、helper 及未知文件，不清理、不 detach、不退休 intent、不写全局 release floor、不新安装 B。swap 错误返回 revalidation_required，因为 rename 已发生而 fsync 失败的可能性仍在；不盲目再交换。重试以物理 T=A/S=B 为准，不由旧 phase 再换一次。

### 验证与原始失败

专项已实际覆盖：无 provider、普通记录自洽伪造、未知健康、缺备份、目标 C、原 helper 存活/身份不明、锁争用/符号链接、新代次、同代次健康变更、陈旧 ARM、EOF 后 B 仍活、额外 B、工作目录/备份改变、满输出管道取消、候选内核路径不可读，以及 worker 在等待 EXIT 时被 SIGKILL 后由新 worker 使用仍存活 controller 完成恢复。controller 私钥只在测试主进程内存中，通过继承匿名管道返回带请求 nonce 的签名能力；生产没有这套 key/config/CLI。

保留真实红和夹具错误：red-no-provider.log 为新增接口前编译红；red-rebound-work.log 是同子 inode 替换 Work 的真实行为红；cancellation-and-restart.log 保留满管道准备误用 File.Fd 导致的夹具超时，以及首次保守扫描被宿主旧映像的不可读路径阻断。修正后没有忽略未知或按进程名放行，而是使用内核签名排除证据。nonce 负控曾共享切片、实际只测坏签名，现已复制 nonce，旧有效 proof 不能用于新请求。

首轮完整 Native race 的旧 stopMacTestHelper 在主体通过后因 Kevent EINTR 清理报错，日志和现场保留；修正仅在原 5 秒总 deadline 内重等并严格匹配本 PID 的 NOTE_EXIT，没有扩大预算或把中断当退出。定向连续三次通过；最终完整执行及源 SHA 见 `.tmp/ui-qa/round31-recovery/` 的 completion、source-freeze-final、native-full-race-final 与 environment-final 证据。

### 仍未完成、不得启用的前置

1. 正式持久 authority、认证健康写入、完整受验 RecoveryHelper.app、启动/连接门禁、清理白名单和最后 CAS 退休尚未完成。未来 provider 的创建/MarkHealthy/换代/退休必须服从同一 target→DataDir 锁串行化契约，或提供等价 active lease；两次读取的值比较不是保护存储与文件系统的原子租约。
2. 候选扫描只是一次观察，不是禁止新 B 启动的排除门禁；目录路径关联检查与 rename 仍非原子，不宣称消除全部同 UID 时序竞争。正式入口未接线，不能用当前切片绕过上述条件。受保护授权的来源/floor 验证应在原始提交时完成；本次回滚不调用在线 verifier 后忽略错误，不降低 floor 或发出任意降级许可。
3. 此轮 SIGKILL 证明 controller 存活时的进程恢复，不是机器重启、掉电或正式存储隔离正控。本节记录时尚未注入 rename 后 fsync 失败（Build 150 补验见文末）；有健康而 A 已缺时仍保守保留，不冒称幂等退休。B 被系统拒绝启动且 helper 已死仍缺可执行外部入口。按用户选择继续本地开发，不改宿主系统代理，不提供正式签名/profile，不做 Windows 实机验收；本轮也不进行 Keychain 实验。

本轮不改 UI/CSS，检查没有布局改动或生产 Mock 数据。真实当前 GUI/API/SSE 的独立验收与旧 Build30 普通 GUI ACK 回归分别记录；后者不是包含本轮新源并已启用 replay 的安装包。


### 第31轮补充：实窗退出状态修复

独立真实 GUI/API/SSE 验收同时发现系统 `NSRunningApplication.terminate()` 15秒内不退出。根流程与只读审阅均核对本机实际 MyGo `prepareQuit`：main 的局部 `quitting` 已置 true，但 `desktopShell.quitting` 仍 false；SDK 第二次准备关闭窗口时被本项目 OnClose 的 PreventDefault/Hide 拦下。首次失败、精确自有进程应急停止和清理证据保留，不当成正常退出成功。

仅在 `main.go` 增加统一 `allowQuit` 闭包并替换既有状态写入，`shell.go` 提取同一 `allowQuit` 状态方法，由既有 quit 复用；没有新增直接退出/kill兜底。普通终止及健康失败仍需 shutdown 成功后才共同放行，单实例失败允许 nil shell，SessionEnding 保留原清理错误记录后交给 OS 结束的语义。窗口普通关闭仍隐藏，没有修改 CSS、布局或组件。

包含当前最终 main/shell 的新私有 QA App 已实际验证三次 OS terminate：登录前、真实登录+账号 SSE 后、重启恢复会话并真实登出后，均 exitCode=0、signal=null，socket自动移除；应用菜单关闭→隐藏→显示主窗口也实际通过。它们是新 ad-hoc QA 产物，未覆盖正式 Build30 或用户安装版本。新 binary SHA 为 `aa56f5f890bd50918aa6a786ecef8c6b7ed9a01c051df944cc7a16ab1bf19d33`；根另独立核对154份源码/依赖/icon、strict codesign、实际build-info和原始API/SSE/退出记录。详见 `.tmp/ui-qa/round31-client-quit/` 与 `round31-recovery/root-gui-proof.json`。

恢复核心完整 race 最终471项通过、7项skip（包含子项，501.946秒）；该编译早于退出修复，但所有恢复/交换/测试字节与最终相同，只有 main/shell 两份后改，不能宣称该完整编译覆盖新退出字节。后改字节另经真实新App三次退出、最终 check9/9、vet、最终源码 Native 定向 race49项通过（99.408秒），包括真实本机 Xray+隔离代理适配及官方 GNOME schema 的私有keyfile补验；不是宿主代理或Linux桌面实机。文件proxy e2e race44项通过，1个私有child入口skip；浏览器15/15命令通过。原完整7个skip中的GNOME/真实Xray专用入口已显式补验，两个私有child不直接执行，不能把日志改写为零skip。

真实账号链同时证明：错误口令401（未确认可见错误提示）、正确登录、真实原生SSE、后台同active改名实显、公告弹窗及已读落库、登出撤销与会话恢复。账户/公告为独立PG/nonce schema测试数据，转发器仅记录原始真实请求/事件，不伪造API回复；没有可用节点，也没有点击代理连接，不能冒称完整VPN连接验收。

### 连接入口的保留策略

macOS 客户端在连接预检及原生启动内核前分别检查当前配置数据目录的固定更新记录槽。只要目录项仍在（含截断文件、目录、悬空链接），普通连接和已确认的代理接管均返回 `mac_update_pending`；不解析记录中的路径、执行文件、交换应用或删除任何恢复资料。若预检通过后记录才出现，原生在写内核配置前拒绝，前端尝试释放这次新取得的租约，不以停止已有内核作为补救。正常退出、断开和更新健康确认没有增加该限制。两处检查是连接准入检查，不是跨进程互斥锁，也不代替受保护的持久授权、启动排除或断电恢复。

组件下载只做记录检查，不占用应用更新锁。macOS 的组件安装事务（准备备份、替换文件与元数据、提交或失败恢复）额外持有更新助手使用的同一把 DataDir 锁；取得锁后再次检查固定 journal。助手已经持锁但尚未写出 journal 时，组件安装也会返回 `mac_update_pending`。组件路径不申请 target 锁，不改变助手的 target→DataDir 顺序。启动时也只在发现未完成的组件事务时竞争这把锁，拿到锁后重读实际文件；没有待恢复事务的启动不占锁，避免候选 App 无法向更新助手确认首屏就绪。助手仍在工作或固定 journal 未清时，保留组件和元数据，待条件解除后下次启动再恢复。此约束只覆盖遵守协议的组件提交、组件启动恢复与应用更新进程，不是应用恢复授权，也不证明所有连接或启动已跨进程串行化。

连接预检先检查固定更新记录，再短暂取得并立即释放 DataDir 锁：助手持锁但尚未写出记录时，预检也会在读取代理配置、申请服务端租约之前拒绝。首次无记录的预检可能创建专用锁文件，不改系统代理，不把锁带入网络请求。实际连接从校验已安装组件之前，到内核就绪、代理接管并发布连接状态（或失败返回），持有与更新助手、组件安装共用的 DataDir 锁，并在获得锁后重查更新记录。普通连接和强制接管遵守同一规则。连接返回后释放锁，不把已建立的连接、断开或首屏健康确认纳入锁的生命周期；这也不等于跨重启恢复授权。

正常更新助手在健康确认后清理前，会分别核对安装位置为候选目录、`Work/next.app` 为原目录；失败回滚完成时两者相反。目录的设备号和 inode 来自这次事务，不从待清理项重新授权。遇到缺项、同名替换或类型不符，停止收尾，不以递归删除作补救。目录身份检查与删除不是单个原子操作，不代表同 UID 并发替换完全被排除，也不代替跨重启的持久授权。

原助手在已交换应用后遇到候选失败，须先验证原计划和事务摘要并持久写入 `rollback_pending`，成功后才反向交换。写入或验证失败则保留候选安装位置及原版备份，不重启、不清理。反向交换本身报错时不根据错误推断哪个副本在 `next.app`，因为目录同步错误可能发生在交换之后。

正常助手删除事务副本前必须读取私有更新记录：本次操作、目标、工作目录、计划摘要与事务摘要一致，且阶段分别为 `healthy` 或 `rolled_back`，候选签名摘要也必须匹配。副本清理结束后再读记录，匹配才删除；取消尚未提交的准备工作仍允许记录不存在。这是当前助手持锁时的收尾校验，不授权新进程回放，也不消除检查与文件操作之间的竞态。

存活的助手在内存中保存上一次成功持久写入的 journal 原文字节摘要。首条记录以不覆盖已有文件的原子重命名发布；其后每次推进阶段和清除已存在的记录都核对该摘要。丢失、换成其他内容、甚至只改了 JSON 空白，都不会被下一次写入覆盖。摘要不写入计划，也不作为新进程的恢复授权。后续更新的读取与重命名不是跨进程的原子比较交换。

取消尚未提交的交接时，助手先确认已写记录仍为自己最后持久化的原文；如果从未写过记录，则要求固定槽为空。核对失败时不删除已暂存的应用和计划。父进程只清理由自己创建的启动文件（计划、助手及助手日志），不会递归删除独立助手留下的应用、镜像或恢复资料。准备完成后已有记录被改动或移除，两种情况都应让取消返回失败，而不是显示清理成功。

### Build 150：目录已交换、同步报错后的再次检查

在打包源码快照上执行 `go test -race -count=1 -v -run '^TestMacRecoveryRetryAfterDirectorySyncFailure$' .`。临时应用目录在 APFS 上真实反向交换；测试分别在父目录同步、工作目录同步及两者同步时注入错误。三种情况都尝试了两次目录同步并保留相应错误；随后重新从当前目标取得锚点，在测试授权提供者下再次检查，识别出旧版已在原位，没有再次交换或删除副本。日志：`.tmp/ui-qa/round159-recovery-audit-GoZUkp/result.log`。这是错误注入，不是硬件掉电。当前非测试源码没有调用 `replayMacUpdateRecovery` 的入口，也没有生产授权提供者，故不能将本项标为已实现跨启动自动恢复。

### 首屏就绪不等于恢复记录已清理（Build 165）

助手先写入首屏就绪的成功报告，再清理恢复记录。在两步之间中断时，下次普通启动会同时读到成功报告和仍占用的恢复记录。此前最终成功报告遮住了提示；现在记录仍在就提示「更新结果待确认」，不改写恢复记录，也不尝试自动交换应用。正在进行的更新健康握手仍不提示，实际失败仍显示失败原因，成功且无记录仍静默。

本机 ARM64 临时签名 Build 165 从 DMG 只读取出应用，六种启动组合均通过（故障记录是隔离测试输入，不是实际掉电）。恢复记录的内容、文件身份和修改时间均未改变；未生成代理恢复文件。专项 race 测试、DMG 校验和严格临时签名完整性校验通过。证据：`.tmp/ui-qa/round165-update-cleanup-notice-Y2Epsp/window-results.json`。该包是单架构专项验证产物，未替换 Build 150 交付目录，也不代表受保护的跨启动恢复已实现。

### 第 180 轮：成功和回滚必须在原事务目录内收尾

实测旧助手只比对已安装与待删除应用两端的 inode：将同一 `next.app` 与原样计划、事务文件移到同名新工作目录，成功和回滚收尾都会删除新目录、备用应用及更新记录。只给计划或事务原文加换行也会被误判可清理。四个失败场景保留在 `.tmp/ui-qa/round180-terminal-cleanup-8Drsvf/red.log`。

正常助手现在比对计划与事务原文字节，验证事务绑定的父目录、工作目录的卷 UUID、文件 ID 和创建时间，并比对实际用于删除的目录句柄。目录或内容已变就保留资料；成功清理工作目录后先同步父目录，再删除更新记录。重新放回原目录路径并不能让已打开的其他目录通过校验。该检查属于存活助手持锁时的收尾，不是允许普通文件在下次启动授权删除；检查与删除仍不是单个原子操作，未启用跨启动回放。

清理及日志专项重复两次通过；使用当前助手和 Build 179 原始 DMG，双架构各通过 15 个测试及子项，x64 经 Rosetta。新 ARM64 Build 180 的原始 DMG 通过包内签名与构建结果比对、两版更新协议的四个实际场景；生产 CSS 与 Build 179 逐字节相同。`pnpm check` 9/9；ARM64 原生包全量 542 项通过、9 项跳过（其中两项原始 DMG 测试另行开启通过，未重跑依赖真实 Xray/指定平台的可选项）。单架构专项包：`output/local-candidates/chordv-1.1.12-build180-macos-arm64/`；不替换 Build 179 多平台交付，不是正式发行。

### 第 181 轮：提交、取消和回滚沿用同一份目录身份

真实签名夹具与独立更新助手复现了三条旧行为：确认交接并关闭管道后、原进程退出前换用同名新工作目录，仍会安装并启动候选 App；取消时会删掉被移入新目录的备用 App；失败回滚也会交换同名新目录里的副本。三条红测保留在 `.tmp/ui-qa/round181-swap-anchor-IDcPPE/red.log`。

GUI 新建更新目录后，将父目录和工作目录的实际文件身份写入交接计划，由私有管道传输的原文摘要绑定。GUI 提交、助手准备/提交/等待原进程退出、建立事务、取消和回滚不重新授权同名新目录；正向交换、失败回滚和受授权恢复复用同一个必须验证目录句柄的交换实现。取消时父子进程都只清理本次创建的目录，发现替换保留记录。普通计划不授予跨启动回放；目录检查与文件操作不是跨进程的原子比较交换。

`pnpm check` 9/9，九组原生定向测试通过；ARM64 `go test` 原生全量通过 545 项、跳过 9 项（其中两项原始 DMG 测试另行开启通过，未重跑依赖真实 Xray 或指定平台的用例）。ARM64 和 x64 Build 181 的原始 DMG 分别通过包内签名复核、两版更新协议四场景，以及三项目录变更回归；x64 经 Rosetta，未改生产 CSS。交付目录 `output/local-candidates/chordv-1.1.12-build181-macos/` 仅是本地双架构专项包。

后续独立夹具还复现：工作目录没有变化时，同一版本和构建号但资源不同的本地签名候选，仍可能在确认交接后被接受。Build 181 只修复目录身份，未修复候选身份这条链路；不得正式发行。证据：`.tmp/ui-qa/round181-swap-anchor-IDcPPE/candidate-seal-red.log`。后续把原始镜像内应用身份、已准备副本及确认交接时的候选绑定到同一次事务，不用版本号替代身份。

| 环节 | `apps/desktop/native` 逐文件改动 |
| --- | --- |
| 交接 | `mac_update_darwin.go` 在 GUI 创建目录时记录身份并在提交、父进程取消时沿用；`mac_update_validation_darwin.go` 增加交接计划字段；`mac_update_helper_darwin.go` 在准备、确认和退出等待节点拒绝目录变更；`mac_update_filesystem_darwin.go` 实现目录身份读取及比对。 |
| 执行 | `mac_update_persistence_darwin.go` 建立事务时不能重新绑定目录；`mac_update_apply_darwin.go` 交换和回滚沿用原身份；`mac_update_files_darwin.go` 删除不绑定目录的生产交换入口；`mac_update_cleanup_darwin.go` 取消和收尾共用目录核验。 |
| 回归 | `mac_update_swap_anchor_darwin_test.go` 新增三条真实目录变更场景；`mac_update_cleanup_darwin_test.go` 用同一检查复测末端清理；`mac_update_replay_swap_darwin_test.go` 保留回滚记录和同步失败断言、适配必传目录身份。 |

### 第 182 轮：安装镜像、已准备副本和交接使用同一候选身份

更新助手先严格验签只读 DMG 内的应用，再验签复制到工作目录的副本。签名摘要、应用标识、签名团队、构建元数据和可执行文件名称必须一致。助手在内存中保存副本身份及目录文件 ID，不从普通更新记录重新获取授权。确认交接和原应用退出后，再次核对该副本；交换后、启动前继续核对实际安装的应用身份。取消时如果准备好的副本已变，也保留应用和原恢复记录。未将版本或构建号相同作为接受依据。

| 文件 | 改动 |
| --- | --- |
| `mac_update_files_darwin.go` | 验签镜像内的原应用，并在验签、比对副本后记录准备身份。 |
| `mac_update_validation_darwin.go`、`mac_update_recovery_darwin.go` | 前者提供对比签名身份和核对准备副本的单一实现，后者复用同一身份规则。 |
| `mac_update_helper_darwin.go`、`mac_update_apply_darwin.go` | 前者确认交接时必须匹配原副本，后者在原进程退出后检查同一副本及同一条记录，再交换并核验实际安装结果。 |
| `mac_update_cleanup_darwin.go`、`mac_update_candidate_identity_darwin_test.go` | 前者取消时不删除身份有冲突的副本，后者覆盖签名一致但目录身份不同，以及目录未变但资源身份不同。 |

本轮仍只约束存活助手处理的这次更新；严格验签和文件操作不是原子操作，不提供跨启动的受保护恢复授权。上轮不同本地候选被安装的原始红测保留，新的反控不触碰现有安装。

首轮定向测试另捕获两条正常升级被过早拦截：等待退出时尚未建立事务，却误用了要求已有事务摘要的终态收尾检查。修正为核对当前助手持有的最后一条记录原文字节，未删除候选校验或放松终态检查；首轮失败日志和修正后的日志分别保留。

最终 `go vet` 通过，七组定向用例共 14 项通过，`pnpm check` 9/9，`pnpm test:browser` 15/15，生产 CSS 未变。ARM64 和 Rosetta x64 的 Build 182 原始 DMG 分别通过签名复核、两版更新协议四场景，以及三项候选身份冲突回归。并行期间 x64 两项在准备阶段遭遇设备号复用、ARM64 原生全量为 548 通过／1 个测试夹具清理失败／9 跳过；已按隔离镜像路径和实时设备信息只卸载本轮残留，原失败项及 x64 整组随后串行通过。没有弱化镜像归属检查，也未把补验写成单次全量全绿。证据：`.tmp/ui-qa/round182-candidate-identity-KPePBp/`；两份本地 DMG：`output/local-candidates/chordv-1.1.12-build182-macos/`。

### 第 183 轮：失败报告不遮住更新恢复状态

复现了四条旧行为：损坏报告让客户端看不到恢复状态、有效失败报告让恢复限制消失、链接文件可作为报告读入、合法但过大的报告可被消费。修后，固定恢复记录存在时优先保留恢复状态：若有可信格式的 macOS 失败报告，同一条提示同时说清失败和暂不能新建连接或重新安装；若无可读结果则显示「更新结果待确认」。正在进行的健康确认仍不提示恢复记录，不加网络请求、显示原始路径或执行恢复。

启动读取只处理已打开数据目录下更新目录中的普通结果文件，限制为 64 KiB；读前、读完和删除前比对文件及目录身份，避免将已变更的结果当作原件。在 macOS、Linux 以非阻塞方式打开，文件类型发生变化时不会等待管道。无法核实的文件不消费，只有另外读取固定恢复记录后才设置恢复提示字段，不信盘上报告里的同名字段。检查与删除不是一个原子操作；不提供跨启动恢复授权，也不会删除恢复记录。

| 文件 | 改动 |
| --- | --- |
| `installer.go`、`installer_report.go` | 从前者迁出报告读取，后者限制读取和消费范围、合并固定恢复记录的提醒。 |
| `installer_report_open_unix.go`、`installer_report_open_other.go` | 分别提供 Unix 非阻塞与其他平台打开方式。 |
| `installer_report_test.go`、`mac_update_recovery_darwin_test.go` | 验证旧失败、损坏报告、超限、文件和目录链接、命名管道、报告自报恢复标志。 |
| `nativeInstaller.ts`、`useUpdateFlow.ts` | 前者声明原生恢复标志，后者只在标志有效时在同一条失败提示中给出保留文件和联系支持的说明。 |
| `app-startup-readiness.tsx`、`app-startup-readiness.browser.ts`、`update-handoff.regression.mjs` | 分别更新真实启动组件的测试输入、增加两种窗口宽度的边界与可交互检查、验证失败提示不误导用户重试。 |

原始四条失败和后续验证保留在 `.tmp/ui-qa/round183-startup-report-ka0fig/`。

验证：八组原生定向测试连续两次通过；`go vet`、`pnpm check` 9/9、失败提示回归、`pnpm test:browser` 15/15 通过。最初的浏览器断言量到了入场动画中的位置，修正为等待同一条提示完全进入窗口，不改生产样式；660×468 和 390×760 实际截图均核对过。macOS 双架构各用 Build 183 原始 DMG 验证四个真实窗口启动场景、两版更新协议和签名完整性，x64 经 Rosetta。Windows/Linux 四个目标交叉编译通过，Linux 另在断网容器实际执行三组通用报告测试，Windows 未实机运行。本地包：`output/local-candidates/chordv-1.1.12-build183-macos/`。

### 第 192 轮：更新助手保留完整签名，确认交接前复核

正常更新不再执行只复制 Mach-O 的裸助手。助手是事务目录里的 `helper.app`，保留原应用的完整签名；其持久文件身份、代码签名和主程序 SHA-256 与本次事务关联，并核对实际运行进程的内核代码签名摘要。仍能读取旧裸助手记录，但正常安装入口不再执行旧裸助手；记录本身不能取得任何回放授权。

红测证实两条旧行为：同签名换件在准备完毕后仍能收到确认交接，导致主窗口退出后才失败；候选尚未准备时换掉原应用，父进程取消仍会删除工作目录。现在确认交接及建立事务前都核对助手，未收到确认时不会要求 GUI 退出；父进程和助手取消即使还没有候选，也核对原应用目录。在正常取消及终态中只清理所属副本，发现换件保留现场。目录检查与文件操作不是原子的。

| 文件 | 改动 |
| --- | --- |
| `mac_update_helper_bundle_darwin.go` | 复制完整签名 App，绑定目录、签名和执行文件摘要，统一助手路径。 |
| `mac_update_validation_darwin.go`、`mac_update_darwin.go` | 记录助手持久身份；GUI 暂存并启动完整 App 内的程序，以实际执行路径核对取消对象。 |
| `mac_update_helper_darwin.go`、`mac_update_persistence_darwin.go` | 验证助手自身、内核代码身份和交接确认；写事务前再复核。 |
| `mac_update_cleanup_darwin.go` | 原应用和已准备候选分别绑定，保留不同身份的原目录及助手副本。 |
| `mac_update_recovery_darwin.go`、`mac_update_replay_snapshot_darwin.go` | 识别新旧记录的助手路径；只读检查验证完整副本；回放仍需独立受保护授权。 |
| `mac_update_helper_bundle_darwin_test.go`、`mac_update_recovery_darwin_test.go` | 验证真实助手进程、正常取消、同签名换件拒绝与现场保留；验证只读检查前后文件树不变。 |
| `mac_update_wait_darwin_test.go`、`mac_update_fixture_darwin_test.go`、`mac_update_cleanup_darwin_test.go` | 测试清理适配完整助手路径，使用测试在 READY 时观察到的目录身份，不放宽生产清理。 |

定向 `go test -race` 24 项通过（含子测试），`go vet -tags=e2e ./...` 通过。原始 ARM64 DMG 经临时签名和镜像核验，两版协议完成真实窗口启动；签名原文变动、Git 历史变动都按阶段拒绝，没有改宿主系统代理。首轮竞态测试还发现多个夹具在测试结束仍用旧裸助手规则清理；原失败保留，修正测试清理后原失败组全部通过。日志：`.tmp/ui-qa/round192-full-helper-d1LU0W/`。

这轮不向启动逻辑接入跨启动回放，未引入持久授权存储，未做 Developer ID 签名、公证或掉电演练。已正常运行的独立助手完成更新，与助手也已退出后再启动应用能自动恢复，是两个不同的验收目标。

### 第 197 轮：真实双就绪后，才可提交受保护健康状态

只有与自有候选进程完成握手、收到原生和首屏就绪确认，并再次核实 PID、启动身份和内核代码签名摘要后，助手才生成健康证据。证据绑定本操作、计划和事务原文摘要、交换后候选的持久文件身份、进程身份和一次性挑战摘要。授权存储必须在同一个原子写入中比较完整旧授权（含代次及允许动作），再由 `rollback_original` 改为 `hold_candidate`。普通 journal 及其 `healthy` 字段仍不能授予权限。

存储开始提交后，返回错误、取消、失去进程或最终回执发不出，都会报告确认结果不明；安装代码的错误分支不回滚、不删备份及恢复记录。测试存储实际切换允许动作后，再由真实回放逻辑核对结果，成功场景保留已安装候选及原备份；代次变化、握手失败或事务原文变化不能提交。本轮只有隔离测试注入存储，正常安装仍走现有存活助手路径，不启用自动回放、钥匙串或新启动入口。将来接线前仍须完成提交前受保护预授权、绑定助手随后生成的事务摘要、启动互斥、清理以及授权退休。

| 文件 | 改动 |
| --- | --- |
| `mac_update_health_darwin.go` | 在最终健康回执之前接收可选受保护提交，明确处理提交后的取消、进程退出和回执错误。 |
| `mac_update_health_commit_darwin.go` | 验证事务、授权范围、目录和候选身份，调用原子比较并更新的存储接口。 |
| `mac_update_apply_darwin.go` | 确认不明时不进入普通失败回滚；生产调用不传入存储。 |
| `mac_update_health_darwin_test.go` | 现有健康验证仍覆盖不启用存储的普通分支。 |
| `mac_update_replay_health_darwin_test.go` | 使用真实临时签名候选，覆盖成功、错误挑战、原生未就绪、事务原文改变、授权换代、提交后取消、提交后存储返回错误。 |

此次 `go test -race` 的恢复和健康定向验证 67 项通过（含子项），`go vet -tags=e2e ./...` 通过。Build 197 的两架构原始 DMG 分别通过校验、两版更新协议、正常启动及两项篡改拒绝（各 5 项含子项，x64 经 Rosetta）。原始 DMG 只验证正常更新路径，不证明受保护存储已启用。未做跨启动受保护存储、正式签名、公证、断电或系统代理恢复验收。源码摘要和日志见 `output/local-candidates/chordv-1.1.12-build197-macos/`。

### 第 199 轮：候选应用先验证更新助手，再发健康问候

Build 197 的实际签名应用，在指定会话目录合规、同 UID 且 PID 与环境一致时，会向无关同 UID 测试进程发送 `hello`。会话环境只说明要连接哪个套接字，不证明对方是本次更新助手。现在候选从自身实际运行路径推导本次操作的同级 `helper.app`，核对对端内核路径、启动代次、双方 App 完整签名和内核代码签名摘要。助手的应用标识及构建模式必须匹配；正式构建沿用相同 Apple 签名团队要求。验证失败时在发送 `hello`、读取应用配置或初始化客户端数据之前退出。

| 文件 | 改动 |
| --- | --- |
| `mac_update_health_helper_darwin.go` | 新增候选侧的签名助手身份验证和生产入口。 |
| `mac_update_health_client_darwin.go` | 内核 PID/UID 检查后、发首帧前调用验证；后续协议不变。 |
| `mac_update_health_helper_darwin_test.go` | 实际 App 拒绝无关同 UID 进程，以及路径正确但签名应用标识不匹配的进程；两种情况都不发送首帧或初始化数据。 |
| `mac_update_health_darwin_test.go`、`mac_update_fixture_darwin_test.go` | 仅在隔离协议和生命周期夹具调用低层握手；真实打包应用仍走完整验证入口。 |

此验证只用于存活助手的正常更新，不从普通文件取得恢复权限，也不提供跨启动恢复、启动互斥或受保护存储。临时签名验证不能证明正式签名、钥匙串访问控制和公证。历史裸进程助手不被候选视为有效对端；旧 Tauri 的迁移路径没有因此启用。Build 199 双架构专项见 `output/local-candidates/chordv-1.1.12-build199-macos/`，不覆盖 Build 196/197。

`pnpm check` 9/9，`pnpm test:browser` 15/15，`go vet -tags=e2e ./...` 通过。竞态专项首轮一项旧夹具有测试源镜像附着残留；仅按本轮私有路径和全盘设备核对并正常卸载，未改产品清理逻辑。用同一代码串行复跑 68 项通过、1 项因未注入实际 App 跳过；该项和另一项错误身份用例均已用两架构实际 App 单独通过。每个原始 DMG 的两版完整更新和篡改拒绝均通过（各 5 项，含子项）。客户端与后台 224 个生产前端文件摘要未变，布局回归通过，无新增生产 Mock；未重跑全仓集成测试或重打 Windows/Linux。

### 第 201 轮：按安装路径串行化普通启动与换包

旧实际 App 在目标处已有独占启动锁时仍会初始化数据。旧助手在真实更新交接的父进程退出后也未读取普通启动锁，仍可正向换包；旧回放 worker 同样会反向交换。三个失败场景均保留原日志。普通打包 App 现在在读取配置前按目标路径取共享锁；同一安装改用另一个数据目录、HOME 或 TMPDIR 不产生新锁。锁在 macOS 提供的当前用户目录内，不依赖应用父目录可写，也不放到可按期限清理的临时或缓存目录。开发入口的裸程序不占该锁。

正常更新助手可在原 App 运行时准备候选，等内核确认原 App 退出后才取同一把独占锁。已认证的候选只在等待真实双就绪的助手持有独占锁时走特殊启动路径，普通启动不通过。在向旧版完成反向交换并落盘后，助手先释放启动锁再打开旧 App；已有目标锁、数据目录锁仍保护收尾。锁有冲突时不交换、不启动候选，正常助手只清理自己已准备的资料；回放则保留两端和恢复记录。回放在真实父进程退出后持独占锁重新核对授权与磁盘状态，再做进程检查和交换。

| 文件 | 改动 |
| --- | --- |
| `mac_update_launch_gate_darwin.go`、`mac_update_launch_gate_other.go` | 新增 macOS 启动互斥；按 OS 用户目录和实际安装路径分隔，其他平台无运行行为变化。 |
| `main.go`、`mac_update_helper_darwin.go` | 普通 App 和现有助手分别在配置读取前、旧父进程真实退出后进入互斥。 |
| `mac_update_apply_darwin.go` | 失败反向交换完成后先释放启动锁，再按普通路径重启旧应用。 |
| `mac_update_replay_darwin.go`、`mac_update_replay_handoff_darwin.go` | 回放持锁重验并交换；保留已有实际进程检查，明确它不能单独提供排斥。 |
| `mac_update_launch_gate_darwin_test.go`、`mac_update_holder_darwin_test.go` | 增加真实普通启动、助手冲突、回放冲突和不同安装路径验证；旧版恢复夹具也必须按普通启动取得锁才记录已重启。 |
| `mac_update_replay_swap_darwin_test.go`、`mac_update_swap_anchor_darwin_test.go` | 直接调用反向交换的专项用例适配启动锁参数，保留原身份断言。 |

这把锁是参与该协议的进程之间的互斥，不代表 OS 能阻止未接入协议的旧程序，也不是受保护恢复授权。正常更新仍沿用原完整签名助手，回放未接入正式启动，未接钥匙串或正式签名。没有改客户端和后台布局、代理或线上环境。

最终源码快照的 `go test -race` 定向验证 60 项通过（含子项），`go vet -tags=e2e ./...`、`pnpm check` 9/9、`pnpm test:browser` 15/15。ARM64 和 Rosetta x64 原始 DMG 分别通过各 8 项包内检查（含子项：普通启动互斥、对端拒绝、两版更新、真实首屏与篡改拒绝）；另用第 199 轮快照编译的、未接入启动锁的隔离完整签名助手更新到 Build 201 ARM64，实际首屏通过。Windows x64 与 Linux ARM64 只做桌面原生测试包交叉编译，不当作运行验收。224 个生产前端文件摘要未变；没有引入生产 Mock 或保留第二套更新逻辑。未重跑完整集成测试，未执行正式签名、Windows 安装、宿主代理或实际 GitHub 发布。构建、原始红测和完整日志在 Build 201 专项目录。

### 第 202 轮：旧 App 退出前预留授权，原子绑定真实事务后才换包

受保护分支先核对已确认的准备副本、工作目录、完整签名助手以及实际助手进程，为安装路径和数据目录原子预留空闲槽。预留固定代次、操作、计划原文摘要（包含发布收据）、两份应用和四端文件身份，但不授予回放权。旧 App 尚未退出、事务文件尚不存在时，助手须已收到预留确认才发送 `ARMED`。普通文件不作为授权存储。

收到原父进程真实退出事件并取得启动独占锁后，助手落盘事务及 `swap_pending`。存储原子比较整份预留、绑定事务原文摘要并提交 `rollback_original`，才形成有效回放权限；本地重新核对计划、事务、日志和签名应用后，原有交换代码才能执行。已持久化但没有拿到明确回执、授权被新代次替换、事务字节变化均不换包、不启动候选、不删除证据。双就绪后使用既有 `markHealthy` 把同一代次转为 `hold_candidate`，仍保留原版和记录；受保护分支不借用普通助手的末端清理或无条件回滚。

| 文件 | 改动 |
| --- | --- |
| `mac_update_arm_recovery_darwin.go` | 定义受保护储存的预留和原子绑定契约，核对事务原文、代次、应用与进程范围。 |
| `mac_update_helper_darwin.go` | 在已验证的 ARM、回复前预留；无提供者时走原生产流程。 |
| `mac_update_apply_darwin.go` | 事务及换包前日志落盘后绑定，重用双就绪确认；受保护记录未经退休不得清理。 |
| `mac_update_health_commit_darwin.go` | 提取同一个健康存储接口供活助手接线，不改变原有验证条件。 |
| `mac_update_holder_darwin_test.go`、`mac_update_arm_recovery_darwin_test.go` | 隔离测试二进制注入当前进程内存存储，真实签名助手、私有交接、DMG 和候选在六种授权、改动或启动场景运行。观察文件只给测试断言，不是授权来源。 |

生产没有启用存储提供者，也不能通过环境、参数或普通日志开启。受保护存储、正式签名、启动后回放和授权退休仍未接线；测试内存存储不证明断电持久性。没有修改客户端、后台前端或系统代理，也没有访问线上。

首轮测试将镜像内目录的 inode 当成复制后的工作副本 inode，导致六项身份断言误报。修正为在助手准备完成时读取已验签副本，再核对交换后的确切文件身份；生产代码未为该误报更改。最终 `go test -race` 定向 41 项通过，其中新实进程测试覆盖健康、候选启动失败、预留回执丢失、代次被替换、绑定回执丢失及绑定后事务原文改变。`go vet -tags=e2e ./...`、`pnpm check` 9/9、`pnpm test:browser` 15/15。Build 202 两架构原始 DMG 各 8 项验收通过（x64 经 Rosetta），验证无受保护提供者的正常生产路径。224 个生产前端文件摘要未变；未执行全仓集成测试、Windows/Linux 重打包或实际 GitHub 发布。

### 第 203 轮：健康换包完成后清理与授权退休

受保护分支中的活助手只有在同代次 `hold_candidate` 已生效、原包和新包身份都核对通过后，才请存储确认清理检查点。检查点绑定该健康授权和固定更新日志的原文字节摘要；丢失回执时不动备份。拿到确认后再次验证应用、日志、助手与活跃授权，复用原有严格归属清理。退出前先确认工作目录和对应挂载确实已不在、原日志确实已清且所属目录已同步，再原子退休检查点和同一代次授权。普通日志里写 `healthy` 不授予清理权。

恢复收尾持有原目标锁和数据目录锁，只处理已经确认过清理的操作。在模拟的两种中断现场（工作目录已清但日志仍在、日志也已清但授权还在），只有当前安装仍是同一个签名及持久文件身份、目录和代次未变时才继续收尾。日志还在时必须逐字节匹配原记录；重新安装的同签名副本、陌生日志、缺受保护检查点或代次改变均不清理。退休比较失败不消耗新授权。工作目录尚在（包括清了一半）的情况继续保留现场，不假设已完成，也不任意递归删除。普通启动尚未调用此恢复收尾。

| 文件 | 改动 |
| --- | --- |
| `mac_update_retire_recovery_darwin.go` | 持锁核对健康授权、受保护检查点与文件范围；只在工作和日志均已清理并同步后退休；可续做两种收尾中断。 |
| `mac_update_replay_snapshot_darwin.go` | 提取同一份受保护授权范围检查，正常回放和清理续做均复用。 |
| `mac_update_apply_darwin.go` | 只有已认证提供者具备清理契约时接入现有安全清理；正常无提供者路径不变。 |
| `mac_update_holder_darwin_test.go`、`mac_update_retire_recovery_darwin_test.go` | 对隔离签名助手验证成功和丢确认；以真实文件、签名及 APFS 交换构造清理中断正反例。测试提供者只在测试二进制中使用。 |

这轮不证明系统级持久性、硬件掉电、正式签名或跨启动自动恢复。正式授权存储仍未启用；普通更新、回放和系统代理现有入口不变。

最终定向 `go test -race` 53 项通过（含 12 个新增场景和各组父计数），`go vet -tags=e2e ./...`、`pnpm check` 9/9、`pnpm test:browser` 15/15。Build 203 双架构原始 DMG 各通过 8 项普通路径验收，x64 经 Rosetta。客户端和后台 224 个生产前端文件未改变，浏览器布局检查通过，隔离存储未进入生产包。未重跑全仓集成测试，未重打 Windows/Linux 或验证正式签名、系统代理、云端发布。

### 第 207 轮：恢复已确认健康但尚未清理的完整工作目录

此前只允许在工作目录已经消失后续做日志和授权退休。现在，如果原助手已退出、健康授权和清理检查点仍属于同一代次，且签名、持久文件身份和计划／事务／日志原文均吻合，可以从**旧备份和工作目录仍完整**的状态续做。清理端使用本次实际读取到的文件设备号，不把旧设备号当成跨启动身份。它取得待删旧备份和助手副本的独立启动锁，确认它们未在运行；已安装的新版本可继续运行。恢复入口只检查镜像未挂载，不尝试卸载；复用原有受归属约束的清理和退休逻辑。工作目录只清了一半、出现额外文件、同签名重新复制、授权缺失或变化时，不猜测或消耗授权。

| 文件 | 改动 |
| --- | --- |
| `mac_update_retire_recovery_darwin.go` | 在目标锁和数据锁内验证检查点、文件角色和退出状态，先续做完整工作目录再走原收尾；仍不读取普通日志作为授权。 |
| `mac_update_replay_snapshot_darwin.go` | 返回已通过受保护摘要核对的计划，供恢复端复用签名助手身份。 |
| `mac_update_cleanup_darwin.go` | 恢复方只允许操作未挂载的工作目录，不改正常活助手的卸载路径。 |
| `mac_update_retire_recovery_darwin_test.go` | 补完整目录、历史设备号、实际新版本继续运行、旧备份或助手运行、启动锁、同签名替换、部分清理和资料变更正反例。 |

原实现红测复现完整目录被拒。最终针对当前源码以真实临时签名 App、进程与文件交换运行 `go test -race`：ARM64 48 项通过，x64（Rosetta）48 项通过，均零跳过。历史设备号差异为夹具模拟，不是实机重启；另通过 `go vet -tags=e2e ./...` 和 2 项更新与生命周期浏览器布局测试，224 个生产前端文件与 Build 206 一致。日志：`.tmp/ui-qa/round207-recovery-workspace-kkSbGA/`。本轮未打包、未重跑全仓；Build 206 文件校验不变，不含这次改动。未接正式受保护存储或普通启动入口，也未读取或更改宿主钥匙串、系统代理、线上服务或 GitHub 数据。

### 第 208 轮：更新授权用同一条记录原子推进

同一个安装位置只允许一个授权槽，换数据目录不能绕开已有授权，也不能读取或使用另一数据目录的记录。预留不授予回滚权；绑定精确事务原文后才授予本次回滚；真实双就绪证明与候选身份吻合后转换为保留候选；清理检查点绑定健康授权和日志摘要，只有同一条记录才能退休。每次变更都要比较整份上一版本记录，写入时附新随机修订标识；不把当前状态读出后无条件覆盖。空条目与不存在分开处理，损坏或超长记录既不授予能力，也不覆盖。存储可能落盘成功但回执丢失时仍返回不确定，不能据此直接换包或清旧版。

| 文件 | 改动 |
| --- | --- |
| `mac_update_recovery_slot_darwin.go` | 实现既有预留、绑定、健康、清理、退休接口的原子状态转换；要求外部后端提供整条记录的持久比较与替换，不提供普通文件后端。 |
| `mac_update_replay_snapshot_darwin.go` | 提取预留和活跃状态共用的安装／数据／目录校验；回放仍另查独立启动锚和活跃能力。 |
| `mac_update_recovery_slot_darwin_test.go` | 在隔离内存后端验证不同调用实例读写、并发竞争、错误范围、旧代次、损坏记录和丢失回执。 |
| `mac_update_holder_darwin_test.go`、`mac_update_retire_recovery_darwin_test.go` | 真正执行临时签名更新助手，将新状态转换串到更新流程：正常清理退休，以及写入检查点后丢回执、必须保留旧备份。观察文件只供断言，不是授权来源。 |

ARM64 与 x64（Rosetta）各通过 36 项 `go test -race` 定向用例，零跳过；`go vet -tags=e2e ./...`、两项更新及生命周期浏览器布局测试、224 个前端源码摘要比对均通过。日志：`.tmp/ui-qa/round208-recovery-slot-Bx4Oao/`。未重跑全仓或重新打包，Build 206 原样保留。

没有接入正式受保护存储或普通启动；内存后端不证明 Apple 权限、机器重启持久性或跨进程原子性。正式后端须用独立授权的系统存储，在不同进程中实证单槽的原子创建、条件替换和条件删除，并验证未授权代码无法读写。中断在预留未绑定、已回滚到旧版等状态的授权退休仍需明确接线，不能从普通文件推断。没有读取或修改宿主钥匙串、系统代理、GitHub 或线上服务。

### 第 209 轮：Data Protection Keychain 适配器，仅离线验参，未启用

适配器只构造固定服务和指定发布团队专用访问组的 Data Protection Keychain 请求，不同步到 iCloud，禁止弹出授权交互。创建时限定仅此设备处于解锁状态时可访问；读取时核对返回的授权原文与 SHA-256 指纹。替换和删除把旧原文指纹作为系统查询条件，均只发出一次请求；替换同时写入新原文与新指纹。只把重复创建或旧指纹查无匹配当作竞争，权限失败、设备锁定、异常返回和可能写入后的取消均不作为成功或空槽。没有退回普通文件、旧式钥匙串或无条件写入。

| 文件 | 改动 |
| --- | --- |
| `mac_update_keychain_darwin.go` | 对接授权槽的读取、单次条件创建／替换／删除；本地构建拒绝打开该存储，普通启动与更新未调用它。 |
| `mac_update_keychain_api_darwin.go` | 复用纯 Go 动态绑定方式，加载系统 Security/CoreFoundation 符号，安全传递字典、数据和非交互认证上下文；不复用或调用系统代理代码。 |
| `mac_update_keychain_darwin_test.go` | 用真实 CoreFoundation 对象检查请求，在四个 `SecItem*` 入口截断所有钥匙串读写；覆盖旧指纹、返回新原文、范围、冲突、拒绝与取消。 |

以本机 Apple SDK 的 `SecItem.h`/`SecBase.h` 核对公开常量，并检查 [Apple Security 公开实现](https://github.com/apple-oss-distributions/Security/tree/main/keychain/securityd) 的属性匹配及事务代码。来源只能支持适配器设计，不证明当前系统或正式签名下的实际行为。日志：`.tmp/ui-qa/round209-keychain-adapter-q7giTr/`。ARM64 与 x64（Rosetta）各通过 25 项适配器／授权状态回归和 3 项真实签名测试助手回归，均零跳过；后者仍用测试内存存储，与前者的系统调用验参分开。`CGO_ENABLED=0` 双架构 Go 编译、`go vet -tags=e2e ./...`、两项浏览器布局检查通过。224 个前端源码文件未变；未重打包或重跑全仓，Build 206 的 63 个文件摘要不变。

正式接线前仍要在专用环境验证签名与 profile 实际授予预定访问组、更新助手与候选跨进程同槽读写、同一旧指纹的并发替换只有一方成功、过期条件删除无法伤及新值、未授权程序无法读写，以及重新启动后能读出正确代次。本轮没有读取或写入宿主钥匙串，没开自动恢复、没动系统代理，也没访问项目的线上服务或发布仓库。

### 第 210 轮：安装前中断只清除未绑定的本次预授权

在目标锁和数据目录锁内，从受保护存储读取未绑定的预授权。确认原已签名应用仍在安装位、候选和完整助手仍是本次签名副本、原助手已退出、两份待删副本没有运行，才处理遗留资料；原版可以保持运行，不启动候选、不交换应用。凭受保护记录重建 `prepared`、`armed`、`waiting_parent_exit` 和 `swap_pending` 四种可能日志，要求计划、日志及已写事务逐字节吻合。已绑定、物理上已换包、无法验证或部分缺失的现场留给其他恢复路径，不冒充预授权清理。

先原子写入取消检查点，阻止迟到的事务绑定。收到确认后复核日志和两份应用签名，清理只走原有的归属检查和未挂载规则。工作目录、日志已清并同步后，才条件删除同一代次；该检查点也能续做工作目录或日志已消失时的收尾。丢检查点回执时不删文件；没有检查点且工作目录消失时不推断可退休。红测复现过在等待检查点时原地改变候选签名、目录 inode 不变但仍被删除的缺口；修复后，恢复清理会在删除前重新验签，拒绝并保留现场。跨目录的检查与删除不是单一文件系统事务，不声称任意外部修改都可原子排除。

| 文件 | 改动 |
| --- | --- |
| `mac_update_pending_abort_darwin.go` | 新增受保护的预授权取消、检查点续做和原版保留验证。 |
| `mac_update_recovery_slot_darwin.go` | 为未绑定记录增加条件检查点和退休；有取消检查点后事务不能再绑定。 |
| `mac_update_persistence_darwin.go` | 复用同一个事务原文编码，正常助手落盘格式不变。 |
| `mac_update_replay_snapshot_darwin.go` | 共用计划、目录和签名快照读取，回滚授权约束不变。 |
| `mac_update_retire_recovery_darwin.go` | 共用待删副本启动门禁和清理前复验，健康收尾也采用复验。 |
| `mac_update_pending_abort_darwin_test.go` | 用实际临时签名应用、退出状态和文件身份覆盖四个中断阶段、丢回执、重复收尾、替换签名及拒绝场景。 |

当前源码 `go test -race` 在 ARM64 与 x64（Rosetta）各通过 52 项恢复和授权回归、3 项真实测试助手回归，均零跳过。双架构 `CGO_ENABLED=0 go build`、`go vet -tags=e2e ./...` 和两项浏览器布局检查通过，224 个前端源码不变。日志：`.tmp/ui-qa/round210-pending-abort-3N0aT2/`。仅使用隔离内存存储，未开启普通启动接线或正式钥匙串，未操作宿主代理、项目线上服务或 GitHub 发布。本轮未重跑全仓或重打包，Build 206 的 63 份文件未变。已绑定且回滚后的清理与正式跨进程存储验收仍未完成。

### 第 211 轮：原版恢复后封存回滚授权并收尾

原版已处于安装位置、候选在暂存位置且原助手退出时，由新的独立启动锚和精确的受保护回滚授权共同开启收尾；候选或助手仍在运行，或文件、目录及签名不再属于本次操作时不处理。用同一次受保护记录比较与替换，将 `rollback_original` 变为 `keep_original` 并保存当时的日志摘要；此后即使外部再次改变两端位置，旧授权也不能再次交换或接受迟到的健康确认。日志阶段不提供授权，日志摘要只用来防止误清重读时已被替换的记录。

清理复用待删副本的启动门禁、清理前重新验签、只处理未挂载工作目录和同步后的授权退休。只移除失败候选和本次有归属的工作资料；保持原版运行。不确定检查点回执时先保留，重读精确检查点可继续；工作目录或日志已消失时，只有同一个已保存检查点及原版仍匹配才继续。没有授权、未恢复原版、普通日志声称已健康、已有受保护的候选健康授权或已经换代时不清理。

| 文件 | 改动 |
| --- | --- |
| `mac_update_rollback_cleanup_darwin.go` | 新增回滚后从原版锚点进入的检查点与清理入口，不在这一入口交换应用。 |
| `mac_update_recovery_slot_darwin.go` | 原子封存回滚授权并写入日志摘要，封存后不再使用该代次的回滚或健康能力。 |
| `mac_update_replay_darwin.go`、`mac_update_replay_snapshot_darwin.go` | 保留原回滚交接职责，拒绝用已封存清理能力进行换包；快照提供已校验引用的日志阶段及原文摘要。 |
| `mac_update_retire_recovery_darwin.go` | 原版与候选健康两条路径共用锁、归属核验和退休，分别核对各自应保留的签名应用。 |
| `mac_update_rollback_cleanup_darwin_test.go` | 真实签名候选经管道关闭和匹配父进程退出完成反向交换，再从原版锚点收尾；另验竞争健康、丢回执、旧代次、日志替换和外部反换后候选仍存活。 |

当前源码在 ARM64 与 x64（Rosetta）各通过 50 项回滚、授权及健康清理回归和 6 项真实测试助手及预授权回归，`go test -race` 均零跳过。双架构 `CGO_ENABLED=0 go build`、`go vet -tags=e2e ./...`、两项浏览器布局检查通过，224 个生产前端源码未变。日志：`.tmp/ui-qa/round211-rollback-cleanup-O8eVeC/`。这里的独立进程验了真实回滚交接和文件交换，授权存储仍是测试内存后端。没有打开正式钥匙串或普通启动自动恢复、未重跑全仓或重打包，Build 206 的 63 个文件摘要不变；没有修改宿主代理、推送或部署。

### 第 212 轮：普通启动按受保护授权分流，启用开关保持关闭

桌面服务启动时已有恢复入口，但运行分流的编译期开关保持关闭，环境变量不能打开；同时只面向正式模式并跳过活助手正在等待健康确认的新应用。今后启用时，无受保护记录不创建更新锁，空安装照常、旧日志只供原诊断展示。权限错误不是空记录。有授权时，取得同一目标锁与数据锁后再比较整份记录，才选择未绑定取消、保留原版或保留健康候选；封存检查点允许从日志已清的尾段继续。遇到仍运行的助手、同签名但身份不同的应用或授权换代，保留现场。

若观察到已安装的候选和有效的回滚授权，只返回“需要独立退出交接”，不结束进程、不换包。若受保护存储已经确认候选健康但助手尚未落盘 `healthy` 或清理检查点，只在原助手退出、两端应用身份吻合、日志中的候选 PID 和进程身份与受保护证明一致时，允许从 `launch_requested` 或 `healthy` 建立检查点继续收尾。原版或候选由受保护权限与实际文件共同确定，日志阶段不能授予权限。

| 文件 | 改动 |
| --- | --- |
| `mac_update_startup_recovery_darwin.go`、`mac_update_other.go` | 增加 macOS 启动分流及关闭的启用门禁，其他平台保持空操作。 |
| `service.go` | 在组件清理前调用更新恢复入口；即使更新恢复失败，也仍执行原有代理恢复。 |
| `mac_update_pending_abort_darwin.go` | 提取已持共用锁时的入口，避免启动分流重复取锁。 |
| `mac_update_replay_snapshot_darwin.go`、`mac_update_rollback_cleanup_darwin.go` | 快照携带已核对归属的日志和摘要，原版清理仍使用原角色条件。 |
| `mac_update_retire_recovery_darwin.go` | 受保护健康证明可从经核对的 `launch_requested` 固定检查点；删除前仍核对角色、签名和同一份日志。 |
| `mac_update_startup_recovery_darwin_test.go` | 以真实签名夹具和隔离内存授权覆盖各启动分流、无日志尾段、健康进程身份、竞态、拒权及本地默认启动。 |

ARM64 与 x64（Rosetta）各通过 65 项启动分流、回滚、健康收尾和授权回归，以及 6 项真实测试助手／预授权相邻回归，`go test -race` 全部零跳过。`go vet -tags=e2e ./...`、macOS／Windows／Linux 各双架构 `CGO_ENABLED=0 go build`、两项浏览器布局检查通过，224 个生产前端源码未变。日志：`.tmp/ui-qa/round212-startup-recovery-feKkkk/`。没有重跑全仓或重打包，Build 206 的 63 项文件校验不变。生产启用、普通启动发起实际候选退出交接、正式钥匙串权限与重启持久性仍待验证；没有读取宿主钥匙串、修改宿主代理、触发发布或部署。

### 第 213 轮：候选仅在独立助手确认接管后正常退出

候选再次核对本次回滚授权与原版助手副本的身份后，用私有管道启动该副本。助手从实际父进程取得候选身份，独立读授权并监视该进程的退出。`READY` 与 `ARMED` 绑定本次操作、代次、完整授权摘要和随机挑战；候选核对接管确认后才进入正常退出。握手拒绝只停止并回收本次直接子进程。助手收到真实父进程退出事件后才可复验并交换应用；关闭管道不等于退出。成功只将原版放回安装位置，不自动重新启动原版。

退出复用原生服务的关闭流程，取消下载、事件流和服务上下文，关闭空闲 HTTP 连接。进入交接前必须已经完成代理恢复；交接确认后的断开不再操作代理，也不清除启动屏障。回归先重现了：模拟已确认交接时，普通关闭清掉屏障，新的连接调用进入配置校验。修复后保持屏障关闭，直到候选进程实际退出。

| 文件 | 改动 |
| --- | --- |
| `mac_update_startup_handoff_darwin.go` | 启动精确助手副本，验证签名、授权和两阶段应答，拒绝时回收本次子进程。 |
| `mac_update_recovery_worker_darwin.go` | 独立入口从实际父进程取得候选锚，核对自己的路径和签名，重读回滚授权并复用实质换包流程。 |
| `mac_update_replay_handoff_darwin.go` | 管道挑战绑定完整授权并返回接管确认；继续要求收到匹配父进程的真实退出事件。 |
| `mac_update_startup_recovery_darwin.go` | 已安装候选且授权有效时，代理先恢复成功才开始退出交接；编译期开关继续关闭。 |
| `main.go` | 分派独立助手入口；确认交接后复用正常关闭，并允许窗口退出。 |
| `service.go` | 启动顺序先恢复代理，再判断是否可以交接。 |
| `runtime.go` | 已确认退出交接时，断开不再写代理或解除启动门禁。 |
| `mac_update_other.go` | 非 macOS 保持空启动恢复，独立助手入口明确拒绝。 |
| `mac_update_startup_handoff_darwin_test.go` | 真实临时签名候选与助手验证正确交接、错误摘要、错误应答；失败助手须退出且不得换包。 |
| `app_readiness_test.go` | 验证交接退出取消开启的下载与事件流，且退出前仍拒绝新连接。 |

最终快照在 ARM64 与 x64（Rosetta）分别执行 `go test -overlay … -race -count=1`，各 45 条通过（含子用例），零失败、零跳过。`go vet -overlay … -tags=e2e ./...` 与 `CGO_ENABLED=0 go build -overlay …` 的 macOS、Windows、Linux 双架构检查通过；`node --import tsx --test` 的更新中心及生命周期布局两项通过。`git diff --check` 通过。224 个前端文件与 Build 206 一致，`shasum -a 256 -c SHA256SUMS` 的 63 份候选文件通过，宿主系统代理只读摘要一致。命令模式和结果在 `.tmp/ui-qa/round213-startup-exit-handoff-aY1DtH/`。

授权在测试中经独立进程的签名挑战传递，不访问真实钥匙串，不等同于正式 GUI 退出、macOS 机器重启或实际签名更新验收。本轮未重跑全仓、重新打包、启用自动恢复、改宿主代理或操作线上；Build 206 不包含本轮改动。

### 第 215 轮：正式更新助手接入恢复授权的写入入口，仍默认关闭

正常更新助手和两个恢复读取端共用同一编译开关与安装级钥匙串授权槽。更新助手先验证私有管道、父进程、正在运行的签名助手、更新目录、原版和候选签名；持有目标锁和数据目录锁后，只读确认该安装没有未结束的受保护授权，才返回 `READY`。找不到授权记录是空槽；无权限、存储失败、损坏或已有未结束记录均拒绝交接，不替换记录或回退到普通文件。这个检查不是预留：收到 `ARM` 后才按既有规则原子预留，等原进程真正退出并持久化精确事务后才绑定、允许换包。即使两次操作间槽发生变化，也由原有条件创建拒绝覆盖。

先用临时签名的真实更新助手重现未接入时不能在 `READY` 前报告授权存储不可用。修复后，通过独立进程内的测试存储注入同一错误，助手不返回 `READY`、不写授权或留下更新日志，清除归属明确的暂存副本，原应用签名与目录身份不变。现有正常、绑定失败、健康收尾等用例继续按实际助手进程复验；正式钥匙串的系统调用仍只在适配器测试中截断验参。

| 文件 | 改动 |
| --- | --- |
| `mac_update_helper_darwin.go` | 按编译开关选择正式写入端；验签和隔离暂存后、`READY` 前做只读检查，保留 `ARM` 才写的顺序。 |
| `mac_update_recovery_slot_darwin.go` | 只在受保护记录确实不存在时允许准备新更新；不改现有或损坏记录。 |
| `mac_update_keychain_darwin.go` | 将钥匙串后端及安装级授权槽的打开方式合为一个入口。 |
| `mac_update_startup_recovery_darwin.go`、`mac_update_recovery_worker_darwin.go` | 两个读取端改用同一槽入口，读取与回滚行为不变。 |
| `mac_update_replay_darwin.go` | 移除已失效的“没有生产接线”注释，保留外部受保护授权要求。 |
| `mac_update_holder_darwin_test.go` | 从真实助手在打开存储的位置注入独立测试后端，校验收到已准备的安装计划。 |
| `mac_update_arm_recovery_darwin_test.go` | 复现存储不可用时不应返回 `READY`，另验 `ARM` 前没有预留。 |
| `mac_update_recovery_slot_darwin_test.go` | 验空槽只读放行，损坏或仍有预留时拒绝且原文不变。 |

最终快照以 `go test -overlay … -race -count=1` 在 ARM64 和 x64（Rosetta）各通过 44 条（含子项），零失败、零跳过。`go vet -overlay … -tags=e2e ./...`、macOS/Windows/Linux 各双架构 `CGO_ENABLED=0 go build -overlay …` 和 `node --import tsx --test` 的两条界面布局回归通过。另以仅供编译的临时副本打开开关，ARM64、x64 的 `go build -ldflags='-X main.buildMode=release'` 产生写入端和恢复助手符号，未执行这两份二进制。224 个生产前端源码、Build 214 的 62 份交付文件和宿主系统代理只读摘要均未变化。证据在 `.tmp/ui-qa/round215-update-writer-dC0pEZ/`。

当前工作树开关保持关闭，未读取或写入真实钥匙串，未触发发布、改线上、重跑全仓或重打包；Build 214 不含本轮改动。现有 GitHub 正式构建配置签名与公证，但尚未接入供 Data Protection Keychain 使用的 profile 和签名访问组。启用前仍必须完成正式签名资料接入、访问组正反控、跨进程条件更新和重启持久性验收。

### 第 216 轮：GitHub macOS 打包可选择嵌入恢复用 profile，仍不启用运行时恢复

未配置恢复 profile 时，现有正式签名、公证和发布不变，本地安装包不接受该输入。今后有专用 Developer ID 分发 profile 时，GitHub macOS 构建任务可从可选 secret `MACOS_UPDATE_RECOVERY_PROVISIONING_PROFILE` 取得 base64 编码文件，解码到 runner 独立临时目录，任务结束后删除。构建的文件路径为 `CHORDV_MACOS_RECOVERY_PROVISIONING_PROFILE`。它只影响签名及安装包内容，不能打开运行时恢复。

构建在 MyGo 生成和签名前检查 profile 的团队、精确 App ID、有效期和分发范围。团队前缀通配符只在 profile 的许可列表里使用；应用实际签名只声明同一个团队下的精确 `TEAMID.app.chordv.desktop.update-recovery` 组，不复制 profile 的其他权限。MyGo 在签名之前把已检查的同份文件嵌入 `Contents/embedded.provisionprofile`。DMG 进入 GitHub 资产暂存前，从镜像只读挂载出的应用和构建目录应用核对 profile 原始字节，同时读取实际签名声明验证精确组；原有 Developer ID、代码签名、公证校验继续保留。字段口径参照 [Apple TN3125](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles)。解码所得声明用于构建前一致性检查，不代替 macOS 对 Apple profile、签名与实际钥匙串访问的授权判断。

| 文件 | 改动 |
| --- | --- |
| `scripts/mygo-macos-recovery-signing.mjs` | 检查 profile 字段、生成最小签名权限、核对两个应用副本里的文件与实际签名声明。 |
| `scripts/mygo-desktop.mjs` | 仅允许显式 macOS 正式构建选择 profile，并在打包前把独立临时文件交给 MyGo。 |
| `.github/workflows/release-desktop.yml` | 只在 macOS 构建任务导入可选 secret，任务结束清理临时副本。 |
| `.github/scripts/desktop-build-info.mjs` | 在原有 DMG 与构建源身份核对中增加请求了恢复签名时的校验。 |
| `scripts/mygo-macos-recovery-signing.test.mjs` | 验证合法字段、错误团队、过期、越权权限、本地入口拒绝和两个副本不一致；用系统 `plutil` 和临时签名应用读取实际声明。 |

用 `node --test` 跑新专项、相邻构建测试和全套发布脚本，134 项通过、零跳过，包含原始 Build 214 本地 DMG 的现有暂存校验。另做 GitHub YAML 结构检查及两项 `node --import tsx --test` 布局回归；224 个前端源码和 Build 214 的 62 份文件摘要未变。日志：`.tmp/ui-qa/round216-macos-profile-VLMPNB/`。测试 profile 声明和临时签名夹具不是真实 Apple 材料；没有解码实际 Apple profile、访问实际钥匙串、用正式身份签名公证、重打包或触发 GitHub 工作流。正式 profile 接入后的签名、公证、实际访问组、跨进程条件更新与重启验收仍未完成，运行时开关仍为 `false`。

### 第 217 轮：更新助手仍存活时，确认新版失败后恢复原版

原实现中，有受保护授权的更新即使准确观察到新版原生启动失败并停止了候选进程，当前助手也不交换回原版。用户可能再次打开失败的版本。现在只有在初次换包已经确认，启动结果明确失败、候选已退出、健康提交未处于不确定状态时，才允许存活的原更新助手尝试恢复。

在目标锁、数据目录锁和独占启动锁内重读整份同代次回滚授权，核对已安装候选、保留原版、事务原文、当时日志摘要以及仍运行的精确原助手。与跨启动回滚走同一条进程检查和目录交换；反向交换后复验当前安装位置确实是原版。回滚只恢复原版并保留候选、日志和授权，不自动启动原版或删除诊断资料。安装失败报告保留原失败原因并明确原版已恢复。原版重新打开后继续使用现有受保护收尾逻辑。

若正向交换的结果不确定、授权换代、当前助手或文件身份变化、候选未确认退出，仍不尝试换回。健康状态已经提交但助手丢失回执也保留两版，不把丢回执当成新版失败。真实临时签名助手用例分别检验精确换回、授权换代时不换回、健康回执丢失时不换回；未运行正式钥匙串后端。

| 文件 | 改动 |
| --- | --- |
| `mac_update_apply_darwin.go` | 在确定失败分支补齐存活助手的受保护回滚，复验原版后报告恢复，不启动旧版或清理更新资料。 |
| `mac_update_replay_darwin.go` | 存活助手与跨启动助手共用最后的候选进程检查及原子换包步骤。 |
| `mac_update_replay_snapshot_darwin.go` | 持久化事务复验返回已核对的原助手 PID；原来的回放与收尾判断继续保留。 |
| `mac_update_arm_recovery_darwin_test.go` | 用真实临时签名 App 验证新版进程实际退出、旧版恢复、授权换代拒绝及丢回执保护。 |
| `mac_update_health_darwin_test.go` | 健康握手夹具按测试进程架构编译，避免 Rosetta 复测误拿 ARM64 程序；不放宽生产架构校验。 |

先用两个实际更新助手子例复现原实现未回滚、也未重新读取授权，随后 `go test -overlay … -race -count=1` 复验通过。较广复测 ARM64 先通过 40 条；x64 首次 32 条通过、8 条报告同一健康握手夹具架构不匹配（含父项），不是新版回滚用例失败。修正夹具编译参数后两架构的健康握手组各 17 条通过，合并去重后两架构分别覆盖相同的 49 条通过用例，零跳过；保留首次失败日志，不计作单次全绿。最终 `go vet -tags=e2e`、macOS/Windows/Linux 各双架构 `CGO_ENABLED=0 go build`、两项浏览器布局测试及 `git diff --check` 通过；224 个前端源码及 Build 214 的 62 份文件均不变。证据：`.tmp/ui-qa/round217-live-protected-rollback-x53rJp/`。

为避免本机磁盘耗尽，核对原摘要并确认虚拟机已退出后，仅删除 Build 214 的两个已用完的测试内存盘镜像和隔离 Vite 依赖缓存，保留根文件系统、报告、截图、源码快照和交付包。未重跑全仓、打包、开启恢复开关、访问真实钥匙串、修改宿主代理或发布；Build 214 不包含本轮改动。正式签名下的实际恢复和重启仍未验，当前实现恢复原程序文件，但不自动打开旧版。

### 第 218 轮：正常打开原版时，等恢复结束再读安装报告

原生恢复与界面启动并行，界面的安装报告只读取一次。原实现会在恢复仍运行时消耗报告，并按当时仍存在的日志返回“恢复待确认”。先用原生桥接调用复现这一结果；修复后，只让该调用等待现有的原生启动完成信号，不影响窗口展示、不加延时或轮询。真实恢复清除日志时，读取的是最后的失败报告和“原版本已恢复”，不再附上错误的待确认状态；无法清理时仍照常返回实际警告。请求取消时不消耗文件，等待更新健康确认的候选或已经交接退出的候选也不读取上一轮报告，留给下一次普通启动。

| 文件 | 改动 |
| --- | --- |
| `installer_report.go` | 等待启动结束，根据最后的日志状态读取报告；取消或临时候选不消耗文件。 |
| `service.go` | 给原生报告命令传入该调用的上下文，使等待可取消。 |
| `installer_report_test.go` | 验证取消、两种临时候选保留报告，以及下一次普通启动只消费一次。 |
| `mac_update_recovery_darwin_test.go` | 验证在日志清除和保留两种状态下，界面调用都不会提前收到旧状态。 |
| `mac_update_rollback_cleanup_darwin_test.go` | 用真实临时签名的候选退出与原版回滚、独立测试授权槽，确认报告等过真实收尾、一次性返回，原版进程仍存活。 |

ARM64、x64（Rosetta）分别运行 `go test -overlay … -race -count=1`，各 29 条通过（含子用例）、零失败、零跳过。`go vet -tags=e2e`、macOS ARM64、Windows x64、Linux ARM64 的 `CGO_ENABLED=0 go build` 和 `git diff --check` 通过。布局测试首次并发执行时有一张截图因磁盘空间不足未写出；以 `node --import tsx --test --test-concurrency=1` 串行重跑后两项均通过。224 个前端源码和 Build 214 的 62 份文件不变，未新增生产 Mock。证据在 `.tmp/ui-qa/round218-settled-install-report-8K1fRd/`。

未启用正式运行时开关、访问实际钥匙串、修改宿主系统代理、重打包或重跑全仓。尚未实现回滚后自动打开原版，Build 214 不含本轮改动；正式钥匙串、机器重启验证和 Windows 实机升级仍待验收。

### 第 221 轮：存活的更新助手回滚后重新打开原版

确认新版启动失败并已退出、恢复授权未变、反向换包完成且原版身份复验通过后，原更新助手经已有的 macOS 启动接口重新打开原版。启动只传本次数据目录，不从恢复日志读入启动参数或任意环境变量；如果未能确认启动，报告明确原文件已恢复，仍可手动打开。正常更新的失败报告不会被写成新版安装成功，也不把操作系统启动回调当成原版界面已经就绪。

原版通过受保护记录核对自己的安装身份。只有准确匹配本次回滚的原版才会在取得清理锁之前，核对原助手的进程身份、路径与运行签名，等待内核报告它退出；不发送终止信号，不轮询。短暂等不到或原助手身份不明时仍保留资料。观察退出后，原版重新取锁、重读整份授权和文件状态，再走原有清理。候选应用的退出交接和独立跨启动回滚不受这条重开路径影响。

| 文件 | 改动 |
| --- | --- |
| `mac_update_apply_darwin.go` | 存活助手确认恢复原版后复用普通 macOS 重开入口；只记已请求启动，失败时保留手动打开提示。 |
| `mac_update_startup_recovery_darwin.go` | 仅准确的原版在清理前等待受保护记录对应的签名原助手退出。 |
| `mac_update_recovery_darwin.go` | 内核已退出但尚在回收的进程不再被当成存活助手；仍不接受其他身份的活进程。 |
| `mac_update_arm_recovery_darwin_test.go` | 真实临时签名原版通过系统重开后留下进程启动见证；授权发生变化时不得重开。 |
| `mac_update_startup_recovery_darwin_test.go` | 启动检查在原助手仍活着并持锁时不清理，也不终止助手；该进程真正退出后才清理。 |
| `scripts/mygo-verify-mac-recovery-log.mjs` | 将原版等待真实助手退出加入发布前必须验证的 Go 用例。 |

分别复现旧版没有重开原版、原版启动遇到存活助手立即失败，修复后以同一套真实临时签名进程复验。ARM64、x64（Rosetta）各以 `go test -overlay … -race -count=1` 通过 50 条（含子项），零失败、零跳过；发布门槛验证器从两份实际日志确认 15 项必测用例，也确实拒绝仍只有 14 项的 Build 220 成功日志。`go vet -tags=e2e`、三平台双架构 `CGO_ENABLED=0 go build`、门槛的三条 Node 测试及两项浏览器布局检查通过。224 个前端源码、Build 220 的 64 份交付文件和本机系统代理只读摘要都未变化。证据在 `.tmp/ui-qa/round221-live-original-reopen-8SCx39/`。

本轮未重跑全仓、重新打包、启用正式开关、访问实际钥匙串或触发发布与部署。上述系统启动与原版等待是在临时签名和隔离授权槽中分别验收，未宣称正式 GUI 健康、正式签名或重启已验证；原助手已退出后由独立跨启动助手换回原版的路径仍未自动重开。Build 220 不含本轮新改动。

### 第 222 轮：独立恢复助手回滚后重新打开原版

独立助手收到真实候选退出事件，复验受保护授权并完成反向交换后，重新验证安装位置的原版签名和持久文件身份，再经 macOS 请求打开它。普通只读回放、原版已在安装位置、回滚未发生或结果不确定时，不触发重开。启动以固定数据目录为唯一传参；恢复报告保留「更新未成功」，区分已请求打开和未确认打开，操作系统接收启动不等于界面就绪。

精确原版启动时仍先确认事务记录中的原助手状态；然后从受保护计划定位独立助手副本，以内核路径、进程启动时间、运行签名与退出事件确认它已结束。等待不发送信号、不轮询。助手退出后原版重新加锁并重读整份授权才继续收尾；身份不明、权限不匹配或超时时保留两端应用及诊断资料，不清理仍在运行的副本。

| 文件 | 改动 |
| --- | --- |
| `mac_update_recovery_worker_darwin.go` | 仅独立助手可进入重开路径；核对被恢复的原版、调用系统启动并写明实际结果。 |
| `mac_update_replay_darwin.go` | 只在本次成功反向交换后调用重开；启动请求和报告写入期间仍持安装及数据锁。 |
| `mac_update_replay_handoff_darwin.go` | 区分独立助手和普通回放；复用按内核路径核对同一用户进程的逻辑。 |
| `mac_update_startup_recovery_darwin.go` | 精确原版等待两个助手退出，再重新加锁、重读授权和清理。 |
| `mac_update_startup_handoff_darwin_test.go` | 临时签名进程完成真实退出、回滚、系统启动、异步收尾；无效握手不得重开。 |
| `mac_update_holder_darwin_test.go` | 在 Go 初始化后启动测试助手；恢复夹具通过 MyGo 的原生事件循环执行收尾。 |
| `mac_update_recovery_darwin_test.go` | 提取临时签名助手夹具，支持在原事务助手已退出后启动另一个助手进程。 |
| `mac_update_startup_recovery_darwin_test.go` | 分别验证原助手和独立助手仍活着时原版等待、不强停、不清理。 |
| `scripts/mygo-verify-mac-recovery-log.mjs` | 两类助手的退出等待分别列为发布前必测项；旧版仅有父项通过不算通过。 |

红测分别证明：旧实现完成交换却不重新打开原版；在旧版看到不同 PID 的独立助手时，直接撞上安装锁并放弃收尾。修复后 `go test -overlay … -race -count=1` 在 ARM64 及 x64（Rosetta）各通过 52 条（含子项，零跳过），两份日志均经 `node scripts/mygo-verify-mac-recovery-log.mjs` 确认 16 条必测用例通过，旧日志则被拒绝。`go vet -tags=e2e`、三平台双架构 `CGO_ENABLED=0 go build`、发布门槛 Node 测试、两条浏览器布局回归均通过。

独立目录离线构建两份 Build 222 DMG；通过 `hdiutil verify`、包内签名与身份校验、从原始 DMG 启动的本地真实 GUI 首屏测试，以及交付 `shasum -a 256 -c SHA256SUMS`。GUI 测试不启用受保护恢复，两架构的恢复证据来自单独的临时签名进程。224 个生产前端源码、Build 220 的 64 份文件和宿主系统代理只读摘要未变。本轮不改变生产路径或引入 Mock；测试授权槽只在测试文件中存在。未验证正式开发者签名、公证、钥匙串、机器重启、宿主系统代理恢复、Windows 实机和 GitHub 实际发布。记录位于 `.tmp/ui-qa/round222-independent-reopen-oTw0Ym/`，交付在 `output/local-candidates/chordv-1.1.12-build222-macos/`。
