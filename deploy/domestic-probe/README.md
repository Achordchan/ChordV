# 国内探针

一台中国大陆服务器每 5 分钟检查一次所有节点的端口能否连通，结果显示在后台「节点」页的连通性一栏（国内 可达 / 异常 / 被墙 / 未知）。

判定规则（后台 `apps/api/src/modules/domestic-probe/domestic-probe.policy.ts`）：

- 域名在国内本地解析，所有解析出的地址（最多 4 个）、3 轮握手里有 1 次成功就算可达。
- 8 路并发，每轮最多 200 秒；超时没测完的节点本轮不上报、状态不变。用文件锁防止两轮重叠。
- 一轮最多 200 个节点，后台下发和接收的上限一致；后台按「最久没测过」的顺序下发，被截止时间漏掉的节点下一轮优先。
- 节点 Agent 在线且连续 3 轮不通，才显示「被墙」；Agent 也离线时显示「未知」。
- 对照目标（百度、腾讯、阿里云）全部不通，或所有节点同时不通，整轮作废，不改任何节点。
- 超过 15 分钟没有新结果，显示「未知」。
- 端口能连通不代表 Reality 一定可用。

## 安装

1. 后台「节点」页 →「国内探针」→「生成令牌」。
2. 在探针服务器上：

```bash
install -m 755 chordv-domestic-probe.py /usr/local/bin/chordv-domestic-probe
install -m 600 /dev/null /etc/chordv-domestic-probe.env
printf 'CHORDV_API_BASE=https://v.achord.cn\nCHORDV_DOMESTIC_PROBE_TOKEN=<令牌>\n' > /etc/chordv-domestic-probe.env
printf '/var/log/chordv-domestic-probe.log {\n  weekly\n  rotate 4\n  compress\n  missingok\n  notifempty\n}\n' > /etc/logrotate.d/chordv-domestic-probe
echo '*/5 * * * * root /usr/local/bin/chordv-domestic-probe >> /var/log/chordv-domestic-probe.log 2>&1' > /etc/cron.d/chordv-domestic-probe
```

只依赖 Python 3 标准库和系统 `ping`。每轮耗时约几秒，资源占用可以忽略。
