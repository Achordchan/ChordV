# 进度面板方案 1 实现

参考方案 1，右下角 400px 紧凑浮窗；保持现有客户端其余界面。未提交、未开 PR、未发布。

## 文件改动

- `apps/desktop/src/components/RuntimeAssetsBanner.tsx`：新浮窗内容，详情、取消、重试和阶段状态；删除旧 Alert 布局及猜测百分比。
- `apps/desktop/src/components/RuntimeAssetsBanner.module.css`：局部排版、边框、进度条、响应式、键盘焦点样式。
- `apps/desktop/src/lib/downloadProgressPresentation.ts`：从真实字节和明确阶段派生标题、比例、取整数字、状态文案。未收完时不四舍五入为 100%。
- `apps/desktop/src/lib/runtimeComponents.ts`：新增 verifying 下载阶段；UI 状态保留下载阶段。
- `apps/desktop/src/lib/runtimeAssetsState.ts`：保留原生阶段，校验时不将整体任务标记完成。
- `apps/desktop/src/lib/runtime.ts`：识别 verifying 原生事件。
- `apps/desktop/src-tauri/src/lib.rs`：在 SHA-256 校验前发出 verifying 事件；下载本身继续使用实际写入字节及服务器元数据，检查长度不符。
- `apps/desktop/src/styles.css`：从顶部大遮罩改为右下角面板；移动端避开底部导航；有计量提示时抬高面板；删除已无调用的 desktop-state-banner 旧样式。
- `apps/desktop/src/App.tsx`：开发模式下载调试按钮、真实任务优先、计量提示避让。
- `apps/desktop/src/main.tsx`：仅开发模式支持 `?download-preview` 独立预览。
- `apps/desktop/src/dev/DownloadProgressDebug.tsx`：独立模拟状态和每 50ms 推送快照的计时器播放，不修改真实状态、不下载文件、不请求接口。
- `apps/desktop/src/dev/DownloadProgressDebug.module.css`：独立调试窗口定位和样式。
- `apps/desktop/test/download-progress.regression.ts`：实际比例、未知总量、99.9% 不提前完成、明确校验阶段回归。
- `design-qa.md`：选定方案和实现的组件级对照结果、验证边界。
- 本文及 `client-admin-experience-20260915.md`：交接记录与原暂缓任务状态更新。

## 使用

本地开发客户端左下角“下载调试”可随时打开；独立页面 `http://127.0.0.1:5199/?download-preview` 已启动并留在应用内浏览器。

可选 5/15/60 秒模拟时长、手动拖动进度、查看未知大小/检查/校验/失败/取消/完成；不影响后台 start.sh。构建产物不包含调试窗口或该预览入口。

## 验证与边界

- `npm --prefix apps/desktop run check`、`npm --prefix apps/desktop run build`、`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`、`git diff --check` 通过。
- TSX 执行 `download-progress.regression.ts` 和 `runtime-assets-state.regression.ts` 通过。
- 已在应用内浏览器进行组件级对照及详情、取消、校验交互检查；没有反复验收整页。
- 已检查生产 dist，不包含 `本地下载调试`、`播放模拟下载`、`download-preview`、`DownloadProgressDebug`。
- 未执行真实 Windows 下载或生产安装；小屏适配检查了 CSS，未截图。Vite 仍有既有大包警告，Rust 有平台条件代码未使用警告。
- 数字百分比取整，进度条使用真实比例；下载 100% 与校验/解压/保存完成严格区分。未知总量保留明确状态兼容，不再猜测 18%/45%/92%。


## 5 秒模拟播放修复

- `DownloadProgressDebug.tsx`：不再依赖 requestAnimationFrame；每次更新捕获不可变进度值，暂停和重播立即取消旧计时器。
- `src/dev/simulateDownload.ts`：按实际经过时间计算模拟比例，50ms 一次通知，完成或取消后停止计时。
- `test/download-simulation.regression.ts`：验证 5 秒模式在 1 秒时达到 20%、2 秒时达到 40%，暂停不再更新、重播从零开始、完成后无剩余计时器。
- 定向回归、desktop check 和 git diff --check 通过。应用内浏览器已观察到 5 秒播放期间的 3%/4% 中间状态，无需点击暂停。用户同时在预览中操作，未把后续切换到 60 秒的截图作为精确的 5 秒耗时证据。
- 本次只修改 DEV 模拟器，无生产下载逻辑或布局改动；未重复执行真实 Windows 下载和生产构建。

## 从当前位置继续模拟

- `DownloadProgressDebug.tsx`：主按钮按状态显示“开始模拟 / 继续模拟 / 已完成”；手动拖动、暂停、失败或取消后保留当前字节数；“从头重播”明确从零开始。手动拖动也保持未知总大小场景。
- `download-simulation.regression.ts`：新增从 40% 继续、暂停后再继续的时长与清理验证。完整时长 5 秒时，40% 至 100% 共需 3 秒。
- 定向回归、desktop check、git diff --check 通过；应用内浏览器观察到从 58% 继续到 61%，没有归零。
- 布局检查：控制按钮可自动换行，不改生产面板布局；仅 DEV 模拟，无 HTTP Range 请求、持久化临时文件或真实断点续传实现。未执行真实网络断点续传验证。

## 原生客户端全部下载统一

用户确认视觉自行验收，本阶段未继续截图或操作界面。

- 新增 `components/DownloadProgressPanel.tsx` 和 `DownloadProgressPanel.module.css`：所有应用内下载共用唯一面板实现及样式，原 RuntimeAssetsBanner 样式文件已迁移。
- `RuntimeAssetsBanner.tsx`：仅保留 Xray / GeoIP / GeoSite 状态转换。
- 新增 `ClientUpdateProgressPanel.tsx`：Windows 完整 ZIP 和 macOS 安装包使用相同面板；只提供实际支持的重试、安装操作，不添加无实现的取消按钮。
- `App.tsx`：右下角统一排列下载任务；更新确认窗口内也复用同一面板。删除旧组件错误弹窗及其镜像编辑入口，保留现存镜像配置兼容读取。工单附件上传保持原样。
- `hooks/useUpdateFlow.ts`：开始应用内下载后收起更新确认窗口；删除循环假进度，验证阶段保持忙碌。
- `lib/updateState.ts`：删除旧 displayUpdateDownloadProgress / describeUpdateDownload / phaseMessage，保留按实际字节计算的函数，加入 verifying。
- `lib/runtime.ts` 与 `src-tauri/src/lib.rs`：安装包校验事件贯通原生端到 UI，不将下载结束当作校验结束。
- `hooks/useRuntimeAssets.ts` 和 `lib/runtimeAssetsState.ts`：清理旧错误弹窗状态及开关判断。
- `dev/DownloadProgressDebug.tsx`：可切换 Xray、GeoIP、GeoSite、客户端更新包；模拟安装按钮只显示提示，不执行安装或重启。
- `main.tsx` / `App.tsx` / `start-app.sh`：原生本地预览专用 VITE_CHORDV_LOCAL_PREVIEW=1 标记，解决 start-app.sh 的生产式前端构建原本排除 DEV 入口的问题。正式发布不设置该标记，不包含调试窗口。
- `styles.css`：多下载任务纵向排列，限制总高度，保留窄屏与计量提示避让。
- `test/unified-download-panel.regression.ts`：校验阶段、旧进度移除及原生预览标记回归。

验证：desktop check / 常规 production build / start-app.sh 原生调试构建 / bash -n / git diff --check 通过；unified-download-panel、download-progress、runtime-assets-state、download-simulation、update-center、update-handoff 定向回归通过。常规生产 dist 不含本地调试标签；原生预览构建显式包含。

范围：统一应用自行管理的文件下载；Android APK 或外部原图交给系统浏览器的传输没有应用内进度，未冒充可控制的下载。未修改上传进度，未改变真正断点续传能力。未发布版本、未执行真实 Windows 安装、未触发真实更新包安装。原生预览通过 start-app.sh 启动供用户自行验收。
