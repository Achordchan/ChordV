# Windows 1.1.7 更新入口故障调查

## 2026-09-16 核查结果

生产后台运行 0.0.20。通过既有 SSH 入口只读核查数据库：Windows 1.1.8 为 draft，updatedAt 为 2026-09-16T09:05:37.747Z；macOS 1.1.8 为 published。未修改发布状态或生产数据。

Windows 草稿的 EXE 为 21,154,980 字节，数据库 SHA256 为 `8e581077fd126cf6b5ee2f1e27b5f0b1859e9b4dce8e423f779d94d868c2fa83`，与上一轮发布记录一致。草稿文件下载接口返回 404。新旧域名的 Windows 1.1.7/zip 更新检查均返回 hasUpdate=false、downloadUrl=null；这是本次查询时的状态，不能据此推断用户之前点击时的状态。

GitHub v1.1.8 中的 `ChordV_1.1.8_x64-setup.exe` 直链重定向后返回 200，Content-Length 为 21,154,980，可供旧用户手动覆盖安装。GitHub 发布与后台发布是两套状态。

## 已安装旧版本的能力边界

核查 v1.1.7 对应提交 `8ca086868821a1ac2c081aa6dd520de134f4bf9a`：

- `normalizeUpdateCheckResult` 在 Windows 存在更新时明确拒绝 desktop_installer_download。保留 EXE 下载和安装函数不等于客户端允许这条流程。
- external_download 可以通过解析，但 `openExternalLink` 只模拟网页 anchor.click，并无条件返回成功，没有调用现成的原生 open_external_url。
- 所以不能通过后台把 EXE 标为 installer 模式来修复已安装的 1.1.7；不能把 EXE 伪装成 ZIP，也不能声称新版代码能修复旧二进制。
- 当前恢复方式是使用浏览器直接下载 EXE、退出旧客户端、覆盖安装。此前 Windows CI 验证了真实旧版安装目录升级；未验证从 1.1.7 的更新按钮出发的完整用户流程。

## 本次代码修复

删除重复 openExternalLink，更新入口统一调用 openExternalUrl。原生浏览器命令等待系统调用退出状态，复用最长 5 秒的受限命令执行器；Windows 将 PowerShell 错误转为失败退出。失败提示只发送一次，不再宣布成功。浏览器预览打开空白页后先解除 opener，再跳转目标，避免 noopener 导致成功打开仍返回 null 的误判。

新增执行真实适配器/更新回调的回归测试，并保留旧版本实际解析函数作为只读测试 fixture，证明 EXE 模式在旧版中被拒绝。fixture 不参与客户端生产构建。

## 本次验证与边界

客户端类型检查、外链回归、更新交接回归、主线程回归、Windows 更新协议回归通过；macOS Rust 原生测试 53 项通过。新的回归命令已加入 Windows/macOS 原生 CI 工作流，但本轮尚未推送或运行远程 CI。

未执行 Windows 真机点击、默认浏览器故障、安装覆盖全流程；本机为 macOS。未做截图/视觉验收，没有修改布局、CSS 或工单系统。未发布本次修改，已发布的客户端不包含此次修复。旧用户手动升级后仍需在 Windows 确认实际启动版本。
