import assert from "node:assert/strict";
import { readMemberUsedTrafficGb } from "../src/modules/common/member-traffic-usage";

async function main() {
  let aggregateCalls = 0;
  const prisma = {
    trafficLedger: {
      aggregate: async ({ where, _sum }: { where: Record<string, string>; _sum: Record<string, boolean> }) => {
        aggregateCalls += 1;
        assert.deepEqual(where, {
          teamId: "team-1",
          userId: "user-1",
          subscriptionId: "subscription-1"
        });
        assert.deepEqual(_sum, { usedTrafficGb: true });
        return { _sum: { usedTrafficGb: 12.5 } };
      }
    }
  };
  assert.equal(await readMemberUsedTrafficGb(prisma as never, "team-1", "user-1", "subscription-1"), 12.5);
  assert.equal(aggregateCalls, 1, "成员流量必须由数据库聚合，禁止把全部账本明细加载到 Node.js");

  const empty = {
    trafficLedger: { aggregate: async () => ({ _sum: { usedTrafficGb: null } }) }
  };
  assert.equal(await readMemberUsedTrafficGb(empty as never, "team-1", "user-1", "subscription-1"), 0);
  console.log("member-traffic-usage.regression.ts passed");
}

void main();
