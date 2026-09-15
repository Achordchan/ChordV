# 客户端体验与后台样式整理（2026-09-15）

当前分支 `achord-agent/client-runtime-experience`，基于后台 0.0.18 的 `902b93b`。本轮改动未提交、未开 PR、未部署，版本号保持后台 0.0.18 / 客户端 1.1.8。

## 当前范围

1. 发布中心恢复强制更新和最低兼容版本设置。
2. 连接、断开及退出登录等待优化。
3. 客户端本机 TCP 延迟探测；后台分开展示服务器探测和客户端上报。
4. 团队负责人只允许在团队成员中转移。
5. 排查后台所有可达页面、表单与弹层的旧样式，排除工单系统。
6. **后续已选定 Product Design 方案 1 并实现组件进度浮窗及 DEV 模拟下载窗口，详见 `download-progress-20260915.md`。原整体页面保持不变。**

## 样式排查结果

按 App 路由、页面导入和实际弹层调用链排查，没有用搜索到的圆角值直接认定所有组件过时；头像、徽章保留其原有形状。

| 页面/入口 | 排查及处理 |
| --- | --- |
| 概览 | 已采用 Dashboard CSS Modules；接入非工单统一控件主题 |
| 客户、团队 | 已采用 CustomerWorkspace；团队编辑补上表单样式，统一负责人选项构建器 |
| 订阅列表及详情 | 将遗留的大圆角容器和蓝色操作改为紧凑样式；SectionCard 的紧凑模式只由订阅页面启用 |
| 套餐及套餐编辑 | 保留现有 PlansPage / EditorDialog 布局；下拉弹层、输入框、按钮接入统一主题 |
| 节点、接入与入站配置 | 保留 NodesWorkspace / NodeOnboarding，统一旧入站和 Agent 操作样式；服务器/客户端探测分行展示 |
| 发布中心 | 保留现有表格工作区；恢复更新策略字段；删除已无调用方的 ReleaseRecordCard |
| 运行组件及兼容旧来源 | 新组件页保留现有布局；仍可达的旧来源管理页移除大圆角、蓝色操作 |
| 公告 | 已采用 Announcements CSS Modules；控件和弹层统一 |
| 系统设置、站点地址、账号安全 | 复用现有编辑器外壳，补齐未指定样式的 Modal 默认外壳和输入/下拉主题 |
| 连接策略、附件与图床 | 保留专用样式；控件遵循非工单主题，不修改工单页面或工单 CSS |
| 团队转入、确认与操作弹层 | 统一按钮、表单、菜单和 Modal 外壳；团队转入面板移除大圆角和旧文案 |
| 工单 | 明确排除；主题隔离回归确认仍为原来的 blue/lg，SectionCard 默认外观不变 |
| 登录与启动加载 | 已有专用 AdminLoginPanel / AdminBootSkeleton；不改其布局 |

`AdminAppearance` 通过 React 主题上下文覆盖非工单页面及其 portal 下拉弹层，`withCssVariables=false`；不修改 root/body、全局 styles.css 或主 MantineProvider。已检查样式作用域、表单宽度、长文案换行、下拉高度和现有响应式规则。未做浏览器截图或像素级验收，按用户要求留给用户。

## 功能语义与限制

- 普通新发布显式使用 `forceUpgrade=false, minimumVersion=0.0.0`，避免后端旧默认值把所有旧版本变成必须更新。编辑旧记录保留原策略；未勾选强制但设有最低版本时，界面明确提醒低于该版本仍强制更新。
- 团队编辑旧规则允许把外部账号直接加为负责人，与本次要求冲突。已改为先添加成员再转移负责人；新建团队仍可选择未加入团队的账号。事务内再次检查成员归属，防止并发移除/转移后误改负责人。
- 客户端不再调用后台代测接口，也不再用服务器延迟冒充本机结果；没有本机结果时显示未检测。原服务端探测 API 保留供旧客户端兼容。
- TCP 延迟衡量本机到节点端口的连接耗时，包含 DNS；不是带宽或代理全链路吞吐。最多 6 个节点并发，每个节点 DNS/连接共享 4 秒超时，多地址并发尝试。
- 客户端上报仅接受有订阅授权的节点，限制频率和批量大小。每账号每节点仅保留最新记录；后台聚合最近 15 分钟记录，显示平均成功延迟及可达账号数。结果是客户端上报数据，不用于权限、计费或服务端节点启停。
- 新增 ClientNodeProbe 数据库迁移，需先更新后台并执行迁移，再发布客户端；没有更改生产数据库。
- 本机连接/断开移到工作线程；移除固定 900ms 等待，以本地端口就绪为准；移除 Windows 上原本非致命、却阻塞连接完成的外网自检。保留组件验证、代理冲突检查和失败回滚。
- 断开和退出登录先完成本机停止，再异步通知后台，不阻塞界面；本地凭据清理仍等待完成。离线退出无法保证远端撤销成功，原远端会话仍依赖失效/过期机制。
- 连接中账号退出、切换时，迟到结果不会重新启动或恢复旧账号界面；原生组件准备阶段也核对当前 session。
- 不能承诺所有网络下秒连：后台会话/组件计划请求、组件本地校验、macOS 系统代理配置仍有实际耗时，本轮未实测用户网络下的总连接时间。

## 逐文件改动

### 后台界面

- `apps/admin/src/App.tsx`：按页面启用 AdminAppearance，工单排除；统一团队转入弹层样式及中文文案。
- `apps/admin/src/features/shared/AdminAppearance.tsx`：新增局部主题，覆盖控件与 portal 弹层。
- `apps/admin/src/features/shared/AdminAppearance.module.css`：输入框、标签、按钮、下拉、Modal 的局部紧凑样式。
- `apps/admin/src/features/shared/SectionCard.tsx`：增加可选 compact 外观，默认保持工单原样。
- `apps/admin/src/pages/SubscriptionsPage.tsx`：启用 compact 容器，收紧旧卡片圆角，统一操作色。
- `apps/admin/src/features/customers/TeamEditors.tsx`：补表单作用域、负责人搜索和成员限制。
- `apps/admin/src/features/customers/team-owner-options.ts`：新建/编辑团队共用的负责人选项规则。
- `apps/admin/src/features/editors/DrawerSections.tsx`：团队编辑使用同一选项规则。
- `apps/admin/src/features/nodes/AgentNodeCreateModal.tsx`：统一旧操作色。
- `apps/admin/src/features/nodes/InboundDeploySection.tsx`：统一旧提示色。
- `apps/admin/src/features/runtime-components/RuntimeComponentsPanel.tsx`：收紧兼容旧来源页面容器及按钮样式。
- `apps/admin/src/features/releases/ReleaseEditorModal.tsx`：强制更新复选框、最低版本及实际策略提醒；重新打开时重置编辑步骤。
- `apps/admin/src/features/releases/types.ts`：表单初始化、回填、创建和修改 payload 带上更新策略。
- `apps/admin/src/features/releases/ReleaseRecordCard.tsx`：删除无调用方的旧卡片实现。
- `apps/admin/src/pages/NodesPage.tsx`：分开展示服务器探测与客户端上报结果。

### 后端及契约

- `packages/shared/src/types.ts`：节点本机探测地址、管理端客户端探测汇总契约。
- `apps/api/prisma/schema.prisma`：新增每账号/节点一条最新探测记录及关联。
- `apps/api/prisma/migrations/20260915030000_client_node_probes/migration.sql`：新增表、索引、外键及状态/延迟约束。
- `apps/api/src/modules/client/report-node-probes.dto.ts`：上报批量数量、节点、状态和延迟校验。
- `apps/api/src/modules/client/client.controller.ts`：新增受鉴权保护的上报路由。
- `apps/api/src/modules/common/client-access.service.ts`：仅在授权节点列表下发探测端点；校验并保存客户端结果。
- `apps/api/src/modules/common/admin-node.service.ts`：聚合近 15 分钟客户端记录，不覆盖服务器探测数据。
- `apps/api/src/modules/common/admin-subscription.service.ts`：负责人必须已是本团队成员；事务中复核，清理原自动加入外部负责人的分支。
- `apps/api/package.json`：将新增回归加入发布验证入口。

### 客户端

- `apps/desktop/src-tauri/Cargo.toml`：显式启用已有 Tokio 的 net 功能，无新增依赖。
- `apps/desktop/src-tauri/src/node_probe.rs`：独立实现带整体超时、有限并发和多地址尝试的本机探测。
- `apps/desktop/src-tauri/src/lib.rs`：连接/断开工作线程、端口就绪检测、取消守卫；移除旧串行探测及阻塞外网自检。
- `apps/desktop/src/lib/runtime.ts`：本机探测命令桥接，网页预览明确不支持 TCP 检测。
- `apps/desktop/src/api/client.ts`：上报本机结果，删除客户端旧代测调用函数。
- `apps/desktop/src/hooks/useNodeProbe.ts`：本机检测、异步上报、重复提交防护、账号变化丢弃旧结果。
- `apps/desktop/src/components/NodeListPanel.tsx`：显示本机延迟；不回退显示后台延迟。
- `apps/desktop/src/hooks/useAuthBootstrap.ts`：远端退出请求不阻塞本机凭据清理和登录界面。
- `apps/desktop/src/hooks/useRuntimeActions.ts`：异步远端断开、移除重复刷新；账号变化时拒绝迟到连接结果。

### 回归与记录

- `apps/admin/test/releases.regression.ts`：更新策略保存和旧发布组件清理后的真实样式契约。
- `apps/admin/test/admin-appearance.regression.ts`：真实主题继承、工单隔离及团队负责人选项。
- `apps/api/test/admin-critical-routes.regression.ts`：新接口鉴权、正常上报、非法值和超限批次校验。
- `apps/api/test/client-node-probes.regression.ts`：授权、写入、无效结果拒绝、汇总窗口。
- `apps/api/test/team-owner-membership.regression.ts`：外部成员拒绝、事务内成员消失及成功转移。
- `apps/api/test/dev-data.service.regression.ts`：调整原负责人转移并发夹具以符合成员限制。
- `apps/desktop/test/logout-responsiveness.regression.ts`：真实 hook 在远端请求未完成时仍完成本机退出。
- `apps/desktop/test/connection-race.regression.ts`：真实主连接操作的重复点击防护及退出后的迟到响应。
- 本文：样式排查、逐文件改动、待办和验证边界。

## 验证

已通过：

```bash
npm --prefix packages/shared run build
npm --prefix apps/api run db:generate
npm --prefix apps/admin run check
npm --prefix apps/desktop run check
npm --prefix apps/api run check
npm --prefix apps/admin run build
npm --prefix apps/desktop run build
/Users/a1234/.cargo/bin/cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
/Users/a1234/.cargo/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
git diff --check
```

Rust 库测试 14 项通过，包含真实本机 TCP 监听及关闭端口检测。

定向 TypeScript 回归使用：

```bash
node node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs --tsconfig <应用>/tsconfig.json <测试文件>
```

通过文件：`releases`、`admin-appearance`、`logout-responsiveness`、`admin-critical-routes`、`client-node-probes`、`team-owner-membership`、`dev-data.service`、`runtime-release-contract`、`connection-race`。

隔离 PostgreSQL 使用临时数据目录及私有 Unix socket，执行新迁移、插入/更新、非法值、外键和级联删除检查后停止并删除实例。只验证新增表与约束，不冒称生产升级或全量迁移验证。

未执行：浏览器截图（用户负责视觉验收）、真实 Windows 运行、用户网络下连接/断开计时、生产安装/迁移、真实多用户上报 E2E。Vite 仍提示大于 500kB 的产物和客户端静态/动态 import 混用；Rust 有既有平台条件下未使用代码警告。

生产构建没有 Mock、调试按钮或模拟下载入口；测试替身在 test 目录，后续新增模拟窗口独立放在 DEV 门禁后的 dev 目录，详见进度条交接文档。

## 连接占用提示前置修复（2026-09-15）

- `apps/desktop/src-tauri/src/lib.rs`：新增只读 check_network_conflict 命令，工作线程执行现有系统 VPN/代理检测，等待预算 3 秒；不停止进程、不修改代理。真正连接前保留原二次检查。
- `apps/desktop/src/lib/runtime.ts`：新增本机预检桥接；macOS/Windows 调用，网页/Android 维持原路径。
- `apps/desktop/src/hooks/useRuntimeActions.ts`：所有连接路径先占用预检再准备组件/请求后台；冲突立即展示并结束操作。删除主按钮提前下载组件的重复路径；二次检测冲突也先提示，再清理。错误路径后台断开改为异步，不拖住提示。
- `apps/desktop/test/connection-race.regression.ts`：覆盖预检冲突不请求后台、不下载组件、不清理他人代理；保留重复点击与退出后迟到响应回归。

验证：desktop check、Rust cargo check、connection-race / connection-guidance 定向回归、git diff --check 通过；start-app.sh 重建原生预览供用户测试。未改变样式，未操作其他 VPN，未进行视觉验收或真实 Windows 运行。实际 OS 检测仍取决于系统命令是否能识别对应 VPN/代理；超时会明确报错，不继续发起连接。
