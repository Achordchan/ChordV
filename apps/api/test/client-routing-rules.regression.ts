import assert from "node:assert/strict";
import { ClientRoutingRuleService } from "../src/modules/common/client-routing-rule.service";

type RuleRow = {
  id: string;
  userId: string;
  name: string | null;
  value: string;
  matchType: string;
  action: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function createHarness(userId = "user_1") {
  const rows: RuleRow[] = [];
  let activeUserId = userId;
  const prisma = {
    clientRoutingRule: {
      count: async ({ where }: { where: { userId: string } }) => rows.filter((row) => row.userId === where.userId).length,
      findMany: async ({ where }: { where: { userId: string; enabled?: boolean } }) =>
        rows
          .filter((row) => row.userId === where.userId && (where.enabled === undefined || row.enabled === where.enabled))
          .sort((left, right) => {
            if (left.enabled !== right.enabled) {
              return left.enabled ? -1 : 1;
            }
            return right.updatedAt.getTime() - left.updatedAt.getTime();
          }),
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null,
      create: async ({ data }: { data: Omit<RuleRow, "createdAt" | "updatedAt"> }) => {
        if (rows.some((row) => row.userId === data.userId && row.matchType === data.matchType && row.value === data.value)) {
          throw Object.assign(new Error("duplicate"), { code: "P2002" });
        }
        const now = new Date();
        const row = { ...data, createdAt: now, updatedAt: now };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<RuleRow> }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        assert.notEqual(index, -1);
        const next = { ...rows[index], ...data, updatedAt: new Date() };
        if (
          rows.some(
            (row) =>
              row.id !== where.id &&
              row.userId === next.userId &&
              row.matchType === next.matchType &&
              row.value === next.value
          )
        ) {
          throw Object.assign(new Error("duplicate"), { code: "P2002" });
        }
        rows[index] = next;
        return next;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        assert.notEqual(index, -1);
        return rows.splice(index, 1)[0];
      }
    }
  };
  const authSessionService = {
    authenticateAccessToken: async () => ({ id: activeUserId, email: `${activeUserId}@example.com` })
  };
  const clientRuntimeEventsService = {
    published: [] as unknown[],
    publishToUser(userId: string, event: unknown) {
      this.published.push({ userId, event });
    }
  };
  const service = new ClientRoutingRuleService(prisma as any, authSessionService as any, clientRuntimeEventsService as any);
  return {
    rows,
    service,
    setUser(nextUserId: string) {
      activeUserId = nextUserId;
    }
  };
}

async function testRoutingRuleCrudAndOwnership() {
  const harness = createHarness();
  const created = await harness.service.createRule({ value: "YouTube", action: "proxy", name: "video" }, "token");
  assert.equal(created.userId, "user_1");
  assert.equal(created.value, "youtube");
  assert.equal(created.matchType, "keyword");

  const domain = await harness.service.createRule({ value: "Example.com", action: "direct" }, "token");
  assert.equal(domain.value, "example.com");
  assert.equal(domain.matchType, "domain");

  const enabledRules = await harness.service.listEnabledRulesForUserId("user_1");
  assert.equal(enabledRules.length, 2);
  assert.ok(enabledRules.some((rule) => rule.id === domain.id && rule.action === "direct"));

  await assert.rejects(
    () => harness.service.createRule({ value: "youtube", action: "proxy" }, "token"),
    /这条自定义分流规则已存在/
  );

  harness.setUser("user_2");
  await assert.rejects(
    () => harness.service.updateRule(created.id, { action: "direct" }, "token"),
    /自定义分流规则不存在/
  );
  assert.deepEqual(await harness.service.listRules("token"), []);

  harness.setUser("user_1");
  const updated = await harness.service.updateRule(created.id, { enabled: false }, "token");
  assert.equal(updated.enabled, false);
  await harness.service.deleteRule(domain.id, "token");
  assert.equal((await harness.service.listRules("token")).length, 1);
}

async function testRoutingRuleValidationAndLimit() {
  const harness = createHarness();
  await assert.rejects(
    () => harness.service.createRule({ value: "https://example.com/path", action: "proxy" }, "token"),
    /不要包含协议、路径或空格/
  );

  for (let index = 0; index < 100; index += 1) {
    harness.rows.push({
      id: `rule_${index}`,
      userId: "user_1",
      name: null,
      value: `keyword-${index}`,
      matchType: "keyword",
      action: "proxy",
      enabled: true,
      createdAt: new Date(index),
      updatedAt: new Date(index)
    });
  }
  await assert.rejects(
    () => harness.service.createRule({ value: "overflow", action: "direct" }, "token"),
    /最多保存 100 条/
  );
}

async function main() {
  await testRoutingRuleCrudAndOwnership();
  await testRoutingRuleValidationAndLimit();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
