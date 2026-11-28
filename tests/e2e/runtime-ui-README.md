# 独立真实连接GUI准备

仅测试入口；默认导入和 `node --test tests/e2e/runtime-ui-isolation.test.mjs` 不启动 PostgreSQL、API、Agent、Xray或GUI。计划/边界测试不等于实际双节点或GUI验收。

```sh
# 两步使用同一份 macOS 组件。没有本地副本时，在允许联网时运行：
mkdir -p .tmp
node scripts/mygo-mac-runtime-fixtures.mjs "$PWD/.tmp/runtime-ui-mac-qa"
export CHORDV_TEST_XRAY_DIR="$(cd "$PWD/.tmp/runtime-ui-mac-qa" && pwd -P)"

# 保持该变量直至 --start 完成；也可直接指定已准备好组件的规范绝对目录。
# 只创建全新临时root、独立密钥、代理JSON与真实资产字节副本。
node tests/e2e/runtime-ui-isolation.mjs --prepare

# 主流程复核并显式批准后才启动，不接受使用过的root。
node tests/e2e/runtime-ui-isolation.mjs --start /absolute/new/root/runtime-ui-plan.json
```

prepare复用support-isolation的全新 `chordv-support-e2e-*` root。旧PG目录、credentials/runtime、启动marker或旧桌面会话均拒绝复活；首次启动以排他marker占用计划。禁止主3100/55437/5173/5174及当前36715/36763/36795/12027端口，开始前还必须显式探测生产固定本地HTTP17890/SOCKS17891；占用即拒绝，不杀进程、不换口。

启动仅用独立PG/API和两个实际Xray/Reality本机节点：Reality TLS目标、入站、gRPC及echo均回环。通过真实管理API创建节点、生产Agent注册和入站验证、主用户订阅授权A/B；只读SQL审计最新ENSURE_USER completed，随后核对两边真实Xray当前UUID/账号和客户端双节点列表。没有SQL造绑定、伪造命令回执或停止Agent来制造就绪；两个Agent与节点保持运行，支持后续GUI切换/计量。Go构建限定缓存离线使用，不访问外网。

Go工具链先读取Agent go.mod版本要求，再从本机缓存/PATH选择已存在且 `go version` 实际可执行的同平台工具链，直接调用其canonical bin；优先同minor最新patch，不通过旧Go自动切换。强制 `GOTOOLCHAIN=local`、`GOPROXY=off`、`GOSUMDB=off`、`GOENV=off`、`GOWORK=off`、`GOTELEMETRY=off`，没有兼容工具链就报错。默认测试含真实离线小模块构建/运行，产物位于全新临时目录并在结束时删除，不启动服务。

桌面组件只从显式的 `CHORDV_TEST_XRAY_DIR` 只读读取，不再查找旧工程目录。目录内须有当前架构的 `xray-aarch64-apple-darwin` 或 `xray-x86_64-apple-darwin`，以及 `geoip.dat`、`geosite.dat`。这些文件会复制到新root的 `.data/mygo/desktop/bin`：Xray副本0500，GEO/JSON0400，不硬链接或修改原文件。installedComponent仅写真实kind、SHA256、size及“手动预置真实资产fixture”标签，**不是GitHub正常下载安装证据**；不写ready/verified，原生运行层自行校验。发布仓库保持为空，沿用已有可用组件逻辑。

GUI必须由主流程另行启动**已核实带 `e2e` 标签的Darwin本地构建**；只给普通App设置环境变量不构成文件代理隔离。本helper从不启动或停止GUI，原App359和主服务保持不动。新的自建GUI实例只能有一个，使用ready输出的完整desktopEnvironment：

- `CHORDV_API_BASE_URL`：本次独立127.0.0.1 API。
- `CHORDV_MYGO_DATA_DIR`：本次canonical桌面目录。
- `CHORDV_E2E_PROXY_STATE`：同目录已有0600、非symlink、当前用户独占的qa-proxy-state.json。

文件代理初始JSON严格为schema1/testOnly、单条 `e2e-runtime-proxy/windows` 与五个基础字符串字段。连接时只允许e2e原生适配器修改该JSON；不改宿主代理，不把文件恢复冒称真实宿主代理恢复。helper不启动GUI，GUI崩溃与watchdog需由主流程另行实际验证。

e2e Darwin原生层现在复用生产launcher启动真实独立watchdog，不再使用同进程pipe stand-in。子进程只继承显式文件profile/API/数据目录，不继承automation；缺字段、目录不一致立即停止，不回退宿主代理。是否通过GUI父进程强杀验收，必须另看本轮真实GUI证据；helper就绪和子进程单测不代表该项自动通过。

原support计划保留的provider端口在本组合中不启动provider，作为本次独立后台来源使用。prepare/ready的`adminEnvironment`提供`CHORDV_DEV_API_TARGET`与`CHORDV_ADMIN_PORT`；API允许该来源，但helper仍不启动Vite或浏览器。后台须由主流程使用这两个显式变量单独启动，严禁借用主5174或修改主frontend-env。

脱敏报告字段 `guiStartedByHelper:false`、`hostProxyOperationsByHelper:false` 只描述helper本身；`testProxyJSONRestored` 只核对测试JSON是否精确恢复初始值，不证明宿主代理恢复或GUI通过。清理异常写 `cleaned:false` / `cleanupFailureCount`，不冒报完成；API客户端拒绝重定向，避免跳往主环境或外网。

正常鼠标完成连接、A/B切换、断开及流量证据后，先正常退出这个自建GUI，再给helper supervisor发SIGINT。仅停止自己持有的Agent/节点/API/PG并删除本次root；脱敏报告在 `output/local/runtime-ui-e2e-report.json`，不保存账号密码/运行UUID，不把API准备完成冒充GUI已验。
