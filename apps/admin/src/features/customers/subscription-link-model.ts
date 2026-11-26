import type {
  AdminSubscriptionLinkDto,
  SubscriptionLinkDistributionDto,
  SubscriptionLinkPublicationStatusDto
} from "@chordv/shared";

export type LinkTone = "ok" | "wait" | "off";

/** Whether the customer can actually use the link right now, in words an operator acts on. */
export function describeLinkDistribution(distribution: SubscriptionLinkDistributionDto): { tone: LinkTone; label: string; hint: string } {
  if (distribution.state === "live") {
    return { tone: "ok", label: "已发布", hint: "客户端现在可以用这个链接更新订阅。" };
  }
  if (distribution.state === "pending") {
    return { tone: "wait", label: "等待发布", hint: "通常一分钟内完成。第一次发布完成前，客户端拿到的是“链接无效”的提示。" };
  }
  return { tone: "off", label: "未启用分发", hint: "后台还没有配置分发层，链接已签发但暂时无法访问。" };
}

/**
 * What became of the link a reset replaced. Only what the server has
 * confirmed is stated: a reset starts the revocation, it does not finish it.
 */
export function describeLinkRevocation(distribution: SubscriptionLinkDistributionDto): { tone: LinkTone; label: string } {
  if (distribution.state === "not_configured") {
    return { tone: "off", label: "未启用分发，后台不会从分发层撤销任何内容" };
  }
  if (distribution.revoking > 0) {
    return { tone: "wait", label: "正在撤销，完成前旧链接仍可使用。稍后点“刷新”查看结果" };
  }
  return { tone: "ok", label: "已从分发层撤销，各地缓存通常在一分钟内失效" };
}

/** What the customer's client will show after refreshing, as one sentence. */
export function describeLinkPreview(preview: AdminSubscriptionLinkDto["preview"]): string {
  if (preview.kind === "notice") return `客户端会显示一条提示：${preview.notice ?? "订阅不可用"}`;
  return `客户端会得到 ${preview.nodes.length} 个节点`;
}

export function describeDistributionStatus(status: SubscriptionLinkPublicationStatusDto): { tone: LinkTone; label: string } {
  if (!status.configured) return { tone: "off", label: "未启用：服务器上还没有配置分发层" };
  if (status.lastError) {
    const affected = [status.pending > 0 ? `${status.pending} 条链接未发布` : "", status.revoking > 0 ? `${status.revoking} 条旧链接未撤销` : ""].filter(Boolean);
    return { tone: "wait", label: `${affected.length ? `有 ${affected.join("、")}` : "上一轮对账出错"}：${status.lastError}` };
  }
  if (status.pending > 0) return { tone: "wait", label: `有 ${status.pending} 条链接正在发布` };
  if (status.revoking > 0) return { tone: "wait", label: `有 ${status.revoking} 条已重置或已删除的链接正在撤销` };
  if (!status.lastRunAt) return { tone: "wait", label: "已启用，等待第一次对账" };
  return { tone: "ok", label: "运行正常，所有链接都已发布" };
}

/** Said whenever records exist for a namespace other than the configured one; null when there are none. */
export function describeElsewhere(status: SubscriptionLinkPublicationStatusDto): string | null {
  if (!status.configured || status.elsewhere <= 0) return null;
  return `有 ${status.elsewhere} 条发布记录属于之前配置的分发层。那里已发布的内容不会再更新，也不会被撤销；如已不再使用，请在 Cloudflare 删除旧的 KV 命名空间。`;
}

/** Empty input means "not set"; anything else is sent as typed for the server to validate. */
export function normalizeOriginInput(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
