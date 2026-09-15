# 文件管理改造交付（2026-09-15）

状态：当前分支上的代码已完成验证，未提交、未开 PR、未部署。此前客户端和后台改动保持原样；本次没有访问生产数据库或执行生产文件清理。

## 新入口与行为

1. 发布中心 → 管理安装包：显示当前所有文件、来源、大小、Hash、更新入口；已发布记录只读。草稿中的“替换此文件”保持原 artifact ID，“新增 / 复用安装包”才创建新记录。
2. 安装包编辑 → 已有文件：选择同平台的已托管文件；服务器验证实际大小和 Hash，复用时不重新下载。Windows 仍执行既有完整 ZIP / 版本校验。
3. 运行组件 → 已保存的历史文件：分页查看、启用历史文件、删除符合条件的非使用版本。重复获取已经准备好的固定来源/版本会返回已有记录。
4. 系统设置 → 文件与存储：SSE 扫描，显示引用、大小、硬链接节省、磁盘可用空间、缺失文件、待清理/失败任务；文件清单和清理任务均支持分页。可单项或按页清理，并重扫确认实际空间。可跳转图床附件管理。

## 数据与清理策略

- 安装包记录新增 sourceUrl，保存原始获取地址；外链旧记录从 downloadUrl 回填。历史已托管但未保存来源的文件不猜测来源，仍可查看/复用实际文件。
- sourceUrl 仅在管理端 DTO 中返回，客户端更新描述不包含它，防止来源带临时签名或私有查询参数时泄漏。
- 相同文件 Hash 和大小可尝试硬链接去重：文件路径各自独立，物理内容共享，删除一个路径不破坏其他版本。候选文件在复用前再次校验；不支持去重时保留已验证的新独立副本。
- 同一发布的相同内容重复提交不会不断增加记录；已有同内容记录的文件缺失/损坏时，用新文件修复该记录。
- 上传/替换最终提交时重新锁定发布记录并复核草稿状态。删除和来源切换也在锁内读取最新引用路径，避免并发替换后只清理旧快照路径。
- FileCleanupJob 与记录删除/替换在同一事务写入；物理删除由后台任务执行。数据库回滚不会留下“记录还在但文件已经被删除”的情况。
- 每分钟处理可执行任务，清理前重新查询引用。失败保存 lastError 和 attempts，退避重试；手动重试幂等。越界路径登记为 blocked，不自动删除；符号链接也不会跟随删除。
- 只扫描并清理明确托管路径、有所有权前缀的临时文件。新建硬链接按 ctime/mtime 保护，不因继承旧 mtime 被误当旧垃圾。历史裸 UUID 临时文件归属不明，展示但不自动删除。
- 每日孤立文件恢复扫描有 24 小时保护期；存在无法解析的引用路径时暂停孤立文件清理，先报告问题。显式删除记录生成的任务不必等待 24 小时。
- 运行组件自动保留当前使用、全局最新 20 条记录及 30 天窗口。retainUntil 在版本切换时更新，避免运行数月的旧版本刚停用就被删除；历史已分发记录迁移时也有 30 天宽限期。
- 后台系统版本和数据库快照由已有回滚策略管理（默认 3 个版本、5 份快照），总览只统计并提示，不提供无保护的文件删除按钮。
- 图床附件与本机托管文件不是同一个存储后端。保留原图床管理和未提交附件清理流程，未修改工单界面。

## 本轮文件清单

### 后端

- `apps/api/prisma/schema.prisma`：sourceUrl、FileCleanupJob、retainUntil 及索引。
- `apps/api/prisma/migrations/20260915140000_file_management/migration.sql`：新增结构及保守回填。
- `apps/api/src/modules/common/storage-files.ts`：路径边界、符号链接保护、Hash、删除与孤立文件命名范围。
- `apps/api/src/modules/common/file-maintenance.service.ts`：持久清理队列、引用复核、失败退避、硬链接去重和已有文件暂存校验。
- `apps/api/src/modules/common/storage-catalog.service.ts`：文件/目录统计、引用和缺失检测、分页查询、SSE 扫描数据、孤立文件恢复。
- `apps/api/src/modules/admin/storage.controller.ts`：管理员鉴权下的扫描、查询、清理、重试和文件复用接口。
- `apps/api/src/modules/admin/admin.module.ts`、`apps/api/src/modules/common/dev-data.module.ts`：注册控制器及服务。
- `apps/api/src/modules/common/release-center.service.ts`：复用/去重、原始来源记录、准备失败清理、事务内最新引用及清理任务，删除旧后台清理回调链。
- `apps/api/src/modules/common/release-center.utils.ts`：来源 DTO 控制；删除函数不再吞掉所有错误。
- `apps/api/src/modules/common/runtime-version.service.ts`：已有版本复用、历史查询/删除、切换保留期、先事务后物理删除。
- `apps/api/src/modules/admin/runtime-version.controller.ts`：历史分页与删除路由。
- `apps/api/src/modules/common/runtime-components.service.ts`：旧组件文件也接入队列；修复准备失败路径，保留异常路径记录。
- `apps/api/src/modules/admin/admin.controller.ts`、`apps/api/src/modules/client/client.controller.ts`：新上传临时文件添加所有权前缀，便于安全回收。
- `packages/shared/src/types.ts`：管理端安装包来源字段，客户端不暴露该字段。

### 管理界面

- `apps/admin/src/pages/SystemSettingsPage.tsx`：文件与存储入口。
- `apps/admin/src/features/storage/StorageManager.tsx`：文件清单、引用、占用、扫描进度及清理/失败任务入口。
- `apps/admin/src/features/storage/StorageManager.module.css`：局部响应式样式，无全局 CSS 污染。
- `apps/admin/src/features/storage/storage-api.ts`：SSE 扫描解析与查询契约。
- `apps/admin/src/features/releases/ReleaseFilesModal.tsx`：已有文件管理窗口。
- `apps/admin/src/features/releases/ArtifactEditorModal.tsx`：当前文件信息和已有文件选择。
- `apps/admin/src/pages/ReleasesPage.tsx`：管理、新增、替换、复用明确分流；删除反馈改为文件进入清理队列。
- `apps/admin/src/features/releases/ReleaseOverview.tsx`：修复“管理安装包”误指向新增的入口。
- `apps/admin/src/features/releases/ReleaseEditorModal.tsx`：删除无调用的旧安装包入口参数。
- `apps/admin/src/api/client.ts`：来源字段映射。
- `apps/admin/src/features/runtime-components/ComponentHistory.tsx`：已保存历史文件分页、启用与删除。
- `apps/admin/src/features/runtime-components/ComponentDeliveryPage.tsx`、`apps/admin/src/api/runtime-versions.ts`：历史入口、复用反馈及保留期字段。

### 验证与记录

- `apps/api/test/file-management.integration.ts`：真实 PostgreSQL 与真实临时文件的核心流程。
- `scripts/test-file-management.py`：自动创建独立 PostgreSQL 集群，执行完整迁移链和集成测试，结束后清理。
- `apps/api/test/storage-routes.regression.ts`：管理接口鉴权、DTO 与 SSE。
- `apps/api/test/dev-data.service.regression.ts`：旧夹具更新为事务提交后执行清理，增加最新引用读取的正确时序。
- `apps/api/test/component-release-safety.regression.ts`：孤立清理由统一服务负责，旧版本清理不直接删孤立文件。
- `apps/api/test/runtime-components.service.regression.ts`：删除事务夹具更新。
- `apps/api/test/release-artifact-import-service.regression.ts`：临时文件清理走统一服务。
- `apps/api/package.json`：新增回归及独立集成测试命令。
- `scripts/verify-api-release.mjs`：修复中文工作区 URL 解析及包管理器调用；等待所有测试结束后汇总错误。
- `apps/desktop/src/styles.css`：完整回归发现此前进度面板层级与工单遮挡保护不一致，恢复既有 z-index 320；没有改工单界面。
- `README.md`、本文：操作说明、迁移与验收边界。

## 验证结果

已通过：

```bash
npm --prefix packages/shared run build
npm --prefix apps/api run db:generate
npm --prefix apps/api run check
npm --prefix apps/admin run check
npm --prefix apps/admin run build
node scripts/verify-api-release.mjs
python3 scripts/test-file-management.py
git diff --check
```

完整发布回归：73 条测试命令全部通过，包含管理员鉴权、发布、组件、工单兼容、客户端状态及系统更新回滚测试。

隔离 PostgreSQL 集成验证：完整迁移链、真实文件硬链接、重复记录去重、缺失文件修复、来源字段不下发客户端、删除原文件后复用仍可读、引用保护、越界/符号链接保护、失败任务重试、准备失败清理、发布状态竞态保护、历史保留、事务回滚不删文件、孤立文件清理及退役兼容保留期。

布局检查：新界面仅使用已有后台组件和局部 CSS，检查了长路径换行、表格横向滚动、模态框宽度和分页；按用户要求未操作浏览器或做截图验收。未引入新生产依赖；测试替身仅在 test 文件中，生产没有 Mock 数据。

未执行：生产迁移、生产磁盘扫描/删除、真实服务器权限和存储介质验证、用户视觉验收。因此不能报告已释放多少生产空间。Vite 仍有已有的大包提示；部分 PostgreSQL专项测试若缺少各自专用数据库变量，按原测试规则跳过，不能把 73 条命令通过解释为所有生产场景均已实测。

## 上线顺序

先备份数据库并部署包含新迁移的后台，再验收“文件与存储”的扫描结果和清理队列。检查 CHORDV_RELEASE_STORAGE_ROOT、CHORDV_SYSTEM_RELEASES_DIR、CHORDV_SYSTEM_UPDATE_BACKUP_DIR 是否指向正确持久目录。文件名归属不明、路径异常、符号链接均保持保护；不要为了释放空间跳过引用检查或直接清空存储目录。

## PR #53 首轮审查修复

- `runtime-version.service.ts`：复用前在事务外校验实际大小及 SHA256，事务内复核记录身份；损坏文件重新排队获取。
- `release-center.service.ts`：重复安装包保留记录 ID，改指向准备阶段已校验的新路径，旧路径事务内登记清理；移除持锁期间的大文件哈希。
- `file-maintenance.service.ts`：去重候选的路径解析纳入异常处理，非法旧路径不再阻断有效新文件保存。
- `storage-catalog.service.ts`：逐项处理临时文件消失和读取失败，扫描不中断，非 ENOENT 错误保留说明。
- `ComponentHistory.tsx`：每次展开重新读取，并提供刷新历史操作；未修改通用样式。
- `file-management.integration.ts`：新增同大小损坏、非法候选和临时文件消失回归；更新重复导入后的路径断言。

隔离 PostgreSQL 完整迁移和真实文件集成测试通过；API/admin 类型检查通过。没有新增生产 Mock、依赖或旧实现并行入口；视觉、Windows 实机和生产环境验证边界不变。

## PR #53 第二轮审查修复

- `schema.prisma`、`20260915160000_shared_storage_catalog/migration.sql`：新增独立扫描快照表。
- `storage-catalog.service.ts`：扫描结果和文件路径映射原子写入数据库；按托管目录标识读取，移除进程内快照依赖，列表和清理使用各自读取的完整快照。
- `file-management.integration.ts`：通过新建独立服务实例读取扫描并清理，验证请求切换实例仍能工作。多实例仍须访问同一实际托管文件系统；独立服务器的磁盘不会因此共享。
- 客户端 `App.tsx`、`useRuntimeAssets.ts`、`useUpdateFlow.ts`：移除旧本地镜像的状态、读取、传递及重试写入，启动清除历史缓存。下载继续使用服务端分发地址。
- `unified-download-panel.regression.ts`：增加旧本地镜像不再进入下载流程的回归检查。

验证：Prisma generate、API/desktop 类型检查、隔离 PostgreSQL 全量迁移及真实文件集成测试、storage-routes / unified-download-panel / runtime-assets-state / update-center 定向回归均通过；没有新增样式或生产 Mock。上一轮 73 条完整回归通过，本轮按变更范围执行定向验证。

## PR #53 旧外链兼容范围修正（最终行为）

复核后区分后台全局镜像退役与旧外链客户端兼容，撤销上一节“启动清除历史缓存”的做法：保留已有本地镜像，仅由原有 allowClientMirror 策略决定是否应用，托管固定版本继续忽略覆盖。

- `App.tsx`：读取历史配置，提供明确的清除操作；不恢复镜像编辑表单。
- `useRuntimeAssets.ts`、`useUpdateFlow.ts`：旧外链继续接受获准的历史覆盖；清除后失败的更新包缓存失效并重新获取元数据，避免再次使用已解析的旧镜像 URL。
- `DownloadProgressPanel.tsx`、`RuntimeAssetsBanner.tsx`、`ClientUpdateProgressPanel.tsx`：仅失败且存在历史镜像时，在展开的详情内提供“清除旧下载镜像”；正常下载不新增入口，使用已有局部样式和按钮。
- `unified-download-panel.regression.ts`：覆盖兼容读取及条件清除入口。desktop check、unified-download-panel、runtime-assets-state（包含托管版本忽略镜像覆盖）、update-center 回归通过。

此修正不恢复后台全局镜像设置，不新增生产 Mock；未执行浏览器视觉验收及 Windows 实机测试。

## PR #53 引用别名保护与跨文件系统复用

- `storage-files.ts`：新增真实路径规范化，内部别名映射回托管目录命名空间；越界或不可读引用明确报错。
- `storage-catalog.service.ts`：引用索引异步解析真实路径，并同时保护组件记录中的已保存路径；无法安全解析时暂停孤立文件清理。
- `file-maintenance.service.ts`：快速字面引用查询未命中时，对已保存引用进行真实路径复核，防止通过别名引用的物理文件被删除；暂存硬链接遇到 EXDEV 时使用独占复制，复制后再次验证大小和 Hash，失败仍清理或入队。
- `file-management.integration.ts`：真实目录符号链接的扫描/删除保护，以及注入 EXDEV 后的真实复制验证。

API check、隔离 PostgreSQL 全部迁移与真实文件集成、dev-data / release-artifact-import-service / runtime-components-service / component-release-safety / storage-routes 五组定向回归及 diff 检查通过。跨文件系统错误通过注入验证，未挂载实际第二块磁盘；本轮无 UI、依赖或生产 Mock 改动。

## PR #53 重复交付元数据与清理批次索引

- `release-center.service.ts`：相同内容复用记录也写入已验证的 deliveryMode、isFullPackage、托管镜像策略及显式主包设置，不保留过时交付元数据。
- `file-maintenance.service.ts`、`storage-catalog.service.ts`：每个清理批次建立共享真实路径引用索引；删除前继续进行即时字面引用查询，并增量读取批次开始后更新的引用，避免每个候选重新读取全部路径。
- `schema.prisma`、`20260915163000_file_reference_indexes/migration.sql`：为三类引用记录的 updatedAt 增量查询添加索引。
- `file-management.integration.ts`：覆盖重复内容交付元数据修复、批次创建后新增别名引用保护。

Prisma generate、API check、独立 PostgreSQL 完整迁移及真实文件测试、dev-data / release-artifact-import-service / runtime-components-service / component-release-safety 回归通过。没有界面、依赖或生产 Mock 改动，未执行真实生产磁盘负载测试。

## PR #53 异常引用诊断与本地来源修复

- `file-maintenance.service.ts`：逐条捕获引用解析异常，索引保留诊断；能确认引用的任务正常处理，无法确认安全性的未引用任务在各自错误处理内写入 lastError、attempts 和 nextAttemptAt，不再静默退出整个批次。
- `release-center.service.ts`：本地上传重复内容也明确写入 sourceUrl=null，避免旧远程来源残留。
- `file-management.integration.ts`：验证异常引用导致任务可见失败及退避、修复引用后重试成功，以及本地重复上传清除来源。

API check、完整迁移和真实文件集成、dev-data / release-artifact-import-service 回归及 diff 检查通过。布局无变化，无新增 Mock；生产验证边界不变。

## PR #53 前端扫描全程超时

- `apps/admin/src/features/storage/storage-api.ts`：合并用户取消和 10 分钟超时信号，传入扫描请求，覆盖响应头等待和整个流读取过程。
- `apps/admin/test/storage-scan.regression.ts`：执行实际扫描函数，分别验证请求头等待、流读取停滞时的超时与用户取消，共四种路径；使用可控 AbortController，不实际等待十分钟。

admin check、storage-scan 定向回归和 diff 检查通过。无布局、依赖、生产 Mock 改动；未进行浏览器视觉验证。

## PR #53 排队连接的退出竞态

- `apps/desktop/src-tauri/src/connection_generation.rs`：原子连接代次，支持捕获、失效和阶段检查；新增真实工作线程排队取消与准备阶段取消测试。
- `apps/desktop/src-tauri/src/lib.rs`：连接任务入队前捕获代次，工作线程获取运行时锁后及初始化/启动后续阶段复核；断开请求、实际清理及运行时关闭均使旧代次失效，覆盖退出先完成、旧连接任务后启动的时序。

cargo test --lib 16 项通过（包含两项新增竞态用例）；connection-race、connection-guidance 及 diff 检查通过。未改变布局或增加 Mock/依赖；测试验证排队代次机制，不冒充 Windows 实机或真实系统代理端到端验收。

## PR #53 后端扫描取消检查

- `storage-catalog.service.ts`：用户取消/截止信号贯穿引用解析、缺失文件核对、附加目录、临时文件遍历及快照写入前，取消后不再继续保存结果。
- `file-management.integration.ts`：在真实引用解析和临时文件读取时注入取消，确认快照保持不变、扫描忙碌标记释放、随后可以再次扫描。

API check、隔离 PostgreSQL 完整迁移和真实文件集成及 diff 检查通过；无布局、依赖或生产 Mock 改动。已经进入单次文件系统/数据库调用的操作仍需等待该调用返回，检查点阻止后续工作。
