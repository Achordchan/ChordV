import "reflect-metadata";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";
import {
  buildNodesDocument,
  buildNoticeDocument,
  hashSubscriptionLinkDocument,
  serializeSubscriptionLinkDocument,
  SUBSCRIPTION_LINK_NOTICES,
  type SubscriptionLinkDocument,
  type SubscriptionLinkNode
} from "../src/modules/common/subscription-link";
import {
  SUBSCRIPTION_LINK_MAX_FAILURES_PER_PASS,
  SUBSCRIPTION_LINK_MAX_WRITES_PER_PASS,
  SUBSCRIPTION_LINK_RATE_LIMIT_PAUSE_MS,
  SUBSCRIPTION_LINK_REFRESH_AFTER_MS,
  SubscriptionLinkPublicationService
} from "../src/modules/common/subscription-link-publication.service";
import {
  CloudflareKvStore,
  readCloudflareKvConfig,
  SubscriptionLinkStoreError,
  type SubscriptionLinkStore
} from "../src/modules/common/subscription-link-store";

// Keeping the distribution layer equal to what the links should return: what
// is written, when, what is removed, and what happens when the store says no.

const GIB = 1024n * 1024n * 1024n;
const T0 = new Date("2026-11-26T00:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function node(nodeId: string, uuid: string): SubscriptionLinkNode {
  return {
    nodeId,
    name: `节点 ${nodeId}`,
    serverHost: `${nodeId}.example.com`,
    serverPort: 443,
    uuid,
    flow: "xtls-rprx-vision",
    realityPublicKey: "5C3G02RWVBX3e2tHAh9d69Vk4g8JwG2Zx2N0TTTPD2M",
    shortId: "0123abcd",
    serverName: "www.example.org",
    fingerprint: "chrome",
    spiderX: "/"
  };
}

function nodesDocument(uuid: string, usedBytes = 1n * GIB, nodeIds = ["node_a"]): SubscriptionLinkDocument {
  return buildNodesDocument(
    nodeIds.map((nodeId) => node(nodeId, uuid)),
    { usedBytes, totalBytes: 100n * GIB, expireAt: new Date("2027-01-01T00:00:00Z") }
  );
}

type Operation = { op: "put" | "delete"; key: string; value?: string };

function createHarness(options: { configured?: boolean } = {}) {
  const state = {
    links: [] as Array<{ userId: string; tokenHash: string }>,
    publications: [] as Array<{ tokenHash: string; contentHash: string; publishedAt: Date }>,
    documents: new Map<string, SubscriptionLinkDocument | Error>(),
    kv: new Map<string, string>(),
    operations: [] as Operation[],
    /** Decides whether a store call fails; return an error to throw it. */
    failStore: null as null | ((operation: Operation) => Error | null),
    failPublicationWrite: false,
    renders: [] as string[]
  };
  const store: SubscriptionLinkStore = {
    put: async (key, value) => {
      const operation: Operation = { op: "put", key, value };
      state.operations.push(operation);
      const error = state.failStore?.(operation);
      if (error) throw error;
      state.kv.set(key, value);
    },
    delete: async (key) => {
      const operation: Operation = { op: "delete", key };
      state.operations.push(operation);
      const error = state.failStore?.(operation);
      if (error) throw error;
      state.kv.delete(key);
    }
  };
  const prisma = {
    subscriptionLink: {
      findMany: async () => [...state.links].sort((left, right) => (left.userId < right.userId ? -1 : 1)),
      findUnique: async ({ where }: any) => state.links.find((link) => link.userId === where.userId) ?? null
    },
    subscriptionLinkPublication: {
      findMany: async () => state.publications.map((row) => ({ ...row })),
      findUnique: async ({ where }: any) => state.publications.find((row) => row.tokenHash === where.tokenHash) ?? null,
      deleteMany: async ({ where }: any) => {
        state.publications = state.publications.filter((row) => row.tokenHash !== where.tokenHash);
      },
      upsert: async ({ where, create, update }: any) => {
        if (state.failPublicationWrite) throw new Error("database unavailable");
        const existing = state.publications.find((row) => row.tokenHash === where.tokenHash);
        if (existing) Object.assign(existing, update);
        else state.publications.push({ ...create });
      }
    }
  };
  const links = {
    render: async (userId: string) => {
      state.renders.push(userId);
      const document = state.documents.get(userId);
      if (!document) throw new Error(`no document staged for ${userId}`);
      if (document instanceof Error) throw document;
      return document;
    }
  };
  const service = new SubscriptionLinkPublicationService(
    prisma as never,
    links as never,
    options.configured === false ? null : store
  );
  const addUser = (userId: string, tokenHash: string, document: SubscriptionLinkDocument | Error) => {
    state.links.push({ userId, tokenHash });
    state.documents.set(userId, document);
  };
  return { state, service, addUser };
}

async function main() {
  // The failure cases below log warnings by design; keep the run's output to the verdict.
  Logger.overrideLogger(false);

  // --- what is stored, and what counts as a change ----------------------------------

  {
    const document = nodesDocument("uuid-1");
    assert.deepEqual(JSON.parse(serializeSubscriptionLinkDocument(document)), {
      v: 1,
      body: document.body,
      userinfo: "upload=0; download=1073741824; total=107374182400; expire=1798761600"
    });
    assert.deepEqual(JSON.parse(serializeSubscriptionLinkDocument(buildNoticeDocument("提示"))), {
      v: 1,
      body: buildNoticeDocument("提示").body,
      userinfo: null
    });

    const hash = hashSubscriptionLinkDocument(document);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hashSubscriptionLinkDocument(nodesDocument("uuid-1", 50n * GIB)), hash, "只有已用流量变了，不算内容变化");
    const changes: Array<[string, SubscriptionLinkDocument]> = [
      ["凭据变了", nodesDocument("uuid-2")],
      ["节点变了", nodesDocument("uuid-1", 1n * GIB, ["node_a", "node_b"])],
      ["总流量变了", buildNodesDocument([node("node_a", "uuid-1")], { usedBytes: 1n * GIB, totalBytes: 200n * GIB, expireAt: new Date("2027-01-01T00:00:00Z") })],
      ["到期时间变了", buildNodesDocument([node("node_a", "uuid-1")], { usedBytes: 1n * GIB, totalBytes: 100n * GIB, expireAt: new Date("2027-02-01T00:00:00Z") })],
      ["变成提示节点", buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.subscription_expired, document.usage)],
      ["提示内容变了", buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.subscription_exhausted, document.usage)]
    ];
    const seen = new Set([hash]);
    for (const [label, changed] of changes) {
      const next = hashSubscriptionLinkDocument(changed);
      assert.ok(!seen.has(next), `${label}必须被识别为内容变化`);
      seen.add(next);
    }
  }

  // --- distribution switched off -------------------------------------------------------

  {
    const { state, service, addUser } = createHarness({ configured: false });
    addUser("user_1", "hash_1", nodesDocument("uuid-1"));
    assert.deepEqual(await service.reconcile(T0), { outcome: "disabled", written: 0, deleted: 0, failed: 0, pending: 0 });
    assert.deepEqual(state.renders, [], "没启用分发时不应白白生成内容");
    assert.equal(service.configured, false);
    assert.equal(service.getStatus().configured, false);
    assert.deepEqual(await service.describeForUser("user_1"), { state: "not_configured", publishedAt: null });
    service.kick();
    assert.deepEqual(state.operations, []);
  }

  // --- the ordinary life of a link --------------------------------------------------------

  {
    const { state, service, addUser } = createHarness();
    const first = nodesDocument("uuid-1");
    addUser("user_1", "hash_1", first);
    addUser("user_2", "hash_2", buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.subscription_expired));
    assert.deepEqual(await service.describeForUser("user_1"), { state: "pending", publishedAt: null });
    assert.deepEqual(await service.describeForUser("nobody"), { state: "pending", publishedAt: null });

    assert.deepEqual(await service.reconcile(T0), { outcome: "ran", written: 2, deleted: 0, failed: 0, pending: 0 });
    assert.equal(state.kv.get("hash_1"), serializeSubscriptionLinkDocument(first), "键是 token 的哈希，值是完整文档");
    assert.equal(
      state.kv.get("hash_2"),
      serializeSubscriptionLinkDocument(buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.subscription_expired)),
      "到期用户的链接照样发布，内容是提示节点"
    );
    assert.deepEqual(await service.describeForUser("user_1"), { state: "live", publishedAt: T0.toISOString() });
    assert.equal(service.getStatus().lastSuccessAt, T0.toISOString());

    // Nothing changed: nothing is written, however often the pass runs.
    state.operations.length = 0;
    assert.deepEqual(await service.reconcile(at(30_000)), { outcome: "ran", written: 0, deleted: 0, failed: 0, pending: 0 });
    assert.deepEqual(state.operations, []);

    // Used traffic alone does not cost a write…
    state.documents.set("user_1", nodesDocument("uuid-1", 40n * GIB));
    await service.reconcile(at(60_000));
    assert.deepEqual(state.operations, []);
    // …until the daily refresh, which carries the current figure.
    await service.reconcile(at(SUBSCRIPTION_LINK_REFRESH_AFTER_MS - 1));
    assert.deepEqual(state.operations, []);
    const refreshed = await service.reconcile(at(SUBSCRIPTION_LINK_REFRESH_AFTER_MS));
    assert.equal(refreshed.written, 2, "满一天后每条都重写一次，顺带修复分发层被外部改动的情况");
    assert.match(state.kv.get("hash_1") ?? "", /download=42949672960;/);

    // A real change is written on the very next pass.
    state.operations.length = 0;
    const expired = buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.subscription_expired, first.usage);
    state.documents.set("user_1", expired);
    const afterExpiry = at(SUBSCRIPTION_LINK_REFRESH_AFTER_MS + 30_000);
    assert.equal((await service.reconcile(afterExpiry)).written, 1);
    assert.deepEqual(state.operations, [{ op: "put", key: "hash_1", value: serializeSubscriptionLinkDocument(expired) }]);
    assert.ok(
      !Buffer.from(JSON.parse(state.kv.get("hash_1")!).body, "base64").toString("utf8").includes("uuid-1"),
      "到期后分发层里不能再留着凭据"
    );

    // A reset: the old key goes, the new one appears, and the old one goes FIRST.
    state.operations.length = 0;
    state.links[0].tokenHash = "hash_1_new";
    const afterReset = at(SUBSCRIPTION_LINK_REFRESH_AFTER_MS + 60_000);
    assert.deepEqual(await service.reconcile(afterReset), { outcome: "ran", written: 1, deleted: 1, failed: 0, pending: 0 });
    assert.deepEqual(state.operations.map((operation) => `${operation.op}:${operation.key}`), ["delete:hash_1", "put:hash_1_new"]);
    assert.equal(state.kv.has("hash_1"), false, "重置后旧链接必须从分发层消失");
    assert.deepEqual(state.publications.map((row) => row.tokenHash).sort(), ["hash_1_new", "hash_2"]);

    // An account removed: its link row is gone, and so must its key be.
    state.operations.length = 0;
    state.links = state.links.filter((link) => link.userId !== "user_2");
    assert.deepEqual(await service.reconcile(at(SUBSCRIPTION_LINK_REFRESH_AFTER_MS + 90_000)), { outcome: "ran", written: 0, deleted: 1, failed: 0, pending: 0 });
    assert.deepEqual([...state.kv.keys()], ["hash_1_new"]);
    assert.deepEqual(state.publications.map((row) => row.tokenHash), ["hash_1_new"]);
  }

  // --- when the store says no ---------------------------------------------------------------

  {
    // A failed write is not recorded as published, and is simply tried again.
    const { state, service, addUser } = createHarness();
    addUser("user_1", "hash_1", nodesDocument("uuid-1"));
    addUser("user_2", "hash_2", nodesDocument("uuid-2"));
    state.failStore = (operation) => (operation.key === "hash_1" ? new SubscriptionLinkStoreError("写入分发层失败（HTTP 500）", 500) : null);
    assert.deepEqual(await service.reconcile(T0), { outcome: "ran", written: 1, deleted: 0, failed: 1, pending: 1 });
    assert.deepEqual(state.publications.map((row) => row.tokenHash), ["hash_2"], "一条失败不耽误其他人");
    assert.deepEqual(await service.describeForUser("user_1"), { state: "pending", publishedAt: null });
    const status = service.getStatus();
    assert.equal(status.pending, 1);
    assert.equal(status.lastError, "写入分发层失败（HTTP 500）");
    assert.equal(status.lastSuccessAt, null);

    state.failStore = null;
    assert.deepEqual(await service.reconcile(at(30_000)), { outcome: "ran", written: 1, deleted: 0, failed: 0, pending: 0 });
    assert.equal(service.getStatus().lastError, null, "恢复后错误要清掉");
    assert.equal(service.getStatus().lastSuccessAt, at(30_000).toISOString());
  }
  {
    // The store accepted the write but recording it failed: the next pass
    // writes again (harmless) rather than believing nothing was published.
    const { state, service, addUser } = createHarness();
    addUser("user_1", "hash_1", nodesDocument("uuid-1"));
    state.failPublicationWrite = true;
    assert.deepEqual(await service.reconcile(T0), { outcome: "ran", written: 0, deleted: 0, failed: 1, pending: 1 });
    assert.equal(service.getStatus().lastError, "发布时出错", "数据库错误的原文不进状态");
    state.failPublicationWrite = false;
    assert.equal((await service.reconcile(at(30_000))).written, 1);
    assert.equal(state.operations.filter((operation) => operation.op === "put").length, 2);
  }
  {
    // A reset whose delete fails keeps its record, so the key is not forgotten.
    const { state, service, addUser } = createHarness();
    addUser("user_1", "hash_new", nodesDocument("uuid-1"));
    state.publications.push({ tokenHash: "hash_old", contentHash: "x", publishedAt: T0 });
    state.kv.set("hash_old", "stale");
    state.failStore = (operation) => (operation.op === "delete" ? new SubscriptionLinkStoreError("从分发层删除失败（HTTP 503）", 503) : null);
    const result = await service.reconcile(T0);
    assert.equal(result.deleted, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.written, 1, "删除失败不耽误发布新链接");
    assert.ok(state.publications.some((row) => row.tokenHash === "hash_old"), "没删掉就必须留着记录");
    state.failStore = null;
    assert.equal((await service.reconcile(at(30_000))).deleted, 1);
    assert.equal(state.kv.has("hash_old"), false);
  }
  {
    // A store that is down is not hammered: the pass stops after a few failures.
    const { state, service, addUser } = createHarness();
    for (let index = 0; index < 10; index += 1) addUser(`user_${index}`, `hash_${index}`, nodesDocument(`uuid-${index}`));
    state.failStore = () => new SubscriptionLinkStoreError("连不上分发层", null);
    const result = await service.reconcile(T0);
    assert.equal(result.failed, SUBSCRIPTION_LINK_MAX_FAILURES_PER_PASS);
    assert.equal(state.operations.length, SUBSCRIPTION_LINK_MAX_FAILURES_PER_PASS);
    assert.equal(result.pending, 10, "没处理到的都算待处理");
    assert.equal(service.getStatus().pending, 10);
  }
  {
    // The store's write limit: stay away for a while instead of burning the
    // rest of the allowance on retries, then carry on by itself.
    const { state, service, addUser } = createHarness();
    for (let index = 0; index < 5; index += 1) addUser(`user_${index}`, `hash_${index}`, nodesDocument(`uuid-${index}`));
    state.failStore = (operation) => (operation.key === "hash_1" ? new SubscriptionLinkStoreError("写入分发层失败（HTTP 429）", 429) : null);
    const limited = await service.reconcile(T0);
    assert.deepEqual([limited.written, limited.failed, limited.pending], [1, 1, 4]);
    assert.equal(state.operations.length, 2, "被限流后本轮立刻停手");
    state.failStore = null;
    assert.equal((await service.reconcile(at(SUBSCRIPTION_LINK_RATE_LIMIT_PAUSE_MS - 1))).outcome, "paused");
    assert.equal(state.operations.length, 2);
    const resumed = await service.reconcile(at(SUBSCRIPTION_LINK_RATE_LIMIT_PAUSE_MS));
    assert.deepEqual([resumed.outcome, resumed.written, resumed.pending], ["ran", 4, 0]);
  }
  {
    // One user whose document cannot be generated does not hold the others back.
    const { state, service, addUser } = createHarness();
    addUser("user_1", "hash_1", new Error("row is unreadable: secret-detail"));
    addUser("user_2", "hash_2", nodesDocument("uuid-2"));
    assert.deepEqual(await service.reconcile(T0), { outcome: "ran", written: 1, deleted: 0, failed: 0, pending: 1 });
    assert.equal(state.kv.has("hash_2"), true);
    assert.equal(service.getStatus().lastError, "生成订阅内容时出错");
    assert.equal(service.getStatus().lastSuccessAt, null, "还有没发布的就不算成功");
  }
  {
    // A large first run is spread over passes rather than done in one burst.
    const { service, addUser } = createHarness();
    const total = SUBSCRIPTION_LINK_MAX_WRITES_PER_PASS + 7;
    for (let index = 0; index < total; index += 1) addUser(`user_${String(index).padStart(3, "0")}`, `hash_${index}`, nodesDocument(`uuid-${index}`));
    const firstPass = await service.reconcile(T0);
    assert.deepEqual([firstPass.written, firstPass.pending], [SUBSCRIPTION_LINK_MAX_WRITES_PER_PASS, 7]);
    const secondPass = await service.reconcile(at(30_000));
    assert.deepEqual([secondPass.written, secondPass.pending], [7, 0]);
  }
  {
    // Two passes never run on top of each other in one process.
    const { state, service, addUser } = createHarness();
    addUser("user_1", "hash_1", nodesDocument("uuid-1"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const render = (service as any).links.render;
    (service as any).links.render = async (userId: string) => { await gate; return render(userId); };
    const running = service.reconcile(T0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await service.reconcile(T0)).outcome, "busy");
    release();
    assert.equal((await running).written, 1);
    assert.equal((await service.reconcile(at(30_000))).outcome, "ran", "上一轮结束后可以再跑");
  }

  // --- the store client --------------------------------------------------------------------------

  {
    const accountId = "a".repeat(32);
    const namespaceId = "b".repeat(32);
    const apiToken = "cf-token-SECRET";
    assert.equal(readCloudflareKvConfig({}), null, "三项都没填就是没启用，不告警");
    assert.deepEqual(
      readCloudflareKvConfig({
        CHORDV_SUBSCRIPTION_KV_ACCOUNT_ID: ` ${accountId} `,
        CHORDV_SUBSCRIPTION_KV_NAMESPACE_ID: namespaceId,
        CHORDV_SUBSCRIPTION_KV_API_TOKEN: apiToken
      }),
      { accountId, namespaceId, apiToken }
    );
    for (const partial of [
      { CHORDV_SUBSCRIPTION_KV_ACCOUNT_ID: accountId, CHORDV_SUBSCRIPTION_KV_NAMESPACE_ID: namespaceId },
      { CHORDV_SUBSCRIPTION_KV_ACCOUNT_ID: "not-an-id", CHORDV_SUBSCRIPTION_KV_NAMESPACE_ID: namespaceId, CHORDV_SUBSCRIPTION_KV_API_TOKEN: apiToken },
      { CHORDV_SUBSCRIPTION_KV_ACCOUNT_ID: accountId, CHORDV_SUBSCRIPTION_KV_NAMESPACE_ID: namespaceId.toUpperCase(), CHORDV_SUBSCRIPTION_KV_API_TOKEN: apiToken },
      { CHORDV_SUBSCRIPTION_KV_ACCOUNT_ID: accountId, CHORDV_SUBSCRIPTION_KV_NAMESPACE_ID: namespaceId, CHORDV_SUBSCRIPTION_KV_API_TOKEN: "two words" }
    ]) {
      const warnings: string[] = [];
      assert.equal(readCloudflareKvConfig(partial, (message) => warnings.push(message)), null);
      assert.equal(warnings.length, 1, "填了一半或填错要告警，否则没人知道为什么没生效");
      assert.ok(!warnings[0].includes(apiToken) && !warnings[0].includes("two words"), "告警里不能带出密钥");
    }

    const requests: Array<{ url: string; init: any }> = [];
    let respond: () => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 200 });
    const store = new CloudflareKvStore({ accountId, namespaceId, apiToken }, async (url, init) => {
      requests.push({ url, init });
      return respond();
    });
    const key = "f".repeat(64);
    await store.put(key, '{"v":1}');
    await store.delete(key);
    const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`;
    assert.deepEqual(
      requests.map(({ url, init }) => [init.method, url, init.headers.Authorization, init.headers["Content-Type"], init.body]),
      [
        ["PUT", base, `Bearer ${apiToken}`, "application/octet-stream", '{"v":1}'],
        ["DELETE", base, `Bearer ${apiToken}`, undefined, undefined]
      ]
    );
    assert.ok(requests.every(({ init }) => init.signal instanceof AbortSignal), "每个请求都要有超时");

    respond = async () => ({ ok: false, status: 404 });
    await store.delete(key);
    await assert.rejects(store.put(key, "value"), (error: unknown) => error instanceof SubscriptionLinkStoreError && error.status === 404);
    respond = async () => ({ ok: false, status: 403 });
    await assert.rejects(store.delete(key), (error: unknown) => error instanceof SubscriptionLinkStoreError && error.status === 403);
    respond = async () => { throw new Error(`fetch failed for Bearer ${apiToken} with body SECRET-VALUE`); };
    await assert.rejects(store.put(key, "SECRET-VALUE"), (error: unknown) => {
      assert.ok(error instanceof SubscriptionLinkStoreError);
      assert.equal(error.status, null);
      assert.ok(!error.message.includes(apiToken) && !error.message.includes("SECRET-VALUE"), "错误信息不能带出密钥或订阅内容");
      return true;
    });
  }

  console.log("subscription-link-publication.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
