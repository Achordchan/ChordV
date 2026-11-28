# MyGo 桌面运行层迁移核对

## 运行边界

- 实现目录：`apps/desktop/native`；MyGo 固定 `v0.9.1`，Go 工具链 `1.27.3`，`CGO_ENABLED=0`。
- React 界面保留，由生成的 `apps/desktop/src/lib/mygo.ts` 调用 `DesktopService.invoke(command, payload)`；原生事件统一从 `events.nativeEvent` 推送 `{ name, payload }`。
- 默认仅连接 `http://127.0.0.1:3100`，数据目录为用户配置目录下 `ChordV-MyGo-Local`。不加载仓库 `.env`，不读取旧版客户端会话、系统生产数据库或部署凭据。
- 正式打包才允许通过链接参数注入 HTTPS API、GitHub 仓库、Ed25519 公钥和构建号；本地构建拒绝公网 API。GitHub 仓库默认空，未配置不会检查线上版本。
- 正式模式只读取安装包内置 API。macOS 正式更新计划必须与执行该计划的原包地址一致，启动候选和恢复原包时不传递上一版本 API；本地更新仍保留独立回环配置。第 188 轮定向回归与实际本地 ARM64 DMG 更新都已复验。
- Build 192 的 macOS 正常安装助手以完整签名应用副本运行。交接前拒绝不同目录身份的同签名副本；提前取消也保留已变更安装位置的事务资料。ARM64 原始 DMG 的真实窗口更新已复验；尚未启用跨启动自动恢复，详见 `mac-update-recovery-design.md`。
- 不需要 Rust/Tauri 进程、Node.js 服务或 Bun 运行时。Node/pnpm/MyGo CLI 仅用于前端构建和打包。

## 原生功能与命令

| 职责 | 已实现命令 / 行为 |
| --- | --- |
| HTTP 与实时事件 | `api_request`、`start_client_event_stream`、`stop_client_event_stream`、`nudge_client_presence`、`record_client_diagnostic`；SSE 有身份认证、重放 ID、读取空闲超时和主动取消，无原生状态轮询 |
| 会话 | `load_session`、`save_session`、`clear_session`、`refresh_session_native`；原子写入、0600 权限、退出墓碑、刷新串行化、旧令牌拒绝恢复、晚到刷新不能覆盖新登录 |
| 连接 | `check_network_conflict`、`connect_runtime`、`disconnect_runtime`、`runtime_status`、`runtime_snapshot`、`runtime_logs`；Xray 独立子进程，本地 HTTP/SOCKS 两端口实际就绪且进程未退出后才标记已连接 |
| 配置与路由 | 保留 VLESS/Reality/MLDSA 字段，自定义规则优先，规则/全局/直连模式；`test_routing_rule` 真实读取本地 geosite protobuf，支持域名、关键词和正则条目 |
| 系统代理 | macOS 使用纯 Go/purego 的 SystemConfiguration 完整 Proxies 字典事务，锁内再次核对预期字典；Windows 用 WinINet per-connection options 查询/修改实际生效配置并快照注册表/连接数据。恢复原值而非一律清空；外部应用已修改的设置不覆盖 |
| 异常退出恢复 | 持久 `proxy-journal.json`；独立 watchdog 通过私有管道 EOF 感知主进程退出，Unix 脱离会话/进程组、Windows 独立进程组；PID 与启动身份/二进制路径核对后清理 Xray。主进程还会监测 watchdog 本身异常退出并断开恢复 |
| macOS 授权 | 仅显式连接时申请 `system.preferences.network`；Authorization external form 只经私有管道交给 watchdog，不写磁盘。启动仅在存在本地恢复 journal 时才触发恢复 |
| 组件 | `desktop_runtime_environment`、`desktop_os_label`、`check_runtime_component_file`、`get_runtime_component_local_info`、`ensure_bundled_runtime_components`、`download_runtime_component`、`cancel_runtime_component_download`、`probe_download_candidates`、`fetch_remote_text`；首次组件从 GitHub 发布资产获取，旧“bundled”兼容命令只核验本地实际安装记录，不伪造已安装 |
| 下载 | 固定版本 GitHub 原始资产与受控镜像；原生重新验证发布清单后授权 URL/SHA256/大小/组件与压缩包 entry；4 MiB Range 分块、哈希绑定断点文件、45 秒无进展超时、可取消、低速退出供界面有界切源；不存在整包 180 秒超时 |
| 发布信任 | `verify_release_manifest_signature`、`authorize_release_manifest`、`release_configuration`；Ed25519 支持 PEM PKIX、base64 DER SPKI、base64 raw32。镜像必须验签；无公钥时原生自行从官方固定 tag 拉取清单原文比对，不接受前端自行指定哈希授权 |
| 防回滚 | `release-floor.json` 按仓库/渠道原子存最高版本、构建号、清单摘要；拒绝低版本/低构建与同版本同构建替换清单。授权、下载、安装前重新检查；严格 SemVer 与前端一致，比较忽略 `+metadata` |
| 安装与文件 | `download_desktop_installer`、`open_desktop_installer`、`install_windows_update`、`quit_for_update`、`consume_desktop_update_install_report`；安装前重新校验完整清单 receipt 与本地 SHA256。`list_local_file_locations`、`reveal_local_file` 仅开放固定目录，禁止会话文件和目录逃逸 |
| 主窗口与托盘 | `app_ready`、`show_main_window`、`hide_main_window`、`transition_main_window`、`update_shell_summary`、`quit_application`、`open_external_url`；登录 660×440、主界面 820×560，macOS 保留 28px 标题栏预留，原生居中/限制屏幕范围/短过渡；托盘模式、节点、连接、日志与退出菜单 |
| 工单窗口 | `focus_support_window`、`begin_support_window`、`open_support_window`、`close_support_window`、`cancel_support_loading_window`；独立不可信页面，限定同源导航与一次性 epoch/窗口标签；窄桥通过拦截导航处理未读/就绪/过期/关闭消息，不给远端页面任何 MyGo 方法权限 |

## 验证记录

在 `apps/desktop/native` 执行：

```sh
go test -race -count=1 ./...
go vet ./...
GOOS=windows GOARCH=amd64 go vet ./...
GOOS=linux GOARCH=amd64 go vet ./...
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o ../../../output/mygo/chordv-windows.exe .
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ../../../output/mygo/chordv-linux .
go tool mygo generate
```

- 已通过 40 项测试，包括真实本机 TCP listener、完整 HTTP/SSE、断点续传与坏哈希拒绝、会话并发、签名与原生授权、持久防回滚、GEO protobuf、独立 watchdog 在父进程组 SIGKILL 后恢复；包括 `+metadata` 标签/文件名的 URL 编码一致性、Windows 中途写入状态的恢复判断。
- watchdog 测试只替换**测试进程**的代理存储为临时文件，没有改宿主机代理；测试代码不进入客户端程序。
- macOS SystemConfiguration 真实只读快照、CoreFoundation plist 往返、Authorization 默认无权限对象的 external form ABI 测试通过；系统 `preferences.plist` 修改时间核验不变。
- `automation_e2e.go` 仅在 `-tags=e2e` 编译时引入 MyGo 官方自动化插件；正常发布不包含自动化入口。
- 可选真实组件集成入口 `TestRealXrayLocalLifecycleWithIsolatedOSProxy` 已以本机真实 Xray 26.2.6 和 GEO 资产执行通过：真实 HTTP 代理转发至本机 origin、SOCKS5 握手、Xray 意外退出、原生事件、精确恢复隔离代理、全局模式重连和正常断开均覆盖；系统代理存储/授权/watchdog 依赖仅在测试中隔离。默认无 `CHORDV_TEST_XRAY_DIR` 时明确跳过，不拿跳过当验收通过。

```sh
CHORDV_TEST_XRAY_DIR="/absolute/path/to/genuine-xray-and-geo-fixtures" \
  go test -race -count=1 -run '^TestRealXrayLocalLifecycleWithIsolatedOSProxy$' -v ./...
```

本机使用的旧 `src-tauri/bin` 仅为用户已有的忽略静态资产，测试只读复制到临时目录；不能为了清理旧实现而删除这些原件或旧编译输出中的用户文件。

## 未通过实机验收的项目

- macOS 实际系统授权、宿主机代理写入/断开/强杀后逐字段恢复：未擅自改宿主机系统代理。真实 Xray 本机 HTTP/SOCKS 生命周期已验证，但不等于此项 OS 写入验证，也不等于 Agent/VLESS/计量的完整端到端验证。
- Windows 真实系统代理、安装器替换进程、托盘/休眠恢复：本机为 macOS，只有 Windows 交叉编译证据，不能代替 Windows 实机验证。
- Developer ID 签名/公证、Windows 签名、真正 GitHub 发布/渠道切换：用户要求仅本地调试，尚未发布或部署；构建门禁由根流程负责。
- 工单独立本地测试站点已完成真实 Go 签票/兑换、ready、未读7→0、窗口复用、关闭重开及会话过期重开；远端页面调用 MyGo 被 Untrusted 拒绝。另以真实3秒签票延迟两次确认加载窗口关闭后不复活，再次正常打开成功；两阶段临时环境均已清理。未验证线上供应商，不向线上站点提交票据；详情见 `ui-qa.md`。
- Linux 仅保证当前 Go 源码可交叉编译，系统代理操作明确报未支持；Android/iOS 不由 MyGo 上游桌面 API 覆盖，不能将桌面迁移证据用于宣称移动端迁移完成。
- 根流程已精确清理78个未修改的旧桌面 tracked 路径并保留用户已有 ignored 静态资产，旧入口委托唯一 MyGo 入口；详见 `legacy-desktop-cleanup.md`。全部视觉状态和跨平台安装仍不能以清理完成替代验收。

## 第12节最新独立进程与反馈验收

上文40项为初轮历史，不是当前门禁数。最新普通/e2e真资产原生全量race17.979/27.439秒、统一test98/98。真实main GUI父SIGKILL后独立watchdog管道EOF恢复文件代理、清理身份/路径一致的Xray并退出已验；同进程stand-in已删除。运行中断/启动/托盘与真正退出失败分开typed事件，持久反馈正常流条件呈现；实际个人/团队820×588头部与主控件无交叠、重连清旧反馈，长原因详情和660×468登录另有组件点击证据。

这一证据不涉及宿主SystemConfiguration写入/授权、Windows实机、发行签名公证或旧安装迁移。真实双Agent/Reality团队多批计量与SSE显示也已另验，不再把“Agent/VLESS尚无真实本地链路”作为当前结论；跨机器/宿主代理仍保留边界。完整文件、命令和证据见`local-verification-20261117.md`第12节，两轮自建进程/root/socket/缓存已清理。

## 第13节更新下载与安装交接

下载/复用只就绪不提前开包，显式安装核对当前/完成/就绪身份及渠道；真实HTTP200重传重置测速基线，真实45秒停滞通过独立取消原因继续健康第二源断点续传，主动取消仍停止。普通/e2e真资产全量race80.293/87.611秒、统一test99/99，普通构建与DMG校验通过；未重跑真GUI安装或宿主代理。当前macOS没有自动复制替换/重启实现，打开DMG和退出不能作为完成证据，正式签名及旧Tauri过渡仍未验。逐文件及最新普通包SHA见本地验证第13节；误用未定义标签的日志已明确排除。

## 第14节本地自动安装与契约补充

Mac独立helper实际拥有只读DMG暂存，校验只读sealed ChordVBuildInfo而不执行候选；真实父EXIT才原子swap，OS拒绝open则恢复原inode/CDHash。已确认提交不可公开取消，丢确认及准备期取消可清理；Windows同一交接流程保留失败后的SSE/心跳。普通/e2e完整真资产race186.363/203.337秒、普通build14与DMG通过。仅本地adhoc正控；没有新GUI健康ACK或helper断电journal自动回放，旧版迁移/正式签名/实机仍未验。用户暂不授权宿主代理写入，只继续隔离测试，详情本地验证第14节。

### 2026-11-17 第15节更新健康门禁

`app_ready`与显示窗口分开。候选原生startup成功、真实本地首屏可交互后，才经私有socket挑战向独立helper确认；内核PID/UID/微秒创建身份/执行路径/运行CDHash、盘上签名和候选inode两次核验。NSWorkspace提供真实启动PID；退出等待用kqueue，失败先等待精确候选退出再反向交换，不按名杀进程。健康成功持久化后才清旧副本；结果不确定与持久化失败保留资料。

真实完整普通包1.1.12/build15已在离线API和空会话/无代理journal下完成原生+React ACK及真实DMG更新，专项race21.923秒；只读恢复inspector始终MutationAuthorized=false、RequiresRevalidation=true，未接启动，不冒充自动恢复。第一轮e2e失败的根因是挑战前关闭Unix socket导致peerPID ENOTCONN，已真实子进程屏障红绿验证并修复；初始化期回调阻塞修的是TestMain测试入口，不是生产兜底。完整门禁和跨平台未验边界见第15节。

### 第16节：持久身份与授权方案否定验证

实际更新前事务现记录Current/Candidate/Work/Parent的卷UUID、文件ID和创建时间，均从真实目录FD读取；实时swap仍用新鲜dev/inode CAS。真实swap/rollback、外部重建拒绝、旧device模型和fresh-process实际A/B配对已过，过期swap_pending或伪造healthy都不给MutationAuthorized。普通/e2e原生完整race237.745/258.556秒，普通build16完整GUI ACK专项24.402秒通过。

传统file-based Keychain在默认及显式Encrypt/ChangeACL下仍可被同UID C改data并由A/B读取，不能作完整性锚；裸GUI Mach-O复制件也不是Keychain可用的完整代码身份，完整Helper.app正控才通过。没有因此放宽ACL、添加trusted=true或在同DataDir存明文MAC key，生产没有Keychain变更。首次测试授权询问已核对仅本次C并点击拒绝清理，末尾可见窗口0、用户list/default不变，细节见第16节。真正可信授权和自动恢复依然未实现，正式DP/profile与跨重启/断电未验。

### 第17节：组件取消与原子提交点

取消下载不能只停止HTTP：本轮在verifying/extracting和实际operationMu等待后取消，旧实现仍覆盖组件/metadata并发completed，真实签名清单与缓存恢复已红测。现组件在提交锁后复查child ctx，旧copyAtomic改为Background委托到唯一copyAtomicContext实现，分块及最终rename前检查取消，暂存清理/权限/fsync不变。8安装分支与首块复制屏障、成功/提交后取消正控通过；完整普通/e2e真资产race250.559/251.886秒，普通build17完整GUI健康23.673秒通过。

rename后的取消不回滚已提交文件，metadata依旧独立写入；提取/hash不保证即时中断，阻塞OS读需返回后观察ctx。没有生产Mock/新依赖/重复复制路径，不触碰代理/Keychain，详见第17节与round17-desktop-component-cancel/delivery.json。真正可信intent/自动恢复及正式签名/跨平台条件仍未完成。


### 第18节：Linux GNOME设置与稳定进程身份

Linux不再一概未实现：仅GNOME登录用户、本地D-Bus及严格用户运行目录支持固定gsettings快照/接管/恢复；未知桌面/root/认证代理拒绝。独立watchdog保留有限会话环境，进程身份改PID/starttime/boot-id，comm括号/空格不干扰。真实GLib独立keyfile正反控及幂等恢复race通过，不改宿主代理；没有Linux实际dconf/独立watchdog成功证据，多字段check→set仍非原子CAS，KDE未实现。普通/e2e完整真资产race265.131/257.391秒、普通build18真实GUI健康26.694秒通过。正式签名资源用户暂不提供，可信更新恢复仍未完成，详见本地验证第18节。


### 第19节：托管组件恢复与实际Linux运行

组件文件/metadata采用预备文件、原inode硬链接备份、固定os.Root intent和两个rename的可恢复提交；不是声称双rename本身原子。pending不能ready；真实子进程四阶段exit23和另一个新进程启动恢复、原inode保留、direct/zip签名绑定/外来文件拒绝/取消边界均验。Windows目录fsync未实现，硬链接不支持时替换前失败；不宣称签名App可信自动更新恢复已经完成。当前Linux arm64容器实际跑proc稳定身份/GNOME模型和整套组件恢复，GNOME真实dconf仍未验，详见本地验证第19节。


### 第20节：真实会话与安装契约补验

本轮真实Linux独立dbus+dconf会话发现DCONF_PROFILE漏转发读错默认库，现原白名单保留。非root实际profile/接管恢复/生产watchdog EOF/父SIGKILL/外来修改保留五场景通过，精确自有容器/image均清理，新增Ubuntu隔离CI未远端执行。普通/e2e真资产完整race267.469/274.922秒；非完整图形GNOME桌面或物理Xray代理流量验收，详见本地验证第20节。


### 第21节：passive与恢复目标一致性

真实dconf红测证实同profile路径换库、值相同会让旧journal写错库并丢证据。现scope绑定UID/config/runtime/profile路径与内容、调用前后核对，跨空间或旧无scope保留journal/target；真实双库恢复及原EOF/父SIGKILL流程已验。它不是认证完整性锚或App可信intent，gsettings仍非原子CAS，详见本地验证第21节。

## 第22轮补充

第22轮只改Linux测试：官方ELF Xray/Reality真实106496字节两次往返与错误UUID负控，生产Invoke连接/断开/重连/内核崩溃实际dconf恢复，以及流量就绪后父SIGKILL由独立生产watchdog恢复并终止实际内核均通过。完整GNOME/dconf组通过，Linux非race；HTTP客户端显式使用读取到的GNOME代理，不是GTK自动代理发现；heartbeat为隔离夹具。首次私网阻断根因是Freedom默认finalRules，仅测试peer放行本次echo确切回环端口，不改生产配置。原ignored GEO不匹配当前锁，另下载到证据目录，原文件保护；自有容器/child image已精确清理。签名App可信intent/更新授权恢复和宿主代理仍未完成。

## 第23轮补充

第23轮从显式设HTTP代理提升为系统默认GIO resolver/GSocketClient实际自动消费GNOME配置。新C测试消费者不调用set_proxy_resolver、不传代理、不注入proxy env，检查唯一proxy列表和实际协商；106496字节往返/重连、wrongUUID→协商后EOF且echo不增、ignore-loopback/direct恢复均通过，3次重复及强制直连/取消UUID负控两变异红实证。仅HTTP/GIO，不代表完整WebKit/GUI/HTTPS/SOCKS/KDE/PAC或真实后台租约；Linux非race。helper deadline/崩溃不得计负控成功，已修并经独立只读复核；自有容器/image清理。官方API依据：https://docs.gtk.org/gio/iface.ProxyResolver.html 与 https://docs.gtk.org/gio/method.SocketClient.connect_to_uri.html 。

## 第24轮：真实运行测试接入可复现CI

此前Linux workflow未准备真Xray/GEO和GIO消费者，真实流量/默认发现测试会skip；现新增仅测试Linux两架构固定锁，Xray版本必须与生产锁一致，GEO直接复用生产锁，不增加Linux发布targets。准备脚本复用原downloadLockedAsset验证固定URL/SHA/长度，只向全新自有目录解压固定成员并核对ELF架构，既有目录拒绝且不删除；两架构真实默认fetch准备通过，arm64随后实际运行，amd64在无网络/只读root/nobody的独立容器中仅执行官方Xray CLI版本正控（Mac arm64上的模拟，不冒称x64完整CI）。

默认GIO测试peer改用自身固定dns.hosts与ForceIP，无容器/宿主hosts别名。早期单条echo allow不等于封闭所有目标；本轮增加allow后显式catchall block/delay0，仅fixture，生产配置未改。新第二HTTP端口先通过数字回环/Proxy:nil实际200命中，再经默认GIO代理必须拒绝且命中0。无hosts实际Linux组22/22、10个必需测试全部pass且0skip，GIO重复3次通过；测试日志经Go原生test2json转换、同一Node门禁核验。实际移除GIO env会使Go整体PASS但该项SKIP，新增门禁真实拒绝exit1，不把skip当验收成功。

Ubuntu24 x64 hosted job已接线真实下载/GCC消费者/显式env/pipefail/Go JSON证据校验；必需十项缺失、跳过或失败都拒绝。仅修改本地workflow未触发；arm64没有hosted CI，Linux本地二进制执行非race，不混称。GIO仍仅HTTP消费者，非完整GUI/HTTPS/SOCKS；heartbeat仍明确夹具。全新资源精确清理，详见round24-linux-ci/summary-proof.json与本地验证第24节。

## 25. 本地发布恢复、计量保留与当前真实内核复核

当前锁定真实资产：Mac普通/e2e race 264.587/274.032秒，共享Reality peer在Linux22/22及默认GIO3重复通过。错误UUID的HTTP/SOCKS都未触达echo，正UUID变异均真红。Windows真实旧updater/安装/ARGS/注册表/健康/失败恢复、Intel/旧macOS/跨机器、root-systemd、公开GitHub/镜像投递未验；Linux为arm64真实非race隔离容器，不是GUI/HTTPS/SOCKS/真实后台租约。Mac本轮SOCKS只证TCP CONNECT与完整payload，不证UDP。

## 26. 计量提示定位与用户安全写入契约

新前端使用真正本地build26重新打包；strict adhoc/DMG/密封身份通过，完整原生+React更新健康26.008秒。未改原生Go代码，未重复完整e2e race；窗口内消息定位由独立Chrome组件/CSS测量，不冒充实机移动端或Windows。生产tauriUpdate仍204，Windows真实旧updater/安装/内部ARGS/注册表/快捷方式/卸载/健康/失败恢复、可信签名App intent与更新journal授权恢复、新正式SemVer/更高build仍未完成；build26仅本地adhoc，低于旧正式build27，不能当升级放行。

## 27. 租约、认证恢复与签名发布协议

Native从第一次临时失败计宽限，401刷新网络/5xx不当立即终态；显式terminal、旧运行指针保护及清理失败journal/可操作持久反馈均落地。桌面UI不另设判停计时；Web/Android只有匹配active+有效续期才成功，typed2xx过期立即终止，503文字不升级成撤权，定时/恢复单飞、旧回复围栏与结果副作用去重。认证真实6项迟到错误、手动刷新迟到先红后绿；App使用hook唯一归属出口，旧保存与新登录走同一串行队列，同用户退出重登也隔离。

最终pnpm check9/9、test110/110；显式真实DB全量race818项pass（API628.837秒）、Native完整e2e/race398项pass（307.626秒），共享协议独立race亦过。新普通Mac local build27实际应用19,266,594字节、DMG6,676,992字节，strict adhoc/密封身份/DMG通过；完整原生+React GUI健康25.823秒，API回环port1、无代理journal。macOS本机服务端/Linux x64+arm64已重建，Agent真实归档/HTTP供给与Linux/Windows双架构仅交叉编译/vet通过；缓存MyGo步骤报告6.6秒不作异条件性能对照或“质变”证明。

宿主系统代理写入暂不授权，正式DeveloperID/profile/公证/Authenticode资源暂不提供；不重复索取、不做Keychain试验，不降低门禁。Windows真实旧updater/安装/参数/注册表/快捷方式/卸载/健康/失败恢复、新模式平台签名bootstrap及可信自动更新恢复仍未验。local build27非正式发行，也不作为旧official build27升级放行。

Native成功缓存最多8项/30秒是一次成功观察的复用；mac各阶段新service可再发7请求，429/断网闭合失败。prepare/ARM前失败可清自有work且旧App未swap；parent退出后apply前/inspect校验失败保留work/journal旧App，不能泛化所有失败必保留或宣称离线恢复。server新mode无额外成功缓存，匿名API可用性待真环境验。

## 第28轮统一本地验收

修复用户创建/编辑输入；站点专用canonical/IDNA去重；缺失账号由事件与启动恢复，坏marker不饿死其他缺口；真实Owner/FK、Member/Sub、Token/User死锁与旧JWT撤权后新建租约均先红后绿。GitHub草稿原bundle只补缺项恢复、完整流审核及Content-Length已进生产CLI。Mac schema2普通GUI独立进程整链通过；新Build28/新后端和归档均本地重建。

最终冻结后 `pnpm check` 9/9、`pnpm test` 110/110；真实DB race971项（API 717.76秒），Native完整e2e/race424项（369.675秒，私有普通Build28 schema1/schema2均实际执行）。Linux/Windows双架构16组交叉编译/vet通过，不当实机。实际新双架构Linux归档+原bundle+真实Git/HTTP三恢复模式436请求通过。

保留全部原红及夹具错误：用户空密码/非法字段/转换差异；Owner多种40P01与connect敏感保存后旧JWT仍200/active1；站点canon/DTO；publisher污染、隐藏draft及缺Content-Length。Owner广专项55pass/1观测失败来自共享PG全局advisory把其他schema计入锁链，修正仅精确schema观测，expected2/等待预算不变，显式外部链正负控证明；root首次全量本身971pass/770.801s，随后仍对最终helper再完整重验。Native早期04通过但泄漏自有16943导致06 ACK拒绝，fresh PID/签名/启动身份核实后精确终止，测试清理根因修复并连续两次及root新包全量通过；不改生产单实例/ACK、不回溯称从无遗留。原390浏览器缩放图有底部重复捕获，但DOM仅1个App/标题；独立标准模式真clock390/820无重复，不锁定单一成因。旧契约Prisma初次生成日志明确自动加载根.env，不宣称从未读取；未输出其值、实际DSN均显式私有本地。已隔离cwd+最小环境+RootEnv读取阻断器重生成/重跑87例，读取尝试0、可观测输入/存储/密码结果相同；两批临时29文件client均清理。最终扩大hdiutil扫描还发现1份仅attached自有测试镜像；时间归因未知，按精确image-path/UID/readonly/整盘唯一归属二次核验后普通detach disk11成功，前后证明保留。原环境断言失败保留，不能把手工清理当生产缺口修复或回溯称原本零遗留。

逐文件/摘要、完整命令、环境和未验范围见 `.tmp/ui-qa/round28-completion.md`、`round28-final-report.json`；原始日志保留。无UI/CSS改动，8份上轮冻结客户端前端源码SHA未变，检查后台名称溢出样式与空密码正常提交契约；已重跑并查看当前客户端820/390与后台1024/390截图；原390捕获异常另用标准模式独立截图和DOM复核，非目标OS实机布局证明。未新增生产Mock或临时probe，无重复上传/普通用户校验/心跳替代链；未提交/推送/发布/部署/主服务重启、系统代理写入或正式证书操作。完整目标仍active。

- 新发现且未修复：macOS更新清理在mountpoint detach失败后仅按同Fsid误判成功，可能遗留仅attached设备并删除marker；旧assertMacNoMount只查work字符串也会漏检。本轮扩大扫描发现1份自有测试镜像（产生时间未知），精确普通detach后归零，不代表生产cleanup已修好。下一阶段优先修复设备归属记录/清理与严格负控。
- 按用户决定未改宿主系统代理、未用DeveloperID/profile/公证/Authenticode；Windows真实安装/旧updater/恢复、目标Linux桌面、移动端/Intel/旧macOS尚未实机验，交叉编译不替代实机。
- 可信自动journal恢复仍只读inspector，认证intent及启动自动回放未实现；schema2旧客户端需可信bootstrap，不因本轮本地GUI通过而松正式门禁。
- 未做GitHub云端/Actions上传下载/权限/公开库实际发布；complete-draft不自动清starter或替换错资产。100页库存上限闭合失败；远端前后审核不是跨资源事务。
- 旧scripts/mygo-agent-e2e.mjs仍依赖主本地API/output/local及public表，本轮未运行；当前后端物理Agent/Xray整链应先改成独立实例/私有schema。Native真实Xray与HTTP回执/真实包供给不冒充该整链。
- 用户普通编辑相同active状态等后续副作用、其他DTO与一般provisioning完整旧新行为仍待定向核验；本轮不宣称后端全部等价或所有锁图已普遍证明。
- 密码创建/修改保留本项目72字节上限，不恢复旧bcryptjs静默截断；87例输入存储及邮箱用例不是全部Unicode/邮箱标准的普遍等价证明。
- 构建含dirty工作树，嵌入HEAD不代表远端已含改动；后台chunk>500kB警告保留。public48行摘要/PID/代理mtime与大小不证明索引、统计、全进程内存/日志或共享PG通知完全无变化。

## 第29轮：镜像归属与隔离Agent整链

第29轮修复macOS更新镜像归属/attached-only清理及取消中断attach的根因；隔离当前后台+生产Agent+真实Xray链并退役旧public按行清理。最终Native e2e/race 499项、check9/9、test110/110、真实Agent链7项通过。

保留原真实attached-only/缺work假成功红测试和partition权限红测试；首轮ownership夹具0644导致正控失败，已改成与生产私有copy一致的0600。真实stage与新reattach夹具均暴露entities[0]假设，现按明确整盘选择。首个完整Native为490 pass/3失败：旧成功报告同步时窗、parentkill中断attach、reattach夹具首项误读；首次pnpm test为109/110。测试成功等待只修VNODE谓词，未增加40/20秒预算或移动生产report/备份删除顺序；parentkill修的是生产有界capture与同步取消预算。5份精确失败夹具先保存诊断/全部文件SHA、两次确认无其attachment且无其进程后删除；没有detach或force，不能回溯称原过程从无失败或遗留，也不是生产pending自动恢复。

重点边界：路径式hdiutil detach与最后IORegistry检查不是原子操作，不能证明消除全部设备复用TOCTOU。 attach客户端超时/失败且无完整归属时仍保留intent和原目录，不用空inventory猜测后端已结束；125/70/205秒是预算，未跑满极限慢attach实机。 可信自动journal replay仍未实现，旧schema2客户端bootstrap门禁不放宽。

逐文件、完整验证和未验边界见 `.tmp/ui-qa/round29-completion.md` 与 `round29-final-report.json`，历史失败日志保留。
