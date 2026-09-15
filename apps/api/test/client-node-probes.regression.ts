import "reflect-metadata";
import assert from "node:assert/strict";
import { ClientAccessService } from "../src/modules/common/client-access.service";
import { AdminNodeService } from "../src/modules/common/admin-node.service";

async function main() {
  const writes: any[] = [];
  const service = Object.assign(Object.create(ClientAccessService.prototype), {
    authSessionService: { authenticateAccessToken: async () => ({ id: "user-1" }) },
    consumeRateLimit: async () => undefined,
    getNodes: async () => [{ id: "node-1" }],
    prisma: {
      clientNodeProbe: { upsert: (input: unknown) => { writes.push(input); return Promise.resolve(input); } },
      $transaction: (operations: Promise<unknown>[]) => Promise.all(operations)
    }
  }) as ClientAccessService;
  await service.reportClientNodeProbes([{ nodeId: "node-1", status: "healthy", latencyMs: 180 }], "token");
  assert.equal(writes[0].where.userId_nodeId.userId, "user-1");
  assert.equal(writes[0].create.latencyMs, 180);
  assert.ok(writes[0].create.checkedAt instanceof Date);
  await service.reportClientNodeProbes([{ nodeId: "node-1", status: "offline", latencyMs: null }], "token");
  assert.equal(writes[1].update.latencyMs, null);
  for (const result of [
    { nodeId: "unavailable", status: "healthy" as const, latencyMs: 10 },
    { nodeId: "node-1", status: "healthy" as const, latencyMs: null },
    { nodeId: "node-1", status: "healthy" as const, latencyMs: 60001 }
  ]) await assert.rejects(() => service.reportClientNodeProbes([result], "token"), /无效|未授权/);
  await assert.rejects(() => service.reportClientNodeProbes([
    { nodeId: "node-1", status: "offline", latencyMs: null },
    { nodeId: "node-1", status: "offline", latencyMs: null }
  ], "token"));
  assert.equal(writes.length, 2, "invalid reports must not write any observations");
  let query: any;
  const admin = Object.assign(Object.create(AdminNodeService.prototype), {
    prisma: {
      node: { findMany: async () => [{ id: "node-1", tags: [], nodeAgents: [], region: "US", createdAt: new Date(), updatedAt: new Date() }] },
      clientNodeProbe: { groupBy: async (input: unknown) => {
        query = input;
        return [
          { nodeId: "node-1", status: "healthy", _count: { _all: 2 }, _avg: { latencyMs: 180 }, _max: { checkedAt: new Date() } },
          { nodeId: "node-1", status: "offline", _count: { _all: 1 }, _avg: { latencyMs: null }, _max: { checkedAt: new Date() } }
        ];
      } }
    }
  }) as AdminNodeService;
  const [node] = await admin.listAdminNodes();
  assert.equal(node.clientProbeSummary?.samples, 3);
  assert.equal(node.clientProbeSummary?.healthy, 2);
  assert.equal(node.clientProbeSummary?.averageLatencyMs, 180);
  assert.ok(Date.now() - query.where.checkedAt.gte.getTime() >= 15 * 60_000);
  console.log("client node probe authorization, storage and aggregation checks passed");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
