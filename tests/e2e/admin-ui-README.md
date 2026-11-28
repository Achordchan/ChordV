# 后台任务与历史工单的独立 UI 联调

此组合入口只供本地验收，复用 `support-isolation.mjs` 的临时 PostgreSQL / Go API / 凭据及清理机制，不增加生产配置旁路、不读取主 QA 账号，不启动 GUI 或 Vite。

## 准备与启动

```sh
node tests/e2e/admin-ui-isolation.mjs --prepare
```

核对输出中的四个独立回环端口后，用输出的 `planFile` 显式执行 `--start`。prepare 只写临时计划和随机凭据，不启动服务；start 才初始化独立数据库、启动测试 API 和本机图床。主 `3100` / `55437` / `5174` / `5173` 不使用。

ready 输出提供 `CHORDV_DEV_API_TARGET`、`CHORDV_ADMIN_PORT`。由主流程单独用这两个环境变量启动现有 admin Vite，不改根 `.env` 或主 `frontend-env`；API 的允许来源同时使用这个临时后台端口。浏览器使用新 context，避免同为 127.0.0.1 的不同端口共享 Cookie。管理员账号只在 0600 的 `credentials.json`，图床 API/control token 只在独立 0600 文件，不打印。

## 数据与证据边界

新库通过真实管理 API 创建两个测试用户、1GB 个人订阅，关闭新工单接入，通过真实客户 API 创建一张历史工单，并通过管理接口验证其可读。图床配置仅指向本机 `image-provider.mjs`；图床本身的真实 PNG 校验和失败模式由其独立协议测试覆盖。

两个节点先由既有真实 Xray Core helper 和生产 Agent 注册、校验本机 Reality 入站。节点 A 的两条不同用户绑定由实际订阅授权与服务端逻辑创建，并由真实 Agent 完成账号安装；初始化后明确停止 Agent，不合成后续回执，使 UI 点击重试后产生的新 pending 命令真实保留。

**只有重试耗尽的 cancelled 行是显式 SQL 夹具**：节点 A 各一条 ENSURE_USER / ENABLE_USER，来源是实际完成命令的绑定及载荷；节点 B 一条 REFRESH_QUOTA，只能标记已处理。任务错误文案明确标注“仅 UI 夹具，不代表物理 Agent 故障”。SQL、明确 UUID 和来源命令 ID 保存在临时根目录的审计文件。node/binding/user/subscription 状态不以 SQL 伪造。

ready 前验证真实管理队列 jobs/summaries、retryable/dismissible、修订号字符串和历史工单读取。这个环境证明真实 UI → HTTP → DB/SSE 合同，不替代已经单独执行的物理 Agent 数据/计量整链，也不把夹具任务称为真实故障。

## 图床控制与清理

图床模式控制按 `image-README.md` 的真实测试控制接口执行，凭据只从私有文件读取。上传成功、HTTP 503、超时、取消需从正常 UI 操作验证；不能用 provider 单元测试代替 UI 结果。

UI 测试完成后主流程先停止自己启动的 Vite / 浏览器，再向组合 supervisor 发 SIGINT 或 SIGTERM。入口只停止自有 Xray helpers、图床、API 和独立 PostgreSQL，删除临时集群及所有私有凭据，保留脱敏 `output/local/admin-ui-e2e-report.json`；不结束主 API 或主数据库。
