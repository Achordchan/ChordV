# 旧后端源码清理记录

2026-11-17，源基线 `397a64de9cc345049f886e64cc19f46d887f8304`。逐路径清单、原 SHA256、删除/归档动作及归档去向见 `legacy-backend-cleanup.json`。

## 实际范围

| 范围 | 移除的 tracked 路径数 | 处理 |
| --- | ---: | --- |
| `apps/api` | 212 | 旧 NestJS/Prisma 可运行入口、服务、测试和重复 SQL 去除；两个 schema 先逐字节归档为 `.snapshot`，不是丢弃 |
| `apps/node-agent` | 40 | 旧 TypeScript Agent 的源码、运行清单、部署脚本和旧测试去除 |
| `deploy/backend` | 7 | 旧 Dockerfile、Compose、entrypoint、Nginx/OpenResty 部署实现去除；用户新增 README 保留 |
| `scripts` | 15 | 旧 Node 后端打包/发布恢复、Prisma 基线、旧本地 Node 启动及其唯一旧测试链去除 |
| 合计 | 274 | 其中 2 个路径为先归档再移除原件，272 个为退役源码；没有操作 Git 索引 |

唯一可执行 SQL 迁移源是 `apps/server/internal/database/migrations/`：旧 27 份逐字节一致，新 Go 迁移独立保存。两个非运行结构快照位于 `legacy-schema/`；当前 Go 旧库接管只读取内嵌系统目录契约，不读取这些快照。

15 个旧脚本/测试为：`deploy-baota.sh`、`prepare-backend-bundle.mjs`、`local-runtime-bootstrap.sh`、`local-node-agent-dev.mjs`、`verify-api-release.mjs`、`verify-backend-release.mjs`、`verify-backend-release.test.mjs`、`prisma-migrate-with-baseline.mjs`、`prune-release-node-modules.mjs`、`test-file-management.py`、`install-panel-password-key.py`、`install-agent-token-pepper.py`、`prepare-release-storage.mjs`、`backend-release-resume.mjs`、`backend-release-resume.test.mjs`。

## 用户文件与运行资产保护

- 删除前来自 `git ls-files` 白名单；每个目标检查相对 HEAD 无 staged/unstaged 差异、是常规文件、读取期间 stat 未变化，再独立 unlink。跳过项 0。未使用 `rm -rf`、`git rm`、`git clean`，未提交或推送。
- 两个 schema 在移除原件前复制、重读并核验原 SHA256；归档目录原来不存在冲突文件。
- 实际 95 个 ignored 文件/链接的 inode、mode、size、mtime 在清理前后相同，仍被 Git 忽略。保留 API `.env`、`prisma/dev.db`、dist、node_modules，及旧 Node Agent 的本地状态/依赖；这些用户本机历史资产不纳入当前任何启动、构建、测试或发布入口，没有为了物理清空旧字节去删用户文件。
- 旧 Node Agent 子 `.gitignore` 的 data/dist/db-shm/db-wal 作用域规则先迁到根，再删除原文件。当前根文件的其他已有改动保留。
- 本任务未触碰 `apps/desktop/src-tauri`、根 package/lock 或公告实现；桌面清理由独立任务负责。用户新增 `deploy/backend/README.md` 保留未覆盖，文案同步由主流程处理。

## 活跃依赖脱钩

`apps/admin/test/agent-node-onboarding.regression.ts` 不再导入旧 Nest 服务。它使用实际前端 SSE parser 和实际 onboarding watcher 验证 Go 线协议夹具的 CRLF/分片/游标与重连补读；夹具仅在测试中，实际 Go HTTP 重放/resync 由 `apps/server/internal/api/events_test.go` 独立验证，不把夹具冒充真实服务。

清理后扫描 `.github`、`scripts/mygo-*`、当前 Go/React、共享包及 e2e：没有旧 API/Node Agent import、文件读取或工作区 filter。Go Agent 的源流注释/README、明确退役的历史检查清单仍可提到旧路径；`legacy-routes.json` 与本清单的旧路径是追踪资料，不是运行依赖。已有本地 Go 兼容别名保留。

`scripts/agent-migration` 继续作为独立离线 JSON 历史对账工具保留，不启动服务、不访问网络、不读取运行凭据；README 已改为根 `pnpm exec tsx`，不依赖被删除的 API 工作区。

## 验证

- 管理后台类型检查通过；现有 27/27 `.regression.ts` 回归通过，包括迁移后的 onboarding 测试。
- Go Agent 全部 15 个包 `test -race ./... -count=1` 及 `vet ./...` 通过，不依赖被删除的 Node Agent。
- 第一轮 Go 服务端 race 抓到旧工单竞态测试的夹具隔离问题：provider 误把其他用户的后台校准请求当成目标 barrier；已改为仅阻塞该测试 uid 的确切 HTTP 路径，没有改生产 CAS 算法。同时将已完成重置的重复后台任务按“记录已消失”幂等退出，避免清理时无意义退避噪音。
- 上述工单/重置两组 `-race -count=10` 复验通过（48.232 秒，无 race 报告）。清理后最终 Go 服务端全量 `test -race ./... -count=1` 通过：API 81.422 秒、config 1.706 秒、database 8.758 秒；`vet ./...` 通过。`git diff --check` 和活跃引用扫描通过，索引仍未变化。

未执行生产部署、旧生产数据库接管、正式 release 重建或桌面平台发布；清理不等于线上已迁移。布局未发生变更，本任务只修改管理后台测试，没有修改 UI/CSS。
