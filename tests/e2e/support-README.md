# 独立工单站点与真实客户端联调

这些文件只供测试使用，生产代码不导入它们，不增加配置接口或绕过原生工单权限。

## 协议与单元验证

```sh
node --test tests/e2e/support-provider.test.mjs tests/e2e/support-isolation.test.mjs
```

`support-provider.mjs` 在回环地址提供真实 HTTP 服务，遵循 Go 服务端使用的 Basic 认证、`data.launchUrl` / `expiresAt` 响应和未读查询接口。票据随机生成、只保存摘要、60 秒有效，放在 URL 片段中，由页面使用 POST 兑换；并发兑换只能成功一次。兑换后使用 HttpOnly / SameSite=Strict 会话 Cookie，票据和会话不写日志。

`support-portal.html` / `support-portal.js` 是中文测试门户：真实兑换成功后发送 `achord-connect-v1` 的 `ready`；按钮发送 `unread-changed`、`session-expired` 和 `close-requested`。页面先移除地址片段，再发起请求，不把票据显示到页面。样式仅存在于该测试页面，无生产 CSS 修改。

门户另有明确的“下次打开延迟 3 秒”测试按钮：只有已兑换的当前会话能安排，且只延迟当前联系人的下一次真实票据签发，不延迟其他联系人、不接受任意延迟参数。等待结束才生成票据，所以票据仍有完整 60 秒寿命。HTTP 调用方取消、超时或停止 provider 时会清理定时器，不会迟到签发票据。

上述协议测试使用真实本机 HTTP；它们不等于已经验证 MyGo Page、原生消息桥或客户端正常鼠标点击路径。

## 准备及启动隔离服务

```sh
# 只生成独立临时目录、随机密钥和三个待用端口，不启动数据库/API/GUI。
node tests/e2e/support-isolation.mjs --prepare

# 核对上一步计划后显式启动；不要替换为现有 3100 / 55437 端口。
node tests/e2e/support-isolation.mjs --start /absolute/path/to/support-isolation-plan.json
```

启动器复用本地已构建的 Go 服务端，但使用全新临时 PostgreSQL 集群，库名仍为 `chordv_mygo_local`，端口与根目录均独立；启动后再次校验实际 `data_directory`。只在新集群创建随机管理员与客户端账号、真实 personal 套餐和 1 小时有效的 1GB 订阅，再通过真实管理接口启用本机 provider。必须用客户端完成真实登录、bootstrap 读取并校验有效个人订阅、退出该次测试登录后，才输出 ready；仅凭 prepare 测试或账号创建成功不算准备完成。独立 API、provider、PostgreSQL 都只监听 `127.0.0.1`。不存在连接线上站点、读取现有 QA 账号或修改主数据库工单设置的路径。

启动输出仅包含端口、PID、桌面环境变量和 0600 凭据文件路径，不包含密码或令牌；实际账号在临时根目录的 `credentials.json`。门户未读按钮还会向独立 API 发送真实 HMAC 签名 webhook，覆盖服务端未读持久化及 SSE 更新。

## 正常鼠标路径与清理

先正常退出正在使用主数据库的 MyGo，再使用**同一个真实二进制**及启动器输出的 `CHORDV_API_BASE_URL`、`CHORDV_MYGO_DATA_DIR` 启动唯一 GUI。读取私有凭据，在登录界面正常输入客户端账号，鼠标点击原有工单入口。检查占位窗口、真实票据兑换后的独立门户、未读角标、已有窗口聚焦、会话过期后重开、关闭与取消；记录真实窗口截图，不能用直接调用原生命令代替正常点击的验收。

不要同时运行第二个主 GUI，不要把测试 provider 写进主数据库。测试完成后先正常退出隔离 GUI，再向隔离 supervisor 发 `SIGINT` 或 `SIGTERM`。它只停止自己持有的子进程，等待 PostgreSQL 退出后删除带专用 marker 的整个临时根目录；脱敏计数报告保存在 `output/local/support-e2e-report.json`。主 API、主数据库和宿主机代理不由这个启动器管理。

取消占位窗口的真实鼠标验收：先正常打开门户，点击“下次打开延迟 3 秒”，再点击“关闭工单窗口”；从客户端原有入口重新打开，3 秒内关闭原生加载窗口，等待真实签发结束后确认窗口没有复活；再点原有入口应正常打开，证明一次性延迟已消费。关闭原生加载窗口未必取消 HTTP 请求，这种情况下允许签发一个未兑换票据，但迟到结果不得复活窗口；它与 HTTP 取消/超时的测试是两个独立分支。
