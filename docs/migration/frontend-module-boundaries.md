# 客户端前端模块边界

`apps/desktop/src/api/client.ts` 和 `apps/desktop/src/lib/runtime.ts` 已拆分为职责模块。原路径保留明确的兼容重导出，现有调用方不需要迁移；每个操作只有一份实现，没有保留第二套 HTTP、SSE 或原生能力客户端。

## HTTP 与事件入口

| 文件 | 职责 | 行数 |
| --- | --- | ---: |
| `api/client.ts` | 旧路径的值和类型重导出 | 7 |
| `api/http.ts` | API 来源、HTTP 请求、请求头规范化、错误类和状态判定、完整请求超时 | 217 |
| `api/account.ts` | 登录、刷新、登出、bootstrap、订阅、公告和工单端点 | 120 |
| `api/connection.ts` | 节点、探测上报、会话连接/断开/续租、配置和分流规则端点 | 120 |
| `api/client-events.ts` | 单一 SSE 订阅生命周期，包含原生/浏览器传输、退避、取消、重放和重同步 | 375 |
| `api/sse.ts` | SSE 帧切分、字段解析、业务事件解析和重放游标校验 | 65 |
| `api/native-commands.ts` | 原生诊断日志和在线状态补报命令 | 35 |
| `lib/githubReleaseTypes.ts` | GitHub 更新渠道、交付方式、安装包和检查结果类型 | 42 |

已修复两项实际协议和取消问题：

- Go SSE 游标使用 `UUID:sequence`，校验器现在接受标准 UUID 加 uint64 序列，包含 0；兼容旧 `数字-数字` 格式，拒绝非法实例、前导零、uint64 溢出和换行注入。原生与浏览器共享校验，非法事件 ID 不覆盖最近的有效游标。
- 浏览器 HTTP 的同一超时覆盖 `fetch` 和完整 `response.text()`，包括非 2xx 正文。外部取消信号通过独立监听合并，既不替代内部截止时间，也不反向取消调用方信号；成功、失败或取消后统一清理计时器和监听。

## MyGo 本地能力入口

| 文件 | 职责 | 行数 |
| --- | --- | ---: |
| `lib/runtime.ts` | 旧路径的值、类型及旧 Desktop 名称重导出 | 14 |
| `lib/nativeRuntime.ts` | 节点探测、冲突检查、连接/断开、状态、快照、日志及运行状态事件 | 216 |
| `lib/nativeShell.ts` | 启动就绪、窗口显示/隐藏/聚焦/退出、托盘和系统标签 | 130 |
| `lib/nativeSupport.ts` | 工单窗口复用、占位、票据打开/关闭、未读和窗口事件 | 180 |
| `lib/nativeInstaller.ts` | 安装包下载、进度、安装退出和待安装结果报告 | 169 |
| `lib/nativeComponents.ts` | 组件就绪/下载/取消、本地文件、架构、测速和发布清单授权 | 197 |
| `lib/nativeSession.ts` | 本地会话读写/刷新/清理及原生会话事件 | 79 |
| `lib/nativeEnvironment.ts` | 共用桌面和移动环境检测 | 9 |
| `lib/nativeDownloadProgress.ts` | 共用下载进度字段读取 | 32 |

`nativeBridge.ts` 仍是唯一 MyGo 命令和事件桥接。旧 Desktop 函数别名直接重导出同一函数，不新增包装层；进度字段兼容与移动环境分支保持拆分前行为，本次没有宣称移动端已完成迁移。

## 契约与回归验证

- `test/fixtures/frontend-export-contract.json` 固定拆分前的公开值/类型名称；`frontend-export-contract.regression.ts` 对照薄入口 AST 和真实模块导出，检查错误类构造器与旧别名身份，约束职责模块小于 400 行且不依赖兼容入口形成循环。
- `http-browser-timeout.regression.ts` 使用真实回环 HTTP 服务，覆盖成功状态正文停滞、503 正文停滞、正文期间外部取消、成功后的监听清理和 Headers 输入、预取消不发请求，共 5 项。
- `client-event-cursor.regression.ts` 覆盖合法/非法游标和实际原生订阅适配器重连，验证有效游标保留、非法 ID 不覆盖、重连计时器唯一且停止后移除监听，共 2 项。
- 源码提取测试改为读取实际职责文件，不在兼容入口复制实现。在线补报和工单权限断言改为读取当前 Go 实现；通知测试保留四种语义色调与真实通知 store 断言，只移除对已退役自定义镜像提示的依赖。

本轮本地验证结果：

- `TSX_TSCONFIG_PATH=apps/desktop/tsconfig.json node --import tsx --test apps/desktop/test/*.regression.ts`：66/66 通过，无跳过。
- `pnpm --filter @chordv/desktop check` 与 `pnpm --filter @chordv/desktop build`：通过；Vite 构建阶段 2.82 秒，仍保留大于 500 kB 的 chunk 警告。
- `node --test scripts/mygo-desktop-public-key.test.mjs`：2/2 通过；`git diff --check` 通过；本次拆分的生产模块未检出 `console.log`、`debugger`、`TODO`、`mock`、`fake` 或 `demo` 残留。

本次不修改布局组件或 CSS；原生窗口截图、Go 原生测试及前后端 GUI 联调由主流程统一验收。不以单独前端构建结果代表安装包或跨平台验收完成，也不以本子任务通过代表整体重构完成。
