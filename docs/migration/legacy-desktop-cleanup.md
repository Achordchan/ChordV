# 旧桌面入口精确清理

## 保留与删除边界

本轮按 `git ls-files` 白名单逐文件执行 unlink。每个文件删除前分别确认无暂存和未暂存修改，不执行递归目录删除、Git clean、Git rm 或索引更新；其他代理和用户已有修改不覆盖。

共删除 78 个原本未修改的 tracked 文件：旧 `src-tauri` Rust/构建配置/图标/Android 库 55 个，旧 Tauri 与 Android 构建及产物验收脚本 12 个，旧 Rust/NSIS 验收文件 8 个，旧运行自检、旧 shell 驱动测试和无活跃调用的 `turbo.json` 3 个。当前 `apps/desktop/scripts/platform-version.mjs` 仍被活跃入口使用，保留。

先把嵌套 ignore 的保护提升到根 `.gitignore`，再删除旧 `.gitignore`。`src-tauri/bin`、`target`、`target-*`、`gen` 不递归清理；包括 tracked 的 Android bin 占位文件也保留。忽略资产清单在清理前后均为 18494 项，路径清单 SHA256 均为：

```text
a7fc39365fa3681a7f6ada7749c1789621e02472810062cb60689571d38fcd5b
```

清单校验只能证明文件路径库存未变化；本轮代码不对这些目录里的文件做写入或删除。Xray / GEO 原件继续只读用作真实本机集成夹具。独立 native 图标和登录页图标不依赖已删除的旧图标。

## Windows 更新与旧版夹具

`windows-full-update-path.regression.ts` 已不读取 Rust、旧 NSIS hook 或 Tauri 配置，而验证当前 Go 安装器的授权 receipt / SHA256 / 长度 / 真实路径复核与清理交接顺序，并实际执行 7 项已有 Go 签名、原生授权、防回滚和本地 HTTP 下载行为测试。损坏安装报告须保留证据，不得先删除再解析。

历史 1.1.7 固定发布地址及 SHA256、原样 Unicode shell-link 辅助代码保留在 `tests/e2e/fixtures/windows-legacy`。未下载或生成任何旧安装包。原有旧 updater 参数、维护命令和 Rust 启动门禁不再充当 MyGo 合同；真实 Windows 新装、旧版升级和快捷方式迁移仍需 Windows 实机验收。

旧 `start-app.test.mjs` 的 Tauri/cargo 假驱动已移除；现有 MyGo 入口测试增加了当前 `start-app.sh` 从不同工作目录、含空格路径传递参数的真实 shell 委托检查，测试中不启动 UI。

## 扫描与验证

活跃桌面源码、脚本、测试和工作流不再读取旧 Rust/Tauri 配置或执行 cargo/rustc。剩余文本只涉及资产保护规则、只读 Xray 夹具说明、阻止旧栈回流的测试断言、旧错误文本兼容性及历史文档；不能为了消除关键词删除这些兼容性断言或用户资产。

Windows 更新专项、Windows 协议、窗口表现、更新交接回归，以及 desktop TypeScript 检查和前端构建均通过。主流程 presence 修复收敛后，带真实 Xray 夹具的完整 `go test -race -count=1 ./...`、`go vet ./...`、Windows amd64 的 `go vet ./...` 亦通过。构建仍有既存单个 JS chunk 超过 500 kB 的提示，本轮未修改前端生产代码或分包策略，也不把宿主 macOS 测试当成 Windows 安装实机验收。
