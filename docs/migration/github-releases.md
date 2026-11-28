# GitHub 发布与更新协议

本轮仅修改本地代码，不创建 GitHub Release、不推送分支、不部署、不请求线上业务接口。

## 唯一发布源

- 发布仓库由 `VITE_GITHUB_RELEASE_REPOSITORY=owner/public-repository` 指定，默认不配置；客户端不携带 GitHub Token。私有源码仓库与公开二进制仓库可以分开。
- 桌面更新和管理后台版本链接复用前端的同一仓库名规则，保留合法带点仓库名，拒绝 `owner/.`、`owner/..` 等非仓库路径。无有效仓库配置时后台仅显示本地调试，不生成链接。第 178 轮在 Chrome 用 390 像素窗口核对合法、无效、空配置三种情况，没有点击外部链接；截图见 `output/playwright/round178-release-link/`。
- 桌面正式构建的 `CHORDV_API_BASE_URL` 仓库变量只填 HTTPS 服务来源（协议、主机、可选端口），不要带 `/api`、查询参数、片段或凭据。手动工作流的准备阶段和构建入口使用同一校验，错误配置在进入原生验证和签名任务前停止。
- 正式客户端运行时只使用安装包内置的 API 地址；进程环境变量不覆盖正式地址。macOS 更新或回滚启动时也不向新进程传旧包的地址，各版本读取自己的内置配置。本地调试仍可指定回环 API。
- 每个版本使用固定标签 `v<严格 SemVer>`，不覆盖已有 Release 或资产；稳定版不含预发布标识，测试版使用 `-beta.N` 等预发布版本。
- Release 附带 `chordv-release.json` 和 `chordv-release.json.sig`；同仓库 `release-channels` 分支的 `stable.json` / `beta.json` 及 `.sig` 是其原字节副本，仅用于发现渠道版本，不是独立发布源。发布工作流先完成 Release，再更新渠道指针。
- 正式构建必须配置 `VITE_GITHUB_RELEASE_PUBLIC_KEY`，值为 Ed25519 PKIX PEM 公钥、PKIX DER 公钥的 Base64 或原始 32 字节公钥的 Base64；私钥仅放 GitHub Actions Secret `CHORDV_RELEASE_SIGNING_KEY`，不写入安装包。
- `.sig` 为对 JSON **原始 UTF-8 字节**执行标准 Ed25519 分离签名所得 64 字节签名的 Base64；兼容已有后台清单签名算法。不可重新序列化后验签。

桌面手动发版先运行与合并检查相同的只读验证：桌面界面回归、Linux 隔离代理测试，以及 macOS 和 Windows 原生测试与试打包。macOS 使用独立的 ARM 与 Intel 原生运行器，分别验证对应架构的 MyGo 安装包、首屏就绪和发布签名异常处理；两者还会按锁文件核验本架构 Xray 和 GEO 规则，在回环网络测试 HTTP、SOCKS 和异常退出恢复。架构不符、运行在 Rosetta 下、必需用例跳过或缺失，均不能通过云端门槛。运行器标签见 [GitHub 官方镜像清单](https://github.com/actions/runner-images#available-images)。全部通过才进入四个正式构建目标，签名凭据不传入验证工作流。 macOS 的界面更新专项直接使用刚构建的原始本地 DMG，不重打镜像。验证工作流同时提供同目录的应用和唯一 DMG；本机运行专项需显式设置 `CHORDV_TEST_FULL_GUI_APP` 和 `CHORDV_TEST_FULL_GUI_DMG`。缺少镜像会失败，暂存的安装程序签名摘要和构建身份也必须与同轮应用一致。Build 166 两架构各四种场景在本机通过（x64 经 Rosetta）；这不是云端工作流运行或正式签名证据。普通分支验证和发版验证分组独立，前者不会取消后者。

Windows x64 只读检查从本次试打包的 NSIS 中取出固定名称的客户端，核对 PE 架构、Go 构建身份和完整字节，再运行包内程序的 `--chordv-build-info`，对照预期版本和构建号。该步骤不运行安装器，不改注册表或系统代理，不代替专用测试机上的安装、旧版升级和卸载验收。

服务端手动发版在签名前下载同次构建的 Linux x64、arm64 归档及描述文件。验收按正式工作流的 schema 2 生成临时签名清单，核对目标仓库绑定；再用独立 PostgreSQL 对每份归档分别执行 Agent 接入和下载测试。每份归档都要通过安装脚本语法检查，且通过 HTTP 返回的两种架构 Agent 字节必须与该归档自身一致。报告按服务端架构记录受测文件名和 SHA-256，不用一份归档的通过结果代替另一份。验证阶段只用临时密钥，不上传验证产生的清单；签名任务重新下载构建产物并比对四个文件的摘要，字节不一致就停止，不以重新打包代替。

## 当前发布清单（schema 2）

桌面与服务端的正式工作流均选择 `signed-manifest-tree`：`sourceCommit` 是构建程序的源码提交；公开产物仓库的标签则指向独立的发布提交，不要求公开私有源码。该提交没有父提交，文件树只包含清单原文和对应签名。`tagBinding.repository` 必须与配置的公开仓库一致，不能把同一套字节挪到另一仓库继续使用。schema 1 是旧兼容格式，不是当前工作流的输出。恢复已有发布时使用[原包恢复流程](github-release-recovery.md)，不要按示例重新生成签名。

```json
{
  "schemaVersion": 2,
  "tagBinding": { "mode": "signed-manifest-tree", "repository": "example/chordv-releases" },
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "version": "2.0.0-beta.1",
  "tag": "v2.0.0-beta.1",
  "channel": "beta",
  "build": 1,
  "minimumVersion": "1.1.0",
  "forceUpgrade": false,
  "title": "ChordV 2.0.0 测试版",
  "changelog": ["迁移桌面运行层"],
  "publishedAt": "2026-11-16T00:00:00Z",
  "installers": [
    {
      "platform": "macos",
      "architecture": "arm64",
      "fileName": "ChordV_2.0.0-beta.1_macos_arm64.dmg",
      "sha256": "64位小写十六进制SHA256，构建时计算",
      "sizeBytes": 123456
    }
  ],
  "runtimeComponents": [
    {
      "component": "xray",
      "platform": "macos",
      "architecture": "arm64",
      "version": "上游实际版本",
      "fileName": "Xray-macos-arm64-v8a.zip",
      "sha256": "下载归档的SHA256，构建时计算",
      "sizeBytes": 123456,
      "sourceFormat": "zip_entry",
      "archiveEntryName": "xray"
    }
  ]
}
```

示例仅节选桌面清单字段，省略其他目标和安装包构建身份，不是可发布清单。发布工具必须根据真实资产生成 SHA256 和长度，拒绝上述说明字符串。

- `platform` 为 `macos` / `windows` / `linux` / `android`，`architecture` 为 `x64` / `arm64`。
- 同一 `platform+architecture` 最多一个安装包；同一 `component+platform+architecture` 最多一个运行组件。
- `component` 为 `xray` / `geoip` / `geosite`；`sourceFormat` 为 `direct` / `zip_entry`，压缩包必须指定单个安全相对路径 `archiveEntryName`。
- `sha256` 与 `sizeBytes` 始终描述下载文件本身；ZIP 必须先校验整个归档，再限量提取指定条目。已安装文件身份另行存储，不用归档 Hash 判断裸文件内容。
- URL 不在清单中自由指定：根据配置仓库、已校验 `tag` 和安全 `fileName` 拼接 `https://github.com/{repo}/releases/download/{tag}/{fileName}`，防止把更新指向其他站点。
- 稳定渠道只接收 `channel=stable`；测试渠道先读 `beta`，不存在时才使用稳定渠道，不以缓存伪造“已是最新”。当前版本或构建号更高时不降级；测试版不强制安装，也不以其最低版本阻断连接。

## 国内传输与完整性

- 本轮仅支持内置受控镜像 `https://ghfast.top/` 与 GitHub 直连；前端和 Go 原生使用同一白名单。镜像只转发 GitHub 原始地址，不提供版本决策，不再提供任意前缀或自定义镜像配置。
- 有固定公钥时允许清单与资产经镜像传输：清单先验签，安装包/组件再校验 SHA256、长度；清单版本、渠道、固定标签必须一致。
- 无公钥的本地构建只允许 GitHub HTTPS 直连，禁用镜像；未配置发布仓库时明确显示未配置，不连接当前线上站点。
- 下载候选失败自动换源，最后保留 GitHub 直连；每次请求有连接/停滞超时，下载无整包 180 秒上限；原生层负责 Range 续传、取消、原子替换和安装前再次校验。
- GitHub 更新检查按操作触发并短时合并缓存，不新增定时轮询。

## 服务端只读兼容

Go 服务端保留旧客户端 `POST /api/client/update/check`、`GET /api/client/version`、`GET /api/client/releases/history`、`GET /api/client/runtime-components/plan` 的响应结构；读取同一 GitHub 清单并投影，不保存或编辑 Release 数据库记录。旧的发布中心上传、审批、发布、激活组件 API 不进入新服务端。 旧客户端历史接口的 `limit` 按通过清单验证且匹配平台的桌面版本计数，不把同仓库的服务端版本计入。接口只按 GitHub 的下一页标记向配置仓库翻页；单次最多 5 页、50 份清单、30 秒，超过预算返回错误，不以空列表冒充查完。

旧版 Tauri 1.1.x 的升级不能直接信任新签名：过渡安装包仍需旧 Tauri 更新公钥对应签名，或由用户手动安装平台签名过的 MyGo 安装包。过渡版发布和线上兼容接口上线必须由用户另行授权，本地阶段不操作。

## 正式发布前门槛

- macOS Developer ID 签名、公证、装订以及 Intel/Apple Silicon 真机验证；本地临时签名不等于可公开分发。
- macOS 待发布 DMG 只读挂载后，包内应用必须与同轮构建输出的可执行文件字节和代码签名摘要一致。两个应用都必须通过严格签名完整性校验；仅版本、构建号相同不足以通过。Build 169 的两份本地原包已实测，换成同构建号但资源不同的独立临时签名应用会被拒绝。证据：`.tmp/ui-qa/round172-mac-staging-8mq8nr/`。正式 Developer ID、公证及装订门槛不变。
- 桌面安装器先复制到暂存目录，再对该副本验签和计算 SHA-256；输出与被核验的是同一文件，不在验签之后重新从构建目录取文件。暂存失败会清理私有目录；已有同名产物或描述不覆盖，需在干净的输出目录重试。第 173 轮用两个原始本地 DMG 和无效镜像验证拒绝后无临时文件或新增描述。安装器和描述并非一个文件系统事务；异常中断后不要把残留当成可发布版本。
- 第 174 轮另在隔离目录制作了两份具有正式包布局和构建身份、但仅临时签名的 macOS 测试镜像。两份都通过包内身份与内容核对，随后被真实 `stageDesktop` 在 Developer ID 门槛明确拒绝，没有写入发布目录，也没有残留暂存副本。没有启动测试程序或使用证书私钥。证据：`.tmp/ui-qa/round174-formal-gate-KcE8YR/verified.json`。这些是拒绝用例，不是可安装交付包，不计作正式签名验证通过。
- Windows Authenticode 签名、安装目录/快捷方式/进程清理、旧 Tauri 到 MyGo 更新实测。
- Windows x64 新旧包验收的最新本地输入为 `output/local-candidates/chordv-1.1.12-build220-windows-upgrade-qa/`：旧 Tauri Build 27 已验固定公钥签名，新 QA 包已解包验证构建身份，尚未执行 Windows 安装。复建用 `CHORDV_BUILD_NUMBER=220 node scripts/mygo-desktop.mjs --windows-installer-qa --build-only --platform windows --arch x64`。该入口复用正式安装目录、注册表标识与 NSIS 升级钩子，但只构建本地、未签名的 `chordv-installer-qa`，不继承发布配置，不可作为正式资产；同构建号的输出目录不会覆盖。安装与卸载均在正常迁移逻辑前检查当前账户目录中的 QA 标记文件；这只防误点，专用 Windows 验收脚本仍必须校验 SID、短期租约和空安装环境。不要在日常账户打开该包。
- 固定清单公钥、保护 Actions 私钥、公开资产仓库 Token 仅有发布权限；不能向镜像发送任何 Token。
- 版本清单必须包含实际发布的全部平台安装包及 Xray/GEO 组件，缺失平台不提供不匹配安装包。
- CI 只构建并上传 GitHub，不 SSH、不调用业务服务器、不触发后台自更新；本地没有实际执行发布。

### macOS 恢复回归是桌面发布的必过门槛（第 219 轮）

桌面正式构建仍依赖无发布凭据的 `verify-desktop-native.yml`，在 Apple Silicon 和 Intel 两个 macOS 任务分别验收。原生包此前走 Go 默认 10 分钟超时，而 Build 214 的本机全仓日志记录该原生包用时 710.397 秒（未开 race）。本轮为 macOS 原生包显式给 30 分钟、为矩阵任务给 60 分钟；不跳过原生全量测试，不改 Windows 测试命令，也不放宽原有安装镜像测试。

两个 macOS 任务先执行签名字段和门槛测试，要求 TAP 汇总中没有跳过项。原生包 `go test -race -count=1 -timeout=30m -json` 随后核对 14 条明确的恢复用例，覆盖授权不可用及变化、精确进程退出、丢回执保留、原版收尾和启动报告。期望用例必须发生在正确的原生包、实际运行并通过，且包自己只有一次成功结束结果；运行外部资产用例之前的其他可选用例仍可按原规则跳过。

| 文件 | 改动 |
| --- | --- |
| `.github/workflows/verify-desktop-native.yml` | 增加两个 macOS 验证要求和明确超时，仍在正式签名和发布之前。 |
| `scripts/mygo-verify-mac-recovery-log.mjs` | 校验实际 `go test -json` 日志，拒绝必测用例缺失、跳过、失败、重复结果或包未成功。 |
| `scripts/mygo-verify-mac-recovery-log.test.mjs` | 覆盖成功、漏跑、跳过、重复、截断和错误包等门槛条件。 |

本地直接执行从实际工作流提取的 Node 步骤，11 项通过、零跳过。另外从当前 native 源码的隔离覆盖快照在 ARM64 实际执行相关 Go 用例，`go test -race -count=1 -timeout=30m -json -run …` 共 23 条通过，验证脚本从中确认全部 14 项必测用例；对上一轮虽整体通过、但只测安装报告的真实日志，校验脚本返回非零。`actionlint`、Bash 语法检查和 `git diff --check` 通过。224 个前端源码和 Build 214 的 62 份文件均未改；没有生产 Mock。证据在 `.tmp/ui-qa/round219-release-recovery-gate-DjdTI3/`。本轮未重新打包、重跑全仓、在 Intel runner 上执行或触发任何 GitHub 工作流；正式签名、公证和实机恢复验证仍不以此代替。没有修改本机代理、推送、部署或发布。

## 服务端资产

服务端独立使用 `server-v<服务端版本>` 标签、`chordv-server-release.json` 及 `.sig`，同分支渠道文件为 `server-stable.json` / `server-beta.json`。共用 schemaVersion/version/channel/build/minimumVersion/forceUpgrade/title/changelog/publishedAt 字段，与桌面清单一样记录真实源码 `sourceCommit`；资产字段为 `servers`，包含 linux x64/arm64 的 Go 二进制+后台静态资源 tar.gz。每项包含 platform/architecture/fileName/sha256/sizeBytes，以及实测 `buildInfo` 的 version/commit/builtAt/platform/architecture。不写旧 `backend-manifest` 分支，不触发旧线上自更新。

- 默认 `node scripts/mygo-build-backend.mjs` 仍生成本地隔离产物和 `LOCAL-ONLY.txt`。只有显式 `--release` 才生成 `DEPLOYMENT.txt` 与 `build-info.json`；这只构建文件，不启动服务、不部署、不迁移数据库。生产启动还必须显式配置 `CHORDV_MODE=production` 及独立的服务地址、数据库、密钥、数据目录、HTTPS 反向代理等参数。
- `release-backend.yml` 使用 `--release`；归档顶层包含 `chordv-server`、`admin/`、`agent-dist/`、`DEPLOYMENT.txt`、`SERVER-CONFIG.md` 和 `build-info.json`。`agent-dist/` 包含 linux amd64、arm64 两个 Agent 及其 `manifest.json`；更换或回滚时应使用完整归档。staging 拒绝仍带 `LOCAL-ONLY.txt` 的目录、缺失说明、链接或特殊文件；校验失败清理临时归档，不写可发布描述文件。
- 服务端和桌面使用同一套只创建、不覆盖的暂存写入。服务端每次先在独立临时目录打包，重新解包验证，再从同一份归档生成描述和摘要。同名归档或描述已存在就拒绝，普通描述写入冲突只回收本轮新增归档；不能把两次重建混在同一暂存目录。需要重建时使用新的 `RELEASE_ASSET_DIR`，不要覆盖已验收产物。
- 第 189 轮用 Build 186 实际双架构构建输出并发暂存：每个架构只交付一份匹配的归档与描述，后续重跑拒绝覆盖。重新暂存的两份产物仍通过断网容器启动、业务和旧入口退役，以及本地发布中断恢复；发布脚本整套 119 项通过、零跳过。证据见 `.tmp/ui-qa/round189-immutable-stage-0GU2sq/`，未执行真实 GitHub 发布。
- 版本不能只写 sidecar 或清单：staging 和签名前都从实际 Go 二进制读取包身份、GOOS/GOARCH/CGO 设置及 `-X` 嵌入的 Version/Commit/BuiltAt，与 `build-info.json` 和当前源码提交逐项比较。同平台/架构额外执行真正的 `--version`；该路径在任何配置或数据库读取前退出。跨架构不执行外平台二进制，也不把未执行写成通过。
- 默认本地构建保留 `-trimpath`；正式构建有意不加该选项，因为 Go 在启用它时会省略 `go version -m` 中的 `-ldflags`，导致无法独立核对嵌入版本。正式构建仍保留 `-s -w`，不拿手填元数据替代实际二进制证明。
- 发布前重新解包核对全部归档，要求两种架构版本、源码提交与签名清单一致；描述文件无法覆盖归档内的真实版本。完整 JSON 经固定 Ed25519 发布私钥签名，包含每项 SHA256、长度和构建身份。GitHub 上传归档不等于授权部署，本轮未创建 Release 或运行发布工作流。

## 已验证与待完成边界

已在本地执行真实 Go 编译的双架构测试归档、同平台 `--version`、归档与清单一致性、标准 Ed25519 签名/验签及离线 GitHub 请求夹具测试；假版本/提交/构建时间、错误架构、LOCAL-ONLY 包、危险归档条目、缺失平台、上传 Hash 不符、已有 Release 覆盖和渠道回滚均被拒绝。另用同一生产校验器验证了当前真实 macOS arm64 服务端构建：版本 `0.0.34`、源码提交 `397a64de9cc345049f886e64cc19f46d887f8304`、构建时间 `2026-11-16T15:36:15.421Z`，实际嵌入值、sidecar 与原生 `--version` 一致，全程不启动数据库。四份发布/验证 Actions 已用缓存中的 actionlint 静态核验；这不是远端 Actions 执行证据，也不代替真实平台安装。

尚待真实发布前完成：配置受保护的私钥/公开仓库/最小权限 Token，执行 macOS Developer ID 签名及公证、Windows Authenticode 签名与安装升级，验证真实 GitHub 资产完整上传和渠道指针，再验收旧 1.1.x 至 MyGo 的过渡安装。现有旧 Tauri 公钥不能自动信任新的 Ed25519 清单；必须使用旧签名认可的过渡安装包，或明确由用户手动安装受平台签名的新版，不能因新清单验签通过就宣称旧版自动迁移已打通。

## 源组件锁定

`.github/runtime-components.lock.json` 固定本次验证过的上游 Release 标签、资产大小和 GitHub API 提供的 SHA256：Xray `v26.11.9`、GEO `202611152204`。工作流逐个下载并重新计算 Hash，验证后镜像到本项目同一 Release；不让运行时读取上游 latest，也不从未校验的压缩包直接安装。修改锁文件需重新核查真实上游资产，不自动追最新版。

内置 `https://ghfast.top/` 已于 2026-11-16 核查：代理读取 MyGo `v0.9.1/go.mod` 与 Go 官方模块缓存 SHA256 一致；这仅验证传输当日可用，不赋予镜像发布信任。后续不可用时自动尝试其他配置镜像及 GitHub 直连。

## 本地验证记录

已执行：

- `pnpm --filter @chordv/shared build`、`pnpm --filter @chordv/admin check`、`pnpm --filter @chordv/desktop check`。
- `pnpm --filter @chordv/admin build`、`pnpm --filter @chordv/desktop build`，均成功；保留现有大块资源警告，没有通过提高阈值掩盖。
- `TSX_TSCONFIG_PATH=apps/admin/tsconfig.json node --import tsx --test apps/admin/test/*.regression.ts`，33 项通过；包含 presence 共享单飞、事件合并、resync、隐藏页恢复、卸载代次隔离及幂等退订。presence 不使用业务轮询；SSE 传输重连计时器不等于周期拉取业务数据。
- GitHub 清单/Windows 投影测试覆盖真实 Ed25519、版本和构建号、架构、强制更新、测试版、Hash、路径、不可回滚、原生授权拒绝、缓存及有界重读；旧更新中心、外链打开、静默下载、分流和本地文件测试已适配 MyGo。
- `node --test .github/scripts/*.test.mjs`，19 项通过；包含真实 Go 二进制编译、跨架构嵌入版本核验、同架构原生版本输出、真实流式 Hash、真实 tar 归档、标准签名及离线 GitHub REST 协议验证。
- 在已存在的 `actionlint@v1.7.7` Go 模块缓存目录使用 `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local go run ./cmd/actionlint -shellcheck=`，对 `release-backend.yml`、`release-desktop.yml`、`release-verification.yml` 和 `verify-desktop-native.yml` 传入绝对路径，四份全部通过；未新增项目依赖、未联网获取工具、未启用 ShellCheck。
- `git diff --check` 通过。

未执行 GitHub 发布、渠道分支写入、Actions 云端构建、平台正式签名或线上过渡升级：这些需要用户配置发布仓库/凭据并明确授权，本轮仅本地调试。没有向 GitHub 上传任何产物，没有 SSH 或部署。

后台布局只删除发布相关导航、替换版本页脚、简化站点设置，未改全局 CSS；类型检查与构建通过，整体原生/浏览器视觉回归由主流程统一验收。

## 镜像配置收敛

旧 `chordv_runtime_component_mirror_prefix` 偏好只在客户端启动时移除，不再读取、写入或影响下载；下载详情里的“清除旧下载镜像”按钮及相关 props、hooks 参数已删除。此前试验性的自定义镜像环境变量也不再读取。安装包和组件均由同一个受控候选生成函数生成 ghfast/GitHub 地址，没有“前端允许、原生拒绝”的自定义前缀。

有固定发布公钥时，验签通过的渠道清单及已授权资产可以尝试 ghfast；失败时仍会尝试 GitHub 原始地址。无公钥的本地配置仅允许 GitHub 直连。版本错误、签名错误、下载失败均保留真实状态和重试入口，手动检查绕过短时缓存，实际下载进度继续由 MyGo 原生事件驱动。

`node --test scripts/mygo-desktop-public-key.test.mjs` 验证正式构建公钥支持 raw32 Base64、SPKI DER Base64、PEM 和转义换行 PEM；测试使用生成的临时 Ed25519 密钥，真实 CLI 在缺少签名证书处停止，未执行构建、公证、发布或网络请求。

## 2026-11-17 只读兼容与切源补验

- 服务端原先只接受 raw32 Base64 和 PEM，文档支持的 SPKI DER Base64 会让真实 `POST /api/client/update/check` 返回 500。现已统一为 raw32 或 PKIX Ed25519 公钥解析；新增测试使用临时密钥和两个本机 HTTP 服务，经生产路由验证三种格式下的更新检查、版本、历史和完整组件计划。清单原字节被追加空格后返回 502，错误算法/畸形 DER 被拒绝；Tauri 过渡入口保持 204，不以新清单签名伪造旧安装包签名。测试传输只将生产生成的 GitHub 官方 URL 映射到回环服务，不访问外网、不连接数据库。
- 原生低速错误原先只有中文，与前端识别的 `download too slow on this mirror` 不匹配，导致“全部源失败后只对低速源去门槛重试”无法触发。真实 HTTP 服务间隔 12.1 秒发送两个字节，已先复现协议断言失败；现在保留中文说明并附固定标记。原生测试验证实际错误，前端既有切源测试读取同一原生标记，验证尝试顺序、最后一个源不设低速门槛以及低速源最终去门槛重试。
- 新增两个独立回环 HTTP 源的跨源续传：第一源在 65536 字节处断流，第二源收到 `Range: bytes=65536-...`，最终文件通过完整 SHA256 和长度验证；污染第一源的同长度前缀后，拼接文件必须校验失败、旧文件保持原字节、污染 part 被删除，随后显式重试健康源才能成功。此测试没有声称污染后第一次切源就能自动恢复。

验证命令：

```sh
go -C apps/server test -race -count=1 -run '^Test(GitHub|ManifestRejects|SemverOrdering|Legacy(Update|Mac))' -v ./internal/api
go -C apps/desktop/native test -race -count=1 -run '^Test(NativeSlowDownload|VerifiedDownload|Download|ManifestSignatures|NativeDownloads|ManifestAuthorization|ReleaseTextScope)' -v .
TSX_TSCONFIG_PATH="$PWD/tsconfig.base.json" node --import tsx apps/desktop/test/download-mirror-ranking.regression.ts
```

上述结果只补强本地兼容接口、错误协议和传输完整性；不等于真实 ghfast/GitHub 链路可用、GitHub Release 已发布、旧 1.1.x 已完成安装升级或平台发行签名已完成。未新增线上请求、发布凭据、生产依赖或界面样式。

### 第16节：服务端归档闭合Agent一键接入

发布/本地构建同步生成Linux amd64和arm64真实Go Agent，manifest绑定版本/Commit/两架构SHA，manifestSHA编译进server。现有GitHub签名server归档含agent-dist和SERVER-CONFIG.md，验证器拒绝缺包/篡改/错误架构或元数据、链接与额外条目；运行中server固定自身exe的不可变release目录，不随current切换重解析，不从DataDir取包。部署和回滚应切整个完整归档，不能只换server；没有新增发布中心或备用供给源。

主流程最终源码重建两份Linux包，再用临时Ed25519密钥完成签名/原文篡改拒绝/实际归档SHA长度/私有schema正常HTTP节点→脚本→双架构下载及生产exe定位无注入分支；不是文本fixture或绕过安装入口。默认核心Go及发布脚本由pnpm test发现，额外归档opt-in已单独实际执行，报告agent-release-supply-e2e.json不含token/私钥。HEAD仅dirty本地构建元数据，不称远端提交已包含变更；未上传/发布/部署，也未实际运行Linux root/systemd安装，见第16节。


### 第18节：实际桌面安装包内容门禁

stage不再仅凭后缀/调用者版本把普通local DMG改名为正式资产。Go linker buildID与密封plist/实际Mach-O或PE/Go包/架构/source/build一致后才生成descriptor，签名manifest和publisher再次绑定。完整MyGo ad-hoc内容正控、local改名及正式plist但local二进制拒绝均实测；正式stage仍必须DeveloperID/notary或Windows有效Authenticode/同次源payload。Windows实机7z/签名成功路径和正式签名仍未验，没有发布或Keychain变更，详见本地验证第18节和round18-release-audit/completion.md。


### 第19节：实际旧更新库验证，自动过渡保持封锁

真实锁定Tauri updater2.11.0/minisign0.2.5+官方临时签名，对当前完整MyGo tar.app完成真实下载验签/篡改拒绝/临时目录替换，DMG虽签名通过却安装拒绝；旧Mac发布并未启该插件，因此不代表旧用户迁移。Windows旧/P /UPDATE /R /ARGS、安装根和注册表与MyGo不兼容；生产204/stage disabled/manifest与publisher非空legacy条目硬拒，verified:true和key不能解锁。没有恢复旧运行栈或发布中心，后续须Windows实际矩阵验收，证据见第19节和round19-legacy-transition/completion.md。


### 第20节：Windows安装兼容实际接入与内容包对照

正式Windows构建接入installerInclude受限钩子，已实际编译原默认MyGo和最终hook两份完整Windows/amd64 unsigned/local内容包；owned列表非递归卸载、旧/新注册表精确根、历史入口和/S受限参数流程已写入真实NSIS。旧默认/P仍明确拒绝，未静默降级；Windows动态、跨文件/注册表故障恢复、实际旧官方更新调用未验，生产legacy门禁继续封锁。两包SHA/8,254B差值及12专项、完整边界详见本地验证第20节和round20-windows-transition/completion.md，不以编译绿声称旧迁移完成。


### 第21节：原生passive构建链与实际双架构内容包

旧/P拒绝已替换为原生PRE跳目录/完成、保留progress、成功AutoClose；生产只给锁定MyGo0.9.1生成NSIS注入三行，严格源SHA/唯一结构/身份门禁，临时host launcher和Node wrapper透明传签名环境至真正makensis。编译器发现保留PATH及原ProgramFiles已装路径，不下载。真实默认及passive双架构完整包、12个实际生成源变异和19专项通过；Windows动态与旧官方迁移未验、非事务边界保留，生产legacy仍封锁，详见本地验证第21节及round21-windows-passive/completion.md。

## 第22轮补充

第22轮新增scripts/mygo-windows-acceptance{,.test}.mjs、scripts/windows/qa五文件与手动verify-windows-installer-runtime.yml。验真实旧公开.sig及当前canonical QA Go身份/payload，专属普通账户SID/profile/短期lease先拒不合格环境；代理快照变化/读取失败必须failed与非零，不自动写代理。官方PowerShell仅语法/C#与非Windows拒绝实测，Node25合同通过；真实安装、旧官方updater入口、Go内部ARGS/健康、进度视觉、并发与部分失败尚未验。已有第21轮包缺canonical QA build ID，明确不接受为运行输入；未构建替身、未触发workflow、未改变生产legacy204/disabled或发布门禁。

## 第23轮补充

第23轮真实canonical local/build23 x64 QA应用与完整NSIS、真实公开旧build27安装包和.sig已备齐；固定旧钥验签、当前Go/MyGo/PE/canonical身份与完整NSIS源payload逐字节校验通过，6个真资产负控正确拒绝。仅提取纯只读inspectAcceptanceContents，Windows CLI/账户/lease/发布门槛不变；增加实证旧manufacturer键Software\chordv\ChordV前置只读拒绝。实际tag9a17762与release.target397a64d不一致，相关Windows合同逐字相同和run27/head_sha397a64d证据分开保存。26项Node/真实PowerShell解析通过，输入zip就绪；实际Windows/旧updater选版、正式签名/legacy发行仍未验且disabled。QA build23不是正式高于旧build27的版本承诺。

## 第24轮：源码tag、渠道快照验签与最低版本

发布器新建release的target_commitish绑定已签manifest.sourceCommit，不再跟随可前进默认分支；预存轻量/嵌套annotated tag只读解析到commit，冲突/循环/类型或身份错在POST前拒绝。旧channel以已读取的parent SHA读取JSON+.sig，固定公钥验证原始字节并核对kind/channel，再判断防回退；孤立文件/错签不再作为可信floor。每次CAS重试重读同一绑定快照并验签，不强推。

最低版本比较合并为单一精确SemVer方法，producer将v前缀规范化结果写入签名字节，并拒绝最低版本高于发布版本；publisher拒绝已签但非规范或超前值。真实离线HTTP fixture红→绿11项、publisher17项通过，未访问GitHub或进行任何远端写操作；具体4文件/SHA见.tmp/release-contract-round24/completion.md。签名/legacy/已有release拒绝硬门禁保持。

仍未实现已公开release但channel推进失败的受控补提恢复，也没有生产legacy typed投影；同名正式v1.1.12已存在，不能拿QA24或简单打开enabled伪装旧build27升级。workflow最低版本未做构建前预检，现manifest生成时明确拒绝；tag核对不能代替仓库侧不可变规则或密码学构建attestation。

## 25. 本地发布恢复、计量保留与当前真实内核复核

第25轮仅本地：显式resume-channel已用当前双架构真实Go归档/临时Ed25519/回环HTTP验证7场景，47项发布测试通过；所有恢复只写渠道，未写GitHub或放松legacy门禁。服务端补回计量30天已入账payload清空、90天resolved异常、30天Webhook保留任务，每表5000×40/跳锁/逐块提交，17/43分固定小时，失败下一小时继续；批次行/hash/序列/水位保留。订阅提示改为当前用户最新有效租约/在线健康Agent/90秒宽限，显式message，不被团队其他节点污染；旧16案例与13项专项race、真实旧boot重放/终结水位通过。134注册实现不是134端点行为全等价证明。

恢复实现与红绿：.tmp/release-contract-round25/completion.md；真实当前归档证据：.tmp/ui-qa/round25-recovery-e2e.json。生产tauriUpdate仍204、可信签名App intent与更新journal授权恢复、新正式SemVer/更高build仍未完成；resume-channel只补渠道，不修draft或缺资产。Node20.19未在本机执行，当前测试运行Node25.5。

## 27. 租约、认证恢复与签名发布协议

私有源码与公开产物库分离已从设计进入schema2生产实现：签入canonical repo，真实源码身份仍绑定实际包；公开tag仅指向零父commit/两普通blob的M与raw.sig，不复制私有Git对象，create-only不覆盖。producer/JS/Native授权/receipt/server投影接通，schema1保留旧语义，旧Tauri204与正式签名门禁不松。新本轮Linux双架构真实归档+RAM临时Ed25519+真正Git/回环HTTP再次通过6场景/101请求，原bundle恢复后仅补channel与原文no-op、raw.sig/父历史负控均过。

schema2旧MyGo不能直接读取，需可信手动bootstrap；schema1保留旧消费者语义，不声称新增的Git树/repo保护也追溯覆盖schema1。partial draft/starter/同名错资产自动恢复未实现，resume仅允许公开且完整Release补channel；未执行GitHub云端/Actions/artifact上传或实际发布。

公开产物库须先由用户用不含私有源码的占位内容初始化；真实GitHub空/暂不可用仓库409会闭合失败，未自动创建Contents/复制source/默认branch兜底。Node/Release/tag/channel非同一远端事务，最后只读核验之后的管理员跨资源变更不能宣称原子阻止。 [GitHub官方Git Data文档](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database)。

Native成功缓存最多8项/30秒是一次成功观察的复用；mac各阶段新service可再发7请求，429/断网闭合失败。prepare/ARM前失败可清自有work且旧App未swap；parent退出后apply前/inspect校验失败保留work/journal旧App，不能泛化所有失败必保留或宣称离线恢复。server新mode无额外成功缓存，匿名API可用性待真环境验。

## 28. 明确草稿ID的只补缺项恢复

现已接入生产CLI `complete-draft <release-id>`：从原签名恢复包读取并验证固定清单、真实tag绑定和已有资产完整字节，只上传缺项；全部文件重新审核后才公开，再沿用仅已公开版本可用的resume-channel推进渠道。starter、同名错误uploaded、额外或重复资产均写前拒绝，本轮不删除、不替换。普通publish新增受控分页草稿发现和公开前完整流审核，公开后每次渠道CAS前再次审核；schema1原绑定和channelOnly写权限不放宽。

完整操作、明确ID定位、原bundle恢复、失败状态和本地验证命令见 [GitHub Release失败恢复](github-release-recovery.md)。本轮没有GitHub云端写入、Actions执行、部署或正式签名操作；历史第25/27节“草稿恢复未实现”保留为当时记录，不代表当前入口仍缺失。

### Linux 服务端归档在 macOS 构建机上的可移植性

第 145 轮每份 Linux 归档解包时 GNU tar 曾报告 155 条 macOS 来源属性警告。第 147 轮修正归档入口，用同一批已验证的服务端、后台和 Agent 文件重打两种架构，不重编业务代码。每份归档 155 项的路径、文件内容摘要及权限与原包一致，已无扩展属性记录及 AppleDouble 条目。两包在断网 Linux 容器中均无警告解包并成功执行 `chordv-server --version`；x64 为兼容执行。发布脚本专项 11/11。候选包、描述文件、校验和及对比证据：`.tmp/ui-qa/round147-linux-metadata-eZEUVD/`。未上传或部署。

### 服务端发行包不再提供旧发布中心接口

第 156 轮使用第 150 轮的 Linux ARM64 和 x64 两份 0.0.34 归档，分别在断网容器中按 production 模式运行、迁移临时库并登录临时管理员。先核实同一管理员访问 `GET /api/admin/system/version` 为 200、`releaseSource=github`、`selfUpdateEnabled=false`；再按 `apps/server/legacy-routes.json` 的原 HTTP 方法请求所有已退役路径，其中动态参数使用隔离测试 ID。每份包的 30 个旧发布中心、8 个旧服务端自更新和 5 个旧分发配置或下载入口全部返回 404，不是鉴权失败。未访问线上或实际 GitHub，结果不证明云端发布已执行。逐条响应状态见 `.tmp/ui-qa/round156-retired-api-Eqnn0Q/{arm64,x64}.log`。

退役规则也由 `TestRetiredPublishingRoutesAreNotRegistered` 持续检查：从旧接口清单读取上述 43 项，核对实际 Go 路由表，并要求现行版本查询入口仍在。即使误加回一个只返回 404 的旧入口，也会失败。第 162 轮以临时 Go overlay 加回一条旧路由，测试按预期失败；撤去 overlay 后，两项真实路由测试通过。该检查不依赖数据库，随现有服务端测试运行，不需要触发发布。

### Windows x64 旧版升级验收输入（Build 150）

普通本地安装包使用独立的应用标识，不用它代替 ChordV 原安装目录升级。另以 Build 150 打包快照制作了仅供隔离 Windows 验收的 x64 内容包：保留 ChordV 产品名、`app.chordv.desktop` 标识与原安装目录名，程序的内嵌模式仍为 local，未授予正式签名或发布权限。验收压缩包 `.tmp/ui-qa/round157-windows-inputs-j13NR5/windows-x64-upgrade-qa-build150.zip` 内含旧 Build 27 安装器及公开签名、当前 QA 安装器、对应 `ChordV.exe` 和 `inputs.json`。旧包已用固定旧公钥验签；新版程序已从 NSIS 解出并与独立程序逐字节比对，通过 Build 150、版本 1.1.12、Windows x64、本地构建身份检查。压缩包及校验文件只保存在本机；单独的 `SHA256SUMS`、`inspection.json` 均在同目录。未在 Windows 上运行安装器，不证明升级、注册表、快捷方式、重启或回滚。后续仅供既有 `scripts/windows/qa/Invoke-ChordVInstallerAcceptance.ps1` 在专用临时测试账号和隔离环境中验收，不用于覆盖日用电脑。

第 170 轮按新的独立 Go 编译目录重新制作了 Build 169 验收输入。真实 NSIS 编译已核对旧安装器传入的被动升级参数对应的两处页面回调；测试见证程序只复制收取的脚本，再将原参数传给真实编译器。临时目录清空、源码目录无生成 `.syso`，旧 Build 27 安装器通过固定公钥验证，新安装器解出的程序与独立 Build 169 程序逐字节一致。ZIP、SHA256SUMS 与 `inspection.json` 在 `.tmp/ui-qa/round170-windows-upgrade-FZlMyh/observed/`。它是专用账号下的本地升级验收输入，不是正式发行包；未执行 Windows 安装运行、签名或远端工作流。切勿用在日用电脑覆盖正式安装。
