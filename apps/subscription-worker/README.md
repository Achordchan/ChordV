# ChordV 订阅链接分发（Cloudflare Worker）

第三方客户端（小火箭、v2rayN 等）刷新订阅时访问的就是这个 Worker。它只做一件事：
按链接里的 token 从 Workers KV 读出 ChordV 后台发布的订阅内容并原样返回。

- 只返回文本，不转发任何代理流量，不访问 ChordV 后台。后台宕机时订阅照常可刷新。
- 不记录请求，不提供列表接口。KV 的键是 `sha256(token)`，KV 里没有明文 token。
- token 不存在（包括已被重置）时返回一条提示节点，状态码仍是 200。
- KV 读取失败或内容无法识别时返回 503，让客户端保留现有节点，而不是把节点换成提示。

## 行为

| 请求 | 响应 |
| --- | --- |
| `GET /s/<token>`，KV 里有 | 200，正文是 Base64 的链接列表；带 `subscription-userinfo`（如有）和 `profile-update-interval: 6` |
| `GET /s/<token>`，KV 里没有 | 200，正文是一条“订阅链接无效或已重置”的提示节点 |
| KV 读取失败、内容版本不认识 | 503 |
| 其他路径 | 404 |
| 非 GET/HEAD | 405 |

所有响应都带 `cache-control: no-store`。

## 部署

1. 在 Cloudflare 建一个 KV 命名空间，把它的 ID 填进 `wrangler.toml` 的 `kv_namespaces`，
   同时填进后台的 `CHORDV_SUBSCRIPTION_KV_NAMESPACE_ID`。
2. 在 `wrangler.toml` 的 `routes` 里填订阅域名（自定义域名，不使用 workers.dev）。
3. `npx wrangler deploy`。
4. 建议给订阅域名加一条 WAF 限流规则（例如同一 IP 每分钟 30 次），防止枚举 token。
5. 不要开启 Workers Logs / Logpush：请求路径里就是订阅链接。

## 测试

```
pnpm --filter @chordv/subscription-worker test
```
