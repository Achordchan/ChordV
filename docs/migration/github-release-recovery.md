# GitHub Release 失败恢复

GitHub Release 仍是唯一发布真相。恢复包只是同次构建在首次远端写入前保存的原始文件，不是另一个版本源；恢复不重建、不重新生成清单、不重新签名、不覆盖标签或已有资产。

## 选择操作

| 远端状态 | 操作 |
| --- | --- |
| 还没有 Release，至多留下合法 metadata tag | 原包重新执行 `publish`；已有合法 tag 只核对，不覆盖 |
| 明确 ID 的草稿，已有资产均正确且仅缺少部分文件 | `complete-draft RELEASE_ID`；审核已有文件后只补缺项，再完整审核并公开 |
| 全部文件正确，但仍为草稿 | 同样使用 `complete-draft RELEASE_ID`；不重新上传，只审核后公开 |
| 已公开，渠道指针更新失败 | `resume-channel`；只审核已公开版本并补渠道，绝不修改 Release 或资产 |
| 草稿存在 starter、同名错误文件、额外文件或重复资产 | 停止。当前命令不删除、不替换；需要单独审阅明确资产 ID 和草稿状态，不能用自动覆盖选项绕过 |

普通发布只创建新 Release，不推测恢复对象。创建前分页检查已有 Release，包括有推送权限时可见的草稿；同标签出现多个草稿时报告全部匹配 ID，要求人工选择，不自动猜测。分页每页100项，超过100个完整页仍无法确认结束时停止创建。

GitHub 的按 tag 接口只承诺读取已公开版本，不能用其404判定没有草稿。恢复直接按明确 Release ID 读取，并核对原签名清单、标签、通道和仓库。

## 使用原恢复包

1. 从**失败的原 workflow run / run attempt**下载 `desktop-recovery-*` 或 `server-recovery-*` Actions artifact，取得其中的 `*-recovery.tar.gz`。不重新运行构建或 manifest 步骤；`publishedAt` 改变也会使原字节不匹配。只解包已确认来自原构建的可信恢复包到一个新目录，不混用其他版本文件。
2. 沿用原公开仓库、固定 Ed25519 公钥和仓库范围 Token。Token 需要能读取草稿、上传资产及公开该 Release；不要使用客户端配置或向客户端发放 Token。恢复只需要公钥，不需要私钥、证书或公证配置。
3. 按已核实的 Release ID 执行下列命令。环境变量应由操作者或可信运行环境提供；命令不会自动定位另一个草稿或切换恢复模式。

```sh
: "${RECOVERY_BUNDLE:?设置原构建恢复tar.gz的路径}"
: "${CHORDV_RELEASE_REPOSITORY:?设置原公开产物仓库owner/repository}"
: "${CHORDV_RELEASE_TOKEN:?提供仓库范围Token}"
: "${VITE_GITHUB_RELEASE_PUBLIC_KEY:?提供原固定公钥}"
: "${RELEASE_KIND:?设置desktop或server}"
: "${RELEASE_ID:?设置失败日志中已核实的明确草稿ID}"
export CHORDV_RELEASE_REPOSITORY CHORDV_RELEASE_TOKEN VITE_GITHUB_RELEASE_PUBLIC_KEY RELEASE_KIND
export RELEASE_ASSET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chordv-release-restore.XXXXXX")"
tar -xzf "$RECOVERY_BUNDLE" -C "$RELEASE_ASSET_DIR"
node .github/scripts/publish-github-release.mjs complete-draft "$RELEASE_ID"
```

若创建 Release 的响应已丢失，失败日志可能没有 ID。持推送权限的操作者可只读列出仓库 Release，核实 tag、draft、prerelease 和原构建恢复包后再指定 ID；不要仅用 `releases/tags` 查询推断草稿不存在：

```sh
GH_TOKEN="$CHORDV_RELEASE_TOKEN" gh api --paginate \
  "/repos/$CHORDV_RELEASE_REPOSITORY/releases?per_page=100" \
  --jq '.[] | {id, tag_name, draft, prerelease}'
```

若公开请求成功但响应丢失，`complete-draft` 会因已公开而拒绝，不再上传。确认远端已公开后，沿用同一恢复目录执行：

```sh
node .github/scripts/publish-github-release.mjs resume-channel
```

## 实际校验与写入范围

- 本地先验固定公钥签名、清单 schema/repo/source/build/平台身份、全部文件SHA256与长度和SHA256SUMS；任何本地不符在联网前拒绝。schema2还核对真实 tag 指向的零父 commit、恰好两个普通 blob、原 M/raw.sig 字节；schema1继续既有源码commit绑定，不改写其语义。
- 草稿按明确 ID 核对 `draft:true`、`published_at:null`、tag 和 prerelease。完整分页列出资产，已有项必须是预期集合的子集且 ID/name 唯一、状态uploaded、URL归属正确、长度/digest正确，随后实际下载核SHA256和长度；metadata正确但实际bytes错误仍拒绝。初审失败时写入为0。
- 上传只允许审核后确定的缺项，收件URL必须同时匹配官方上传域名、仓库和明确 Release ID。请求Content-Length取已校验清单中的正安全整数长度，不使用未知长度的chunked上传；输入stream在上传或响应读取失败后关闭。能力层禁止删除、覆盖、修改其他Release或tag/ref；上传断流或冲突时停止，不盲目重传。响应丢失后重新运行同一命令会重新审核远端已存文件。
- 补齐后重新审核全部实际文件、原清单/签名、Release和资产身份及实际tag，确认渠道未前进到更高版本，才公开。公开后沿用 `resume-channel` 的完整审核和非强制渠道CAS；其已公开且完整的门禁不因本功能放宽。
- 普通 `publish` 也使用同一完整文件审核核心，公开前不再只信上传回执与name/state；公开后每次渠道CAS前再审核。流程不具备GitHub服务端事务锁，外部并发更改只能在前后复核及冲突时被发现，不能宣称不可变仓库规则或跨请求原子性。

## 本地验证

```sh
node --test .github/scripts/complete-github-release-draft.test.mjs
node --test .github/scripts/*.test.mjs
```

正式测试使用临时签名、真实隔离bare Git和本机HTTP，覆盖原bundle真实解包后CLI续传、上传响应丢失、完整草稿、分页/重复/额外/starter/错误bytes/错误header、跨仓库和Release ID、实际metadata树、公开后渠道恢复及受限写权限。它们不是实际GitHub故障、Actions artifact上传或正式签名安装的云端证据。

本轮未增加自动恢复workflow，也没有自动清理starter或替换同名uploaded资产。缺原bundle、公钥不符、实际tag不符或无法确认草稿身份时保持停止，不生成同标签替代品。

### 从当前 Linux 候选包演练恢复

第 168 轮使用 Build 166 交付目录的两份 Linux 0.0.34 归档。用临时 Ed25519 密钥生成清单和恢复归档，再解包到空目录。两份服务端归档、清单原文、分离签名、SHA256SUMS 均与输入逐字节一致，无须重新生成签名即可通过公钥及完整性检查。随后用恢复出来的两份归档运行 `TestAgentRealReleaseArchiveOnboardingHTTP`；两种 Agent 架构均可实际下载并匹配各自归档摘要。证据见 `.tmp/ui-qa/round168-server-recovery-HgVU5K/result.json`。当时用 macOS 的 `tar` 清点并未显示系统附加条目，故以第 175 轮的跨平台结果为准。

第 175 轮用断网 Linux 容器的 GNU tar 检查旧归档，实测五个主机专属附加条目和五条警告。恢复包改为与服务端包共用同一打包函数后，在 macOS 重新构建的本地演练包只有上述五个正式条目、零警告。解包后校验和通过；原清单及签名未重写，两份 Linux 归档的 Agent 下载复验通过。使用演练临时签名，独立数据库已停止，未写 GitHub、未实际恢复云端草稿或安装节点。证据：`.tmp/ui-qa/round175-portable-recovery-ar3qNe/gnu-tar.log` 和 `result.json`。

第 176 轮将 Build 169 交付内的两份实际 0.0.34 归档交给正式发布代码，传输全部指向独立的回环 HTTP 服务及临时 Git 仓库。两份归档已接收而第二份响应丢失时，原 Release 留在草稿；用原恢复包执行 `completeDraft` 只补清单、签名和校验文件，不重传前两份。再注入频道指针写入失败：Release 已公开、原标签和资产不变，`resumeChannel` 只补渠道，重复恢复写入 0 次。渠道原文和签名、五个已上传文件均与恢复包逐字节一致。使用临时签名和本机请求替身，没有连接 GitHub 或改动线上。结果：`.tmp/ui-qa/round176-server-publish-recovery-aCU7bQ/result.json`。

第 177 轮将该演练固化为服务端工作流的签名前门槛，真实归档的 Agent 分发核验之后、记录待签名输入摘要之前执行。普通脚本测试没有归档时会显式跳过；发版验证步骤固定提供本轮产物目录，缺任一架构直接失败。专项可用 `CHORDV_TEST_SERVER_RELEASE_DIR` 指向两份归档及描述文件的目录，本机用 Build 169 两份交付归档通过，移除 x64 的独立副本按预期失败。试签密钥只在测试进程中使用，恢复试验只在临时目录和回环服务执行，不修改原输入。这是验收门槛，不是云端自动恢复工作流。
