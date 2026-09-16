# Windows 官方更新器迁移（2026-09-16）

## 实施阶段记录（最终状态以 PR #57 与发布工作流为准）

Windows 已接入 tauri-plugin-updater 2.11.0 + NSIS passive 模式。保留更新中心、真实下载进度、强制更新策略。旧的 PowerShell 覆盖目录流程、ZIP 构建及临时修复工具已退役；用户原始诊断文件未修改。
后台目标版本为 0.0.20，客户端保留 1.1.8 重构建；生产数据库未迁移。macOS 原生测试不等于 Windows 安装验证。

## 故障证据

用户日志只包含 2026-07-14 的成功更新，9 月 16 日没有新增日志。实际更新脚本为 UTF-8 无 BOM；用 PowerShell 解析器验证，UTF-8 解码无错误，CP936 解码产生六项语法错误。这与助手未执行第一条日志、旧程序已经退出的现象一致；未读取故障电脑实际代码页，不能称所有现场条件均已复现。

## 新链路

- 构建 NSIS EXE 与同名 .exe.sig，发布前核验签名和平台版本号。
- 后台远程获取 EXE 时自动获取原地址追加 .sig 的签名；本地上传条件显示签名文件选择框。
- 后台通过 Node 内置 Ed25519/BLAKE2b 验证 Minisign 包签名及 trusted comment 签名。上传、替换、复用和发布验证覆盖签名。
- 业务策略沿用 POST /api/client/update/check；官方插件使用 GET /api/client/update/tauri。描述和已发布安装包公开，不将登录令牌发送到下载服务器。
- 官方插件下载后独立验证签名，只把已验证的内存字节交给安装接口。缓存文件替换不能改变实际安装内容。
- 点击安装后先停止代理和内核；官方插件启动安装器并退出，NSIS 显示安装进度并重新启动客户端。
- 下载完成、安装器启动与安装成功分开处理；下次启动对照待安装目标版本，未完成时提示仍在运行原版本。

## 安装期间启动保护

NSIS PREINSTALL/POSTINSTALL hook 持有 Local\ChordV.Update.InProgress 内核互斥对象。新客户端在创建窗口前检测并立即退出；成功安装后释放，再启动新版。安装器进程结束也会释放，不留下磁盘锁。
历史 chordv-desktop.exe/chordv_desktop.exe 路径交给 Tauri 安装器标准进程检查。没有按名字广泛强杀进程，也没有安装期 PowerShell。文件安装由 NSIS 承担，不宣称官方更新器提供事务回滚。

## 旧版本过渡

已安装的 1.1.7、旧 1.1.8 无法被新代码追溯修复。后台对旧 artifactType=zip 请求返回 EXE 的一次性 external_download 入口；新客户端用 setup.exe 请求官方模式。
这一次需要下载 EXE、断开并退出旧程序后覆盖安装。后续升级才走应用内官方流程。历史 ZIP 可管理，但不再用于新上传、导入、复用或客户端下载；缺少签名安装器时不退回旧 ZIP。

## 签名配置

公钥位于 tauri.conf.json 和 packages/shared/src/windows-updater-key.ts，测试校验一致。
私钥位于本机 /Users/a1234/.codex/secrets/chordv-updater/windows.key，仅属主可读写；GitHub Secret TAURI_SIGNING_PRIVATE_KEY 已配置。私钥未进入源码、测试 fixture 或日志。
PR 安装测试使用临时密钥，不读取生产私钥。更新签名不是 Authenticode 证书，不能保证消除 SmartScreen/UAC 提示。

## 修改文件与职责

- apps/desktop/src-tauri/src/windows_update.rs：官方下载/安装、大小和版本检查、安装结果、启动门禁及插件真实签名测试。
- apps/desktop/src-tauri/src/lib.rs：插件/命令接入，删除旧全量更新实现。
- apps/desktop/src-tauri/src/update_report.rs：兼容历史 BOM 报告，解析失败不删除证据。
- apps/desktop/src-tauri/Cargo.toml、Cargo.lock：官方更新器依赖及跨平台测试编译。
- apps/desktop/src-tauri/tauri.conf.json、windows/chordv-installer-hooks.nsh：公钥、passive 模式、安装期间门禁与旧程序路径迁移。
- apps/desktop/src/api/client.ts、src/lib/runtime.ts、src/lib/updateState.ts、src/hooks/useUpdateFlow.ts：EXE/签名协议、进度接入、安装交接和可见错误。
- apps/api/prisma/schema.prisma、migrations/20260916030000_windows_updater_signature/migration.sql：可空 updaterSignature 字段，不改写历史数据。
- apps/api/src/modules/common/updater-signature.ts、release-center.service.ts、release-center.utils.ts：签名获取/验证/存储/复用/发布及旧版本桥接。
- apps/api/src/modules/client/client.controller.ts、modules/admin/admin.dto.ts：更新描述与签名输入校验。
- packages/shared/src/types.ts、windows-updater-key.ts、index.ts：共享签名字段和公钥。
- apps/admin/src/api/client.ts、pages/ReleasesPage.tsx、features/releases/ArtifactEditorModal.tsx、ReleaseEditorModal.tsx、RemoteArtifactSourceFields.tsx、types.ts：发布表单与文件选择。
- apps/desktop/scripts/build-tauri-platform.mjs、check-windows-bundle.mjs、platform-version.mjs：EXE+SIG 产物与检查，清理旧 ZIP。
- scripts/verify-windows-updater-signature.ts、.github/workflows/release-desktop.yml、verify-desktop-native.yml：签名/版本与真实安装发布门禁。
- apps/api/test/windows-updater.regression.ts、fixtures/tauri-signature.json、apps/desktop/test/update-handoff.regression.mjs、windows-full-update-path.regression.ts、windows-update-protocol.regression.ts、windows-nsis-upgrade.ps1：签名、迁移、交接和安装回归。测试 fixture 不含私钥。

## 已执行验证

- pnpm --filter @chordv/api db:generate；shared build；API/admin/desktop check。
- pnpm --filter @chordv/desktop build；pnpm --filter @chordv/admin build。
- macOS cargo test --lib --locked --target aarch64-apple-darwin：52 项通过，包括官方插件真实 HTTP 下载与篡改拒绝。Windows 集成模块参与测试编译。
- tsx API 专项：windows-updater、release-semver、runtime-release-contract、release-artifact-import、release-artifact-import-service。
- 前端专项：releases、update-handoff、windows-full-update-path、windows-update-protocol。
- 构建脚本 Node 语法检查、PowerShell 升级测试解析、git diff --check。

## 未执行与布局边界

本机没有 Windows 桌面，未运行 NSIS EXE；没有触碰用户安装目录。Windows CI 尚未运行。
CI 将核对真实 1.1.7 安装器哈希，在带中文/空格的目录安装并升级，检查实际版本、资源、新版主窗口和启动门禁；发布也必须通过同一测试。
未做浏览器或截图验证。静态检查确认只在上传 Windows EXE 时增加签名选择框，沿用现有间距和滚动区域；未改 CSS、客户端布局或工单样式。
没有新增生产 Mock 或演示入口。原有分块体积警告未在本任务中扩大重构。

## 上线顺序

先通过 PR 审查和 Windows CI并准备签名包；部署含新迁移的后台，再导入发布 EXE/SIG，引导旧用户覆盖升级。新发布版本应高于已安装版本，同版本重打包不能自动触发更新。
本次未执行合并、生产迁移或发布。

## Windows 验证补充

2026-09-16 的 CI 已确认 Windows 原生测试 54 项通过、macOS 原生测试 53 项通过。Windows 测试程序需额外嵌入 Common Controls v6 清单，否则官方插件的 mock-app 测试引用 Wry 的 TaskDialogIndirect 时会在加载阶段失败；应用发布程序的 Tauri 清单不受此测试处理影响。
`run-windows-native-tests.ps1` 使用 Cargo 返回的精确测试可执行文件及 Windows SDK mt.exe，不跳过测试。`diagnose-windows-loader.ps1` 在失败时定位 DLL/入口缺失。
`serve-updater-fixture.ts` 将实际 ClientController/ReleaseCenterService 暴露在本机端口，由官方插件直接验证托管地址、下载及签名；测试子进程直接加载 TS 以便可靠清理。
后台完整发布验证已通过 73 条测试命令。真实 NSIS 升级步骤在本记录写入时仍待后续 CI，发布前必须通过。
