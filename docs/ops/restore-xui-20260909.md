# 临时恢复 3x-ui 版本

日期：2026-09-09。用户明确要求暂停 Agent 改版，先恢复老用户临时使用。

本文是当次恢复记录，机器目录和备份位置保留原值，不作为当前部署方式说明。当前通用部署入口见 `README.md` 的 `deploy/backend`；历史目录名称不代表运行依赖。

## 当次运行状态

- 生产 API 和管理端已回退到 `0.0.8`，公开 readiness 返回 `ready / 0.0.8`，监督程序 last-good-version 同为 0.0.8。
- 管理端 `/usr/share/nginx/current` 指向 `releases/0.0.8/apps/admin/dist`。
- 3 个原 xui_primary 节点启用且面板可达，回退后 statsLastSyncedAt 已重新推进。
- 旧 direct 测试节点保留但禁用；失败的新 IIJ 接入节点保存在回退前数据库备份中，不带入旧版运行环境。
- 本次是生产运行环境回退，Git main 仍保留 0.0.10 修复代码，不能据仓库版本判断生产版本。

## 数据恢复方式

没有整库覆盖生产。先将退役前的自动备份恢复到临时数据库，再在当前数据库副本测试选择性恢复，旧版全部 36 个 Prisma 模型的列探测通过后才执行生产事务。

来源：`api-backups/pre-migrate-0.0.9-sysop_57d35eb215b7-20260909T024720Z.sql.gz`。

恢复范围：Node 的面板列及 XuiPanelStatus、PanelSyncJob 表；4 个旧节点、15 条订阅节点分配、45 条用户绑定、42 条计量基线，以及被级联删除的 Agent/命令/用量批次/会话/计量事件。修复 226263 条历史流量记录的 nodeId 关联及 922 条安全事件关联，不改流量金额或用户资产。

恢复事务前后，User、Subscription、Plan、Team、TeamMember 全行指纹一致；TrafficLedger（仅排除允许恢复的 nodeId）和 SecurityEvent（仅排除 nodeId/leaseId）指纹一致。事务时保留 17 个用户、8 个订阅、376775 条流量记录；服务恢复后的正常流量入账可继续增加记录。

私有备份、恢复 SQL、资产指纹及恢复日志位于 `/opt/chordv/deploy/1panel/chordv/ops-backups/20260909-restore-xui`。其中包括停机后的最终回退前数据库备份，含凭据的数据文件不得提交仓库。

## 验证与限制

- 旧版 schema 探测、资产指纹比对、readiness、监督程序稳定版本、管理端实际目录均通过。
- 3 个原面板可访问；CN2-GIA 和 DMIT 的活跃绑定与远端启用用户完全匹配。搬瓦工 10 条活跃绑定中 1 条在面板侧禁用，其订阅可使用其余两个节点；未擅自修改该面板状态。
- 6 个原业务订阅均有至少一个启用的 xui_primary 节点；2 个测试订阅没有可用节点，未擅自追加授权。
- 未使用真实客户端建立代理连接。节点 VPS 上的 ChordV 重启循环不会因后台回退自动停止，需在该节点停止 chordv-node-agent、chordv-xray-apply.path、chordv-xray-apply.service、chordv-xray.service；普通 xray.service 与 3x-ui 不在停止范围。

## 后续禁止直接重升旧改版包

本次为人工兼容恢复，保留了实际执行过的 Prisma 迁移历史和新增表列，没有伪造未执行状态。**不要直接再次升级 0.0.9 / 0.0.10**：其迁移已在历史中标记执行过，不能指望它们自动重新处理恢复后的旧节点。下一次改版须重新设计升级/恢复迁移并完成真实服务用户、systemd、节点注册、入站与客户端链路验收。

Agent 自动安装、重试状态和资源占用的进一步修改暂停，优先保障现有 3x-ui 业务。
