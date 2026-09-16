# Windows / macOS 原生线程与退出可靠性检查（2026-09-15）

本记录覆盖本地修复、定向回归和 macOS ARM64 预览构建。Windows 本机编译被 MSVC SDK 缺失阻断；提交后的双平台 runner 结果以 PR 检查及后续记录为准。发布验收仍需区分编译/回归与真实代理运行。

## 已确认的现场死锁

2026-09-15 17:22（UTC+8）对 macOS 1.1.8 进程采样三秒：

- 主线程：WebKit IPC → runtime_status → 等待 RuntimeState 互斥锁。
- 连接线程：持有 RuntimeState → sync_shell_from_runtime → refresh_shell_ui → MenuItemBuilder::build → 等待主线程。
- 内核已启动且仍有转发活动，持续转圈来自线程环形等待。

原有测试没有覆盖菜单创建与 IPC 主线程的交互。完整采样仅保存在本机 `/tmp/chordv-connection-hang-sample.txt`，不提交用户流量日志、配置或凭据。

## 检查范围与最终行为

检查了 lib.rs 的 34 个 IPC 命令，以及菜单/托盘、启动/退出、连接/断开、组件与安装包处理、原生会话刷新、窗口动画的相关调用链；包含 Windows 和 macOS 条件分支。

1. 菜单和托盘刷新整体投递到主线程；创建菜单前复制并释放 ShellState。持有运行时锁的工作线程不再同步等待菜单创建。
2. 状态、日志、会话文件、组件校验/复制、路由测试及安装包校验等阻塞操作放到工作线程；下载中的同步文件处理不占用 async 调度线程。托盘读取切换中状态不再等待运行时锁。
3. 系统工具使用统一有限执行器：单次最多 5 秒；网络占用检查整组预算 2.5 秒，代理设置/清理整组 15 秒。预算耗尽前不再启动后续命令，超时子进程被终止并回收。匿名输出文件避免管道背压和后代进程持有管道导致的 EOF 等待；输出限制 2 MiB。
4. TLS 指纹探测有共同的 5 秒 DNS/连接/握手截止时间；到期 shutdown socket，唤醒仍在阻塞握手的线程。
5. 连接失败统一回收初始化状态；未提交的内核进程由 RAII 守卫回收。配置写入、进程启动等早期错误不再留下 starting/connecting；代理设置结束再检查取消代次。
6. 原生会话文件使用代次及互斥写入、原子替换。已过期的刷新/保存不会覆盖新登录，延迟清理不会删除新会话；前端按原刷新令牌所属登录拒收迟到的原生刷新事件。
7. 状态读取失败保留最后已知状态并标明读取异常，不伪装成 idle；退出需确认本机已停止。连接失败清理、重连和退出调用方均处理停止失败，不继续创建新连接或假报退出成功。
8. macOS 按网络服务分别核对代理归属，只清理识别为本应用的服务；清理命令失败会返回错误。设置归属标记提前，支持部分设置后的回收。
9. 启动磁盘/系统工具维护移出 UI 线程，新连接及组件替换等待维护完成；退出清理只在工作线程执行一次，不再在 ExitRequested/Exit 重复阻塞。日志只读末尾最多 256 KiB，诊断写入移出 IPC 主线程并一次写入完整行。

## 修改文件

### 原生代码与依赖

| 文件 | 修改 |
| --- | --- |
| apps/desktop/src-tauri/src/lib.rs | IPC 工作线程边界、菜单快照、生命周期调度、连接失败回收、系统命令预算、每服务代理清理及新辅助模块接线 |
| apps/desktop/src-tauri/src/bounded_command.rs | 命令时限、输出上限、操作预算与子进程守卫；真实子进程测试 |
| apps/desktop/src-tauri/src/session_store.rs | 会话代次、互斥读写及原子替换；真实临时文件并发顺序测试 |
| apps/desktop/src-tauri/src/startup_gate.rs | 启动维护完成屏障、失败及等待超时；线程等待测试 |
| apps/desktop/src-tauri/src/tls_fingerprint.rs | 有限 TLS 探测及超时 socket 关闭；无响应本机 TLS 对端测试 |
| apps/desktop/src-tauri/src/log_tail.rs | 限量日志尾部读取，覆盖大文件及残缺 UTF-8 |
| apps/desktop/src-tauri/Cargo.toml、Cargo.lock | 将已有锁定版本 tempfile 3.27.0 声明为直接依赖；没有新增库版本或更新现有依赖版本 |

### 前端与自动验证

| 文件 | 修改 |
| --- | --- |
| apps/desktop/src/App.tsx | 拒收退出/重新登录后的迟到原生刷新事件 |
| apps/desktop/src/lib/runtime.ts | 原生刷新事件包含其替换的 refresh token，仅用于登录归属验证 |
| apps/desktop/src/lib/nativeSessionRefresh.ts | 纯登录归属判断函数 |
| apps/desktop/src/hooks/useRuntimeStatus.ts | 状态读取失败不清空真实连接信息；停止操作需确认结果 |
| apps/desktop/src/hooks/useAuthBootstrap.ts | 退出/刷新清理失败显示错误，不产生未处理异常 |
| apps/desktop/src/hooks/useRuntimeActions.ts | 停止失败阻止重连，连接错误与清理错误合并报告 |
| apps/desktop/test/runtime-shell-threading.regression.mjs | 编译实际菜单调度函数到主线程适配器，复现锁等待顺序；检查阻塞命令隔离 |
| apps/desktop/test/native-session-refresh.regression.ts | 退出、换号、同账号重新登录后的刷新事件拒收 |
| apps/desktop/test/runtime-status-failure.regression.ts | 查询失败、停止失败及仍活动状态不伪装成成功断开 |
| apps/desktop/test/runtime-action-failure.regression.ts | 清理失败被正确处理，重连/退出不会继续执行 |
| .github/workflows/verify-desktop-native.yml | 新增只读 Windows 2022 / macOS 14 PR 原生编译和行为回归门禁，不上传或发布资产 |
| 本文 | 现场原因、逐文件修改、验证结果与平台边界 |

## 验证与边界

- Rust `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --locked`：33 项通过。
- 桌面既有及新增 TypeScript/Node 回归分别运行；覆盖线程调度、状态、连接、退出、原生刷新、更新交接、Windows 更新路径和窗口配置。
- `npm --prefix apps/desktop run check`、`node apps/desktop/test/runtime-shell-threading.regression.mjs`、`git diff --check` 通过。
- `bash start-app.sh --build-only`：macOS ARM64 原生预览构建通过。独立标识 `app.chordv.desktop.preview`，不自动接管正式客户端账户目录。
- 新增 workflow 的 YAML、双平台矩阵和只读权限已解析验证；GitHub runner 未执行。
- Windows `cargo check --target x86_64-pc-windows-msvc --locked` 未完成：本机缺少 MSVC C 运行库头文件，ring 依赖编译报 `assert.h file not found`。不能把 Mac 编译通过解释为 Windows 编译通过。
- 未进行修复版真实代理连接、Windows 真机、强制结束场景的实际系统代理恢复或浏览器/截图验收。没有对用户当前代理配置进行写操作，没有启动安装器或更新生产服务。
- 已进入的单次磁盘/OS 系统调用不承诺可强制中断；阻塞工作与 UI 分离，系统子进程和 TLS 已有明确截止机制。

没有改变页面布局、菜单内容、协议或后台接口；错误提示使用已有反馈组件。旧同步处理链已替换，生产没有测试替身或新增演示入口。tempfile 用于匿名命令输出和原子凭据文件替换，避免自制临时文件安全处理。此轮修改仍需 PR 和双平台门禁后才能发布。

## PR #55 首轮修复

- exit_gate.rs / lib.rs：退出区分未开始、清理中、已完成，重复退出请求不会跳过清理。
- session_store.rs：以原子代次的清理标记使旧凭据立即不可读取，覆盖删除文件前原生刷新启动的窗口。
- proxy_cleanup.rs / lib.rs：识别一个服务后立即清理，再检查下一服务，后续查询失败不再阻止先前服务的清理；单服务检查限时 2 秒。
- useAuthBootstrap.ts / runtime-action-failure.regression.ts：凭据删除失败明确报告，不继续清除前端登录状态。

初始提交 054b5ab 的 Windows/macOS runner 已通过。首轮修复本地 Rust 36 项及线程、退出相关回归通过；后续提交以各自最新 SHA 门禁为准。

## PR #55 第二轮修复

- session_store.rs：文件落盘成功后才提交代次，失败保留清理标记；clear_with 在会话 IO 保护区中复核归属、执行运行时清理并删除凭据，迟到清理不停止新登录连接。
- exit_gate.rs / lib.rs：清理失败重置退出门禁供重试，只有成功才退出；断开和安装交接传播代理/内核停止错误，不把失败视为成功。
- 新增持久化失败、迟到清理不停止新连接、退出失败重试测试。

本地 Rust 39 项、线程测试、更新交接测试通过；8f0f8ed 的 Windows/macOS 门禁已通过，最新修复等待各自门禁和复审。

## PR #55 第三轮修复（2026-09-16）

- startup_gate.rs：区分“维护完成”和“维护成功”，初始化失败仍允许执行退出清理，未结束的维护仍受等待时限约束。
- exit_gate.rs / lib.rs / android_runtime.rs：退出开始后禁止连接准入，并在取得运行时锁及启动阶段再次检查，避免退出清理后新内核又启动。
- 新增退出期间排队连接被拒绝、初始化失败允许退出的回归，本地 Rust 40 项、实际线程调度测试及 diff 检查通过。

## PR #55 第四轮修复

- lib.rs：每个原生连接尝试分配独立 ID，回滚同时验证尝试所有权和会话，重复请求不取消已在进行的连接。
- session_store.rs / lib.rs：保存请求在入队时领取顺序票据，登录失效与普通保存顺序分离；正序完成允许更新覆盖旧值，倒序完成拒绝旧请求覆盖新值。
- 新增相同会话不同连接尝试、凭据保存两种执行顺序测试，Rust 42 项、线程测试及 diff 检查通过。
