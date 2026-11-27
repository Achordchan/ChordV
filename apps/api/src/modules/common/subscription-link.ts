import { createHash, randomBytes } from "node:crypto";

/**
 * Subscription links for third-party clients (Shadowrocket, v2rayN): what a
 * link's token is, and what the link returns.
 *
 * Everything here is a pure function of its arguments. What a user is entitled
 * to is decided by the caller from the database; this file only turns that
 * decision into the text a client downloads, so the same input always yields
 * byte-identical output — the distribution layer publishes on change, and a
 * document that differed between two renders of the same state would be
 * republished forever.
 */

/** 32 random bytes, base64url: 43 characters of [A-Za-z0-9_-]. */
export function generateSubscriptionLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isSubscriptionLinkToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** What the distribution layer keys a link by. It never holds the token itself. */
export function hashSubscriptionLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function buildSubscriptionLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/s/${token}`;
}

export type SubscriptionLinkNode = {
  nodeId: string;
  name: string;
  serverHost: string;
  serverPort: number;
  /** The user's own credential on this node (PanelClientBinding.panelClientId). */
  uuid: string;
  flow: string;
  realityPublicKey: string;
  shortId: string;
  serverName: string;
  fingerprint: string;
  spiderX: string;
  mldsa65Verify?: string | null;
};

/**
 * Why a link has no nodes to give. Each one is shown to the user as the name of
 * the single placeholder entry, so they are sentences a customer can act on.
 */
export type SubscriptionLinkNoticeReason =
  | "account_disabled"
  | "no_subscription"
  | "team_disabled"
  | "subscription_expired"
  | "subscription_exhausted"
  | "subscription_paused"
  | "no_nodes";

export const SUBSCRIPTION_LINK_NOTICES: Record<SubscriptionLinkNoticeReason, string> = {
  account_disabled: "账号已停用，请联系客服",
  no_subscription: "暂无可用订阅，请联系客服",
  team_disabled: "团队已停用，请联系客服",
  subscription_expired: "订阅已到期，请联系客服续费",
  subscription_exhausted: "流量已用完，请联系客服",
  subscription_paused: "订阅已暂停，请联系客服",
  no_nodes: "暂无可用节点，请稍后更新订阅"
};

/**
 * What an unknown or reset token gets. Deliberately not one of the reasons
 * above and deliberately the same for both cases: whether a token ever existed
 * is not something to tell whoever is asking.
 */
export const SUBSCRIPTION_LINK_INVALID_NOTICE = "订阅链接无效或已重置，请联系客服获取新链接";

export type SubscriptionLinkUsage = {
  usedBytes: bigint;
  totalBytes: bigint;
  expireAt: Date;
  /** 设了每月重置日时的下次重置时间：此时 totalBytes 是每月额度。 */
  nextResetAt?: Date | null;
};

export type SubscriptionLinkDocument = {
  kind: "nodes" | "notice";
  notice: string | null;
  nodes: Array<{ nodeId: string; name: string }>;
  /** The response body: the share links, one per line, base64-encoded. */
  body: string;
  /** Value of the `subscription-userinfo` response header, or null when there is no subscription to describe. */
  userinfo: string | null;
  /** The figures `userinfo` was written from. */
  usage: SubscriptionLinkUsage | null;
  /**
   * One line for the top of Shadowrocket's subscription card (it reads a
   * leading `STATUS=` line in the body; the edge adds it for that client only),
   * or null for none.
   */
  status: string | null;
};

/** Hours between a client's automatic refreshes (`profile-update-interval`). */
export const SUBSCRIPTION_LINK_UPDATE_INTERVAL_HOURS = 6;

function formatHost(host: string): string {
  const trimmed = host.trim();
  // An IPv6 literal has to be bracketed in the authority part of a URI.
  return trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed;
}

/**
 * A node as a VLESS + Reality share link in the form v2rayN defines and
 * Shadowrocket imports.
 *
 * The parameter order is fixed and every value is percent-encoded with
 * encodeURIComponent (URLSearchParams would write a space as "+", which some
 * clients take literally).
 */
export function buildVlessRealityShareLink(node: SubscriptionLinkNode): string {
  const params: Array<[string, string]> = [["encryption", "none"]];
  // The agent installs the user with this flow or none at all (see
  // AgentService.getConfig); a link naming anything else would not connect.
  if (node.flow === "xtls-rprx-vision") params.push(["flow", node.flow]);
  params.push(
    ["security", "reality"],
    ["sni", node.serverName],
    ["fp", node.fingerprint],
    ["pbk", node.realityPublicKey],
    ["sid", node.shortId],
    ["spx", node.spiderX || "/"],
    ["type", "tcp"],
    ["headerType", "none"]
  );
  const verify = node.mldsa65Verify?.trim();
  if (verify) params.push(["pqv", verify]);
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `vless://${node.uuid}@${formatHost(node.serverHost)}:${node.serverPort}?${query}#${encodeURIComponent(node.name)}`;
}

/**
 * The placeholder entry: a syntactically valid node that cannot carry traffic
 * (it points at this device's own discard port), whose name is the message.
 *
 * An empty list is not an option — several clients treat an empty subscription
 * as a failed refresh and keep the nodes they already have, which is exactly
 * the state a notice exists to end.
 */
export function buildNoticeShareLink(text: string): string {
  return `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:9?encryption=none&security=none&type=tcp&headerType=none#${encodeURIComponent(text)}`;
}

function encodeBody(lines: string[]): string {
  return Buffer.from(lines.join("\n"), "utf8").toString("base64");
}

function buildUserinfo(usage: SubscriptionLinkUsage | null): string | null {
  if (!usage) return null;
  const used = usage.usedBytes < 0n ? 0n : usage.usedBytes;
  const total = usage.totalBytes < 0n ? 0n : usage.totalBytes;
  const expire = Math.floor(usage.expireAt.getTime() / 1000);
  // Upload and download are not metered separately; the whole figure goes in
  // `download`, which is what clients add up anyway.
  return `upload=0; download=${used}; total=${total}; expire=${expire}`;
}

const GIB = 1024n * 1024n * 1024n;
/** Customers are in China; dates are theirs. The zone has no daylight saving. */
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** A day as the customer reads it: YYYY-MM-DD in China time. */
export function formatSubscriptionLinkDate(at: Date): string {
  return new Date(at.getTime() + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Bytes as GB (the admin's unit, 1024³) to one decimal, rounded half up. */
export function formatSubscriptionLinkTraffic(bytes: bigint): string {
  const tenths = ((bytes < 0n ? 0n : bytes) * 10n + GIB / 2n) / GIB;
  return `${tenths / 10n}.${tenths % 10n} GB`;
}

/** 下次重置在到期之前才会真的发生（过期的订阅不重置），只有这时才提重置日。 */
function resetsBeforeExpiry(usage: SubscriptionLinkUsage): usage is SubscriptionLinkUsage & { nextResetAt: Date } {
  return Boolean(usage.nextResetAt && usage.nextResetAt.getTime() < usage.expireAt.getTime());
}

/** The status line of a link that serves nodes: what is left and until when. */
export function buildActiveStatus(usage: SubscriptionLinkUsage | null): string | null {
  if (!usage) return null;
  const date = formatSubscriptionLinkDate(usage.expireAt);
  if (usage.totalBytes <= 0n) return `${date} 到期`;
  const used = usage.usedBytes < 0n ? 0n : usage.usedBytes;
  const left = usage.totalBytes > used ? usage.totalBytes - used : 0n;
  if (resetsBeforeExpiry(usage)) {
    return `本月剩余 ${formatSubscriptionLinkTraffic(left)} ｜ ${formatSubscriptionLinkDate(usage.nextResetAt)} 重置 ｜ ${date} 到期`;
  }
  return `剩余 ${formatSubscriptionLinkTraffic(left)} ｜ ${date} 到期`;
}

/**
 * The status line of a subscription that has lapsed but can come back. The
 * link then serves a notice, and a client keeps that notice until it refreshes
 * — so the line says to refresh once the subscription is back.
 */
export function buildLapsedStatus(
  state: "expired" | "exhausted" | "paused",
  usage: SubscriptionLinkUsage
): string {
  if (state === "expired") return `⚠️ 已于 ${formatSubscriptionLinkDate(usage.expireAt)} 到期 ｜ 续费后请下拉刷新订阅`;
  if (state === "exhausted") {
    if (resetsBeforeExpiry(usage)) {
      return `⚠️ 本月流量已用完 ｜ ${formatSubscriptionLinkDate(usage.nextResetAt)} 自动恢复，届时请下拉刷新订阅`;
    }
    return "⚠️ 流量已用完 ｜ 续费后请下拉刷新订阅";
  }
  return "⚠️ 订阅已暂停 ｜ 恢复后请下拉刷新订阅";
}

export function buildNoticeDocument(
  text: string,
  usage: SubscriptionLinkUsage | null = null,
  status: string = `⚠️ ${text}`
): SubscriptionLinkDocument {
  return {
    kind: "notice",
    notice: text,
    nodes: [],
    body: encodeBody([buildNoticeShareLink(text)]),
    userinfo: buildUserinfo(usage),
    usage,
    status
  };
}

function compareNodes(left: SubscriptionLinkNode, right: SubscriptionLinkNode): number {
  // Code-point order, not locale order: the output must not depend on the
  // process's locale.
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.nodeId !== right.nodeId) return left.nodeId < right.nodeId ? -1 : 1;
  return 0;
}

export function buildNodesDocument(
  nodes: SubscriptionLinkNode[],
  usage: SubscriptionLinkUsage | null
): SubscriptionLinkDocument {
  if (nodes.length === 0) return buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.no_nodes, usage);
  const ordered = [...nodes].sort(compareNodes);
  return {
    kind: "nodes",
    notice: null,
    nodes: ordered.map((node) => ({ nodeId: node.nodeId, name: node.name })),
    body: encodeBody(ordered.map(buildVlessRealityShareLink)),
    userinfo: buildUserinfo(usage),
    usage,
    status: buildActiveStatus(usage)
  };
}

/**
 * A document as the distribution layer stores it: everything the edge needs to
 * answer a request, and nothing else. The version lets the edge refuse a shape
 * it does not understand instead of serving it wrongly.
 */
export function serializeSubscriptionLinkDocument(document: SubscriptionLinkDocument): string {
  return JSON.stringify({ v: 1, body: document.body, userinfo: document.userinfo, status: document.status });
}

/**
 * Identifies a document's content for "has it changed since it was published".
 *
 * Used traffic is left out on purpose. It moves with every metering batch, and
 * a digest that followed it would republish every active user every minute
 * against a store that allows a limited number of writes a day. The figure a
 * client displays is refreshed on a slower cycle instead; everything that
 * decides whether and where a user can connect — the nodes, the notice, the
 * quota, the expiry — is in the digest and is published as soon as it changes.
 *
 * The status line is left out for the same reason (an active one shows what is
 * left); everything else in it follows from the notice and the expiry, which
 * are in. `format` names the stored shape: raising it republishes every link
 * once, so a field added to the stored document reaches links that are not
 * otherwise changing.
 */
export function hashSubscriptionLinkDocument(document: SubscriptionLinkDocument): string {
  const stable = JSON.stringify({
    v: 1,
    format: 2,
    body: document.body,
    total: document.usage ? document.usage.totalBytes.toString() : null,
    expire: document.usage ? Math.floor(document.usage.expireAt.getTime() / 1000) : null
  });
  return createHash("sha256").update(stable, "utf8").digest("hex");
}
