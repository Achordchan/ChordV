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
};

export type SubscriptionLinkDocument = {
  kind: "nodes" | "notice";
  notice: string | null;
  nodes: Array<{ nodeId: string; name: string }>;
  /** The response body: the share links, one per line, base64-encoded. */
  body: string;
  /** Value of the `subscription-userinfo` response header, or null when there is no subscription to describe. */
  userinfo: string | null;
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

export function buildNoticeDocument(
  text: string,
  usage: SubscriptionLinkUsage | null = null
): SubscriptionLinkDocument {
  return {
    kind: "notice",
    notice: text,
    nodes: [],
    body: encodeBody([buildNoticeShareLink(text)]),
    userinfo: buildUserinfo(usage)
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
    userinfo: buildUserinfo(usage)
  };
}
