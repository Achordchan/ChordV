import assert from "node:assert/strict";
import {
  buildNodesDocument,
  buildNoticeDocument,
  buildSubscriptionLinkUrl,
  generateSubscriptionLinkToken,
  hashSubscriptionLinkToken,
  serializeSubscriptionLinkDocument,
  SUBSCRIPTION_LINK_INVALID_NOTICE,
  SUBSCRIPTION_LINK_NOTICES,
  SUBSCRIPTION_LINK_UPDATE_INTERVAL_HOURS
} from "../src/modules/common/subscription-link";

// The API writes subscription documents; the edge worker (apps/subscription-worker)
// serves them. They are separate programs that share no code, so this holds the
// two halves of the contract together: the URL, the key, the stored format, and
// what an unknown token gets.

type EdgeWorker = {
  default: { fetch(request: Request, env: { LINKS: { get(key: string): Promise<string | null> } }): Promise<Response> };
  hashToken(token: string): Promise<string>;
  INVALID_BODY: string;
  INVALID_NOTICE: string;
  UPDATE_INTERVAL_HOURS: number;
};

async function main() {
  const edge = (await import("../../subscription-worker/src/worker.mjs" as string)) as EdgeWorker;
  const origin = "https://sub.example.com";

  assert.equal(edge.INVALID_NOTICE, SUBSCRIPTION_LINK_INVALID_NOTICE);
  assert.equal(
    edge.INVALID_BODY,
    buildNoticeDocument(SUBSCRIPTION_LINK_INVALID_NOTICE).body,
    "无效链接的提示节点，两边必须逐字节一致"
  );
  assert.equal(edge.UPDATE_INTERVAL_HOURS, SUBSCRIPTION_LINK_UPDATE_INTERVAL_HOURS);

  const documents = [
    buildNodesDocument(
      [
        {
          nodeId: "node_a",
          name: "美国 01 / 直连 #1",
          serverHost: "2001:db8::1",
          serverPort: 443,
          uuid: "11111111-2222-4333-8444-555555555555",
          flow: "xtls-rprx-vision",
          realityPublicKey: "5C3G02RWVBX3e2tHAh9d69Vk4g8JwG2Zx2N0TTTPD2M",
          shortId: "0123abcd",
          serverName: "www.example.org",
          fingerprint: "chrome",
          spiderX: "/"
        }
      ],
      { usedBytes: 123n, totalBytes: 456n, expireAt: new Date("2027-01-01T00:00:00Z") }
    ),
    buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.subscription_expired, {
      usedBytes: 1n,
      totalBytes: 2n,
      expireAt: new Date("2026-01-01T00:00:00Z")
    }),
    buildNoticeDocument(SUBSCRIPTION_LINK_NOTICES.account_disabled)
  ];

  // Many tokens, so every character of the alphabet lands in the path.
  for (let round = 0; round < 50; round += 1) {
    const token = generateSubscriptionLinkToken();
    const key = hashSubscriptionLinkToken(token);
    assert.equal(await edge.hashToken(token), key, "两边对同一个 token 必须算出同一个键");

    const document = documents[round % documents.length];
    const kv = new Map([[key, serializeSubscriptionLinkDocument(document)]]);
    const env = { LINKS: { get: async (name: string) => kv.get(name) ?? null } };

    // The URL the admin page shows is a URL the worker serves.
    const served = await edge.default.fetch(new Request(buildSubscriptionLinkUrl(origin, token)), env);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), document.body, "边缘返回的正文就是后台生成的正文");
    assert.equal(served.headers.get("subscription-userinfo"), document.userinfo);
    assert.equal(served.headers.get("profile-update-interval"), String(SUBSCRIPTION_LINK_UPDATE_INTERVAL_HOURS));

    // After a reset the key is gone: the old URL gets the notice.
    kv.clear();
    const revoked = await edge.default.fetch(new Request(buildSubscriptionLinkUrl(origin, token)), env);
    assert.equal(revoked.status, 200);
    assert.equal(await revoked.text(), buildNoticeDocument(SUBSCRIPTION_LINK_INVALID_NOTICE).body);
  }

  console.log("subscription-link-edge.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
