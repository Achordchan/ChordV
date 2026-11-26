/**
 * Where published subscription documents live: a key-value store at the edge
 * that keeps answering when this API is down.
 *
 * The API only ever writes and deletes. It never reads back and never lists —
 * what it believes is published is its own record (SubscriptionLinkPublication),
 * and the credential it holds needs no more than write access to one namespace.
 */
export interface SubscriptionLinkStore {
  put(key: string, value: string): Promise<void>;
  /** Deleting a key that is not there is a success. */
  delete(key: string): Promise<void>;
}

export const SUBSCRIPTION_LINK_STORE = Symbol("SUBSCRIPTION_LINK_STORE");

export class SubscriptionLinkStoreError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null when no response was received. */
    readonly status: number | null
  ) {
    super(message);
    this.name = "SubscriptionLinkStoreError";
  }
}

export type CloudflareKvConfig = {
  accountId: string;
  namespaceId: string;
  apiToken: string;
};

const CLOUDFLARE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Reads the three settings that turn distribution on. All three or none: a
 * partial or malformed set leaves distribution off and says which one is at
 * fault, without ever echoing the API token.
 */
export function readCloudflareKvConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = () => undefined
): CloudflareKvConfig | null {
  const accountId = env.CHORDV_SUBSCRIPTION_KV_ACCOUNT_ID?.trim() ?? "";
  const namespaceId = env.CHORDV_SUBSCRIPTION_KV_NAMESPACE_ID?.trim() ?? "";
  const apiToken = env.CHORDV_SUBSCRIPTION_KV_API_TOKEN?.trim() ?? "";
  if (!accountId && !namespaceId && !apiToken) return null;
  const problems: string[] = [];
  if (!CLOUDFLARE_ID_PATTERN.test(accountId)) problems.push("CHORDV_SUBSCRIPTION_KV_ACCOUNT_ID 应为 32 位十六进制");
  if (!CLOUDFLARE_ID_PATTERN.test(namespaceId)) problems.push("CHORDV_SUBSCRIPTION_KV_NAMESPACE_ID 应为 32 位十六进制");
  if (!apiToken || /\s/.test(apiToken)) problems.push("CHORDV_SUBSCRIPTION_KV_API_TOKEN 未填写或含有空白字符");
  if (problems.length > 0) {
    warn(`订阅链接分发未启用：${problems.join("；")}`);
    return null;
  }
  return { accountId, namespaceId, apiToken };
}

const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export class CloudflareKvStore implements SubscriptionLinkStore {
  constructor(
    private readonly config: CloudflareKvConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)
  ) {}

  async put(key: string, value: string): Promise<void> {
    const response = await this.request("PUT", key, value);
    if (!response.ok) throw new SubscriptionLinkStoreError(`写入分发层失败（HTTP ${response.status}）`, response.status);
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    if (!response.ok && response.status !== 404) {
      throw new SubscriptionLinkStoreError(`从分发层删除失败（HTTP ${response.status}）`, response.status);
    }
  }

  private async request(method: "PUT" | "DELETE", key: string, body?: string) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}` +
      `/storage/kv/namespaces/${this.config.namespaceId}/values/${encodeURIComponent(key)}`;
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/octet-stream" })
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      // The underlying error is dropped on purpose: depending on the runtime it
      // can quote the request, and the request carries the API token and a
      // user's node credentials.
      throw new SubscriptionLinkStoreError("连不上分发层", null);
    }
  }
}
