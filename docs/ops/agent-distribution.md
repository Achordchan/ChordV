# Agent 安装分发与现网修复记录

更新日期：2026-09-09。

**当次状态：用户要求临时回退，生产 API/管理端回到 0.0.8。本文保留当时的 0.0.10 分发修复、机器目录和备份位置，不代表后续运行状态，也不是当前部署说明；恢复证据见 `docs/ops/restore-xui-20260909.md`，通用部署入口见 `README.md` 的 `deploy/backend`。**

## 当前结果

- 后台修复代码：`c2ebfc0118e5af86aba01ed8f39243d1ae6b9eb4`，已进入 main。
- 后台版本：`0.0.10`，发布流水线 `34306551701` 全部成功，稳定清单与 Release 一致。
- 服务器运行版本及健康：公开 `/api/health/ready` 返回 `ready / 0.0.10`；无 pending/promoting 标记。
- 用户的面板升级已先完成。本次没有重复发起版本升级，仅通过现有 Compose 项目重建 API 容器，使新增分发环境变量和只读挂载生效；未重启 admin、PostgreSQL 或任何节点 VPS 服务。

## 部署位置与备份

现有宝塔反向代理保持不变，Compose 项目位于 `/opt/chordv/deploy/1panel/chordv`。

| 用途 | 宿主机相对目录 | API 容器目录 / 环境变量 |
| --- | --- | --- |
| Agent 与 Node 分发 | `api-agent-dist` | `/app/agent-dist`；`CHORDV_AGENT_DIST_DIR` |
| Xray 分发 | `api-xray-dist` | `/app/xray-dist`；`CHORDV_XRAY_DIST_DIR` |

两个目录均只读挂入 API。Compose、原环境文件和数据库导出保存在 `ops-backups/20260909-agent-distribution`（私有目录）；数据库 gzip 完整性检查通过，未执行数据库恢复演练。不要把环境文件、数据库导出或 SSH 凭据提交仓库。

面板文件更新只替换后台发布目录，不能替现有容器增加环境变量或挂载。首次启用分发需要更新 Compose 并重建 API；以后在宿主机原子发布安装包即可。

## 分发文件与版本

- Agent：Linux x64、ARM64 两份原生包，均经过 127 项测试。使用 Node 20.19.0 构建，含平台对应的 better-sqlite3 原生模块。
- Node：官方 20.19.0 Linux x64 / ARM64，先核对官方 SHASUMS256，再将 `bin/node` 打包供安装器下载。
- Xray：官方 v26.3.27 Linux x64 / ARM64，先核对 GitHub 发布文件摘要，再打包可执行文件。Node 和 Xray 均通过同一个 ChordV HTTPS 源分发。

```text
api-agent-dist/
  chordv-agent-linux-x64.tar.gz
  chordv-agent-linux-arm64.tar.gz
  node-20.19.0-linux-x64.tar.gz
  node-20.19.0-linux-x64.tar.gz.sha256
  node-20.19.0-linux-arm64.tar.gz
  node-20.19.0-linux-arm64.tar.gz.sha256
api-xray-dist/
  xray-linux-x64.tar.gz
  xray-linux-x64.tar.gz.sha256
  xray-linux-arm64.tar.gz
  xray-linux-arm64.tar.gz.sha256
```

Agent 打包仍使用 `apps/node-agent/deploy/build-release.sh` 和 `package-release.sh`，必须在相应 Linux 架构环境构建。准备了双架构 GitHub 工作流，但当前凭据缺少 workflow scope，GitHub 拒绝推送；该自动化未上线，不能宣称后续后台发布会自动生成或上传 Agent 包。

## 安装器的共存边界

- 缺少兼容 Node 时自动安装到 `/opt/chordv-node-runtime/v20.19.0/bin/node`，不覆盖系统 Node。
- 使用独立的 `/opt/chordv-xray/bin/xray`、`chordv-xray.service` 与默认管理端口 11085，保留既有 ChordV 配置里的管理端口并同步给 Agent。
- 不停止、替换或接管普通 `xray.service`、3x-ui 程序或配置。ChordV 专用服务名被占用时拒绝；检测到旧版 ChordV 使用通用 xray.service 时同样拒绝，要求明确迁移。
- 部署入站前检查监听端口，其他服务占用时拒绝，不通过停止原服务来释放端口。原服务占用 443 时，应在后台为 ChordV 选择其他空闲端口。

## 已验证与未验证

已验证：API/Agent 类型检查，direct 回归，自动 Node 安装及坏摘要拒绝，安装暂存回归，双架构 Agent 各 127 项测试；使用真实安装包的隔离容器检查确认原 Xray 文件和 10085 监听存活，专用 Node 可运行、专用 Xray gRPC 可用。隔离检查替代了 systemctl 调度，不是实际 systemd 或真实节点注册验收。

公网两个架构的 Agent/Node/Xray 下载均返回 200；实际下载的 x64 Agent 包 SHA-256 为 `2e957ff7441cd66e3a505081be7211e13a2d508298392dfc111310c304851bb1`，与上传文件一致。ARM64 包 SHA-256 为 `667c110300d6430dfafdb8e6ac8858c3f862f77c6df322cd3feeb0468199c0a3`。

未操作用户节点 VPS，尚未验证其实际系统兼容性、注册、入站部署、客户端连接和流量入账。下一步由用户在后台重新生成安装命令，在测试节点接入；不能把下载成功和容器共存检查当作所有服务器均完成验收。
