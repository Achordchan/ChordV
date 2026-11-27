import "reflect-metadata";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AdminDeletionService } from "../src/modules/common/admin-deletion.service";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { applyDirectBatch } from "../src/modules/agent/agent-direct-metering";

// 真实 PostgreSQL：删除依赖数据库的级联规则，内存桩验证不了。
// CHORDV_TEST_DATABASE_URL 必须指向专用的 chordv_deletion_test 库（会清空表）。

const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

async function main() {
  const url = process.env.CHORDV_TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("/chordv_deletion_test")) {
    throw new Error("Requires the dedicated chordv_deletion_test database");
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const published: Array<{ agentId: string; type: string; payload: Record<string, unknown> }> = [];
  const clientEvents: Array<{ userIds: string[]; type: string; reasonCode?: string | null }> = [];
  const clientRuntime = {
    publishToUser: (userId: string, event: { type: string; reasonCode?: string | null }) => clientEvents.push({ userIds: [userId], ...event }),
    publishToUsers: (userIds: Iterable<string>, event: { type: string; reasonCode?: string | null }) => clientEvents.push({ userIds: Array.from(userIds), ...event })
  };
  const adminEvents = { publish() {}, publishPresenceUpdated() {} };
  const agentEvents = {
    publish: (agentId: string, command: { type: string; payload: Record<string, unknown> }) =>
      published.push({ agentId, type: command.type, payload: command.payload })
  };
  const runtime = new RuntimeSessionService(
    prisma as never, {} as never, {} as never, clientRuntime as never, {} as never, adminEvents as never, agentEvents as never, {} as never
  );
  const service = new AdminDeletionService(prisma as never, runtime, clientRuntime as never, adminEvents as never);

  await prisma.$executeRawUnsafe(`TRUNCATE "User", "Plan", "Node", "NodeCommandJob", "LeaseRevocationJob" CASCADE`);

  const now = new Date();
  const later = new Date(now.getTime() + 30 * 86400_000);
  const admin = await createUser(prisma, "admin");
  const customer = await createUser(prisma, "user");
  const teamOwner = await createUser(prisma, "user");
  const teamMember = await createUser(prisma, "user");
  const node = await createNode(prisma);
  const agent = await prisma.nodeAgent.create({ data: { id: id("agent"), agentId: id("a"), nodeId: node.id, tokenHash: randomUUID(), tokenPrefix: "t" } });
  const offlineNode = await createNode(prisma);

  // 1. 没有任何订阅的套餐：不需要强制，直接删。
  const emptyPlan = await createPlan(prisma, "personal");
  const emptyPreview = await service.preview("plan", emptyPlan.id, admin.id);
  assert.equal(emptyPreview.requiresForce, false);
  assert.ok(emptyPreview.related.every((entry) => entry.count === 0));
  await service.delete("plan", emptyPlan.id, { force: false, actorUserId: admin.id });
  assert.equal(await prisma.plan.count({ where: { id: emptyPlan.id } }), 0);

  // 2. 有订阅、节点账号和流量记录的套餐：预览列出关联项，不强制就拒绝，强制后节点收到删除命令。
  const plan = await createPlan(prisma, "personal");
  const subscription = await createSubscription(prisma, { planId: plan.id, userId: customer.id, expireAt: later });
  const binding = await createBinding(prisma, { subscriptionId: subscription.id, userId: customer.id, nodeId: node.id });
  const offlineBinding = await createBinding(prisma, { subscriptionId: subscription.id, userId: customer.id, nodeId: offlineNode.id });
  const soloTeam = await prisma.team.create({ data: { id: id("team"), name: "ledger-holder", ownerUserId: customer.id, status: "active" } });
  await prisma.trafficLedger.create({ data: { id: id("ledger"), teamId: soloTeam.id, userId: customer.id, subscriptionId: subscription.id, nodeId: node.id, usedTrafficGb: 1, recordedAt: now } });
  const ticket = await prisma.supportTicket.create({ data: { id: id("ticket"), userId: customer.id, subscriptionId: subscription.id, title: "t", status: "open", lastMessageAt: now } });

  const preview = await service.preview("plan", plan.id, admin.id);
  const counts = Object.fromEntries(preview.related.map((entry) => [entry.key, entry.count]));
  assert.equal(preview.requiresForce, true);
  assert.equal(counts.subscriptions, 1);
  assert.equal(counts.nodeAccounts, 2);
  assert.equal(counts.trafficRecords, 1);
  assert.equal(counts.tickets, 1);
  assert.match(preview.related.find((entry) => entry.key === "subscriptions")!.samples[0]!, /个人套餐/);

  await assert.rejects(service.delete("plan", plan.id, { force: false, actorUserId: admin.id }), /需要确认强制删除/);
  assert.equal(await prisma.subscription.count({ where: { id: subscription.id } }), 1, "未强制时什么都不能删");

  const result = await service.delete("plan", plan.id, { force: true, actorUserId: admin.id });
  assert.equal(result.queuedNodeRemovalCount, 1);
  assert.equal(result.skippedNodeRemovalCount, 1, "没有 Agent 的节点要报出来");
  assert.equal(await prisma.subscription.count({ where: { id: subscription.id } }), 0);
  assert.equal(await prisma.panelClientBinding.count({ where: { id: { in: [binding.id, offlineBinding.id] } } }), 0);
  assert.equal(await prisma.trafficLedger.count({ where: { subscriptionId: subscription.id } }), 0);
  assert.equal((await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).subscriptionId, null, "工单保留，只解除关联");
  const job = await prisma.nodeCommandJob.findFirstOrThrow({ where: { bindingId: binding.id } });
  assert.equal(job.commandType, "REMOVE_USER");
  assert.equal(job.status, "pending", "删除命令要在记录删掉之后依然存在");
  assert.equal((job.payload as Record<string, unknown>).email, binding.panelClientEmail);
  assert.deepEqual(published.map((entry) => [entry.agentId, entry.type]), [[agent.id, "REMOVE_USER"]], "提交后才发给 Agent");
  assert.ok(clientEvents.some((event) => event.userIds.includes(customer.id) && event.type === "subscription_updated"));

  // 3. Agent 在执行删除前还会上报这个账号的用量：不能让整个节点的用量队列卡住。
  const applied = await prisma.$transaction((tx) => applyDirectBatch(tx, agent.id, node.id, now, "boot", 1n, [{
    bindingId: binding.id, counterGeneration: "0", uplinkBytes: "10", downlinkBytes: "0", uplinkDeltaBytes: "10", downlinkDeltaBytes: "0"
  }]));
  assert.deepEqual(applied.transitions, []);

  // 4. 删除账号：不能删自己、不能删最后一个管理员；名下团队连同团队订阅一起删，团队成员的节点账号也要清理。
  await assert.rejects(service.delete("user", admin.id, { force: true, actorUserId: admin.id }), /不能删除当前登录/);
  assert.equal((await service.preview("user", admin.id, null)).blockedReason, "这是最后一个管理员账号，不能删除。");

  const teamPlan = await createPlan(prisma, "team");
  const team = await prisma.team.create({ data: { id: id("team"), name: "Acme", ownerUserId: teamOwner.id, status: "active" } });
  await prisma.teamMember.createMany({ data: [
    { id: id("tm"), teamId: team.id, userId: teamOwner.id, role: "owner" },
    { id: id("tm"), teamId: team.id, userId: teamMember.id, role: "member" }
  ] });
  const teamSubscription = await createSubscription(prisma, { planId: teamPlan.id, teamId: team.id, expireAt: later });
  const memberBinding = await createBinding(prisma, { subscriptionId: teamSubscription.id, userId: teamMember.id, teamId: team.id, nodeId: node.id });
  // 团队订阅下没带 teamId 的成员绑定：只能经由订阅级联，也要被清理。
  const looseMember = await createUser(prisma, "user");
  const looseBinding = await createBinding(prisma, { subscriptionId: teamSubscription.id, userId: looseMember.id, nodeId: node.id });
  await prisma.subscriptionLink.create({ data: { userId: teamOwner.id, token: randomUUID(), tokenHash: randomUUID() } });

  const ownerPreview = await service.preview("user", teamOwner.id, admin.id);
  const ownerCounts = Object.fromEntries(ownerPreview.related.map((entry) => [entry.key, entry.count]));
  assert.equal(ownerCounts.ownedTeams, 1);
  assert.equal(ownerCounts.ownedTeamMembers, 1);
  assert.equal(ownerCounts.nodeAccounts, 2);
  assert.equal(ownerCounts.subscriptionLink, 1);
  assert.equal(ownerPreview.blockedReason, null);

  published.length = 0;
  clientEvents.length = 0;
  await service.delete("user", teamOwner.id, { force: true, actorUserId: admin.id });
  assert.equal(await prisma.user.count({ where: { id: teamOwner.id } }), 0);
  assert.equal(await prisma.team.count({ where: { id: team.id } }), 0);
  assert.equal(await prisma.subscription.count({ where: { id: teamSubscription.id } }), 0);
  assert.equal(await prisma.user.count({ where: { id: teamMember.id } }), 1, "成员账号本身保留");
  assert.equal((await prisma.nodeCommandJob.findFirstOrThrow({ where: { bindingId: memberBinding.id } })).commandType, "REMOVE_USER");
  assert.equal((await prisma.nodeCommandJob.findFirstOrThrow({ where: { bindingId: looseBinding.id } })).commandType, "REMOVE_USER");
  assert.ok(clientEvents.some((event) => event.userIds.includes(teamOwner.id) && event.reasonCode === "auth_invalid"), "被删账号的客户端要退出登录");
  assert.ok(clientEvents.some((event) => event.userIds.includes(teamMember.id) && event.type === "subscription_updated"));

  // 4b. 节点有 Agent 但不在直控模式（Agent 会拒绝写用户）：不能算作已通知，要计入需要手工清理。
  const observingNode = await prisma.node.update({ where: { id: (await createNode(prisma)).id }, data: { controlMode: "shadow_direct" } });
  await prisma.nodeAgent.create({ data: { id: id("agent"), agentId: id("a"), nodeId: observingNode.id, tokenHash: randomUUID(), tokenPrefix: "t" } });
  const observedPlan = await createPlan(prisma, "personal");
  const observedSub = await createSubscription(prisma, { planId: observedPlan.id, userId: teamMember.id, expireAt: later });
  const observedBinding = await createBinding(prisma, { subscriptionId: observedSub.id, userId: teamMember.id, nodeId: observingNode.id });
  const observed = await service.delete("subscription", observedSub.id, { force: true, actorUserId: admin.id });
  assert.equal(observed.queuedNodeRemovalCount, 0);
  assert.equal(observed.skippedNodeRemovalCount, 1);
  assert.equal(await prisma.nodeCommandJob.count({ where: { bindingId: observedBinding.id } }), 0);

  // 4c. 只有自定义分流规则的账号也要强制确认。
  const ruleOwner = await createUser(prisma, "user");
  await prisma.clientRoutingRule.create({ data: { id: id("rule"), userId: ruleOwner.id, value: "example.com", matchType: "domain", action: "proxy" } });
  const rulePreview = await service.preview("user", ruleOwner.id, admin.id);
  assert.equal(rulePreview.requiresForce, true);
  assert.equal(rulePreview.related.find((entry) => entry.key === "routingRules")?.count, 1);

  // 4d. 团队没有订阅、没有成员，但流量记录直接引用它的 teamId：也要强制确认。
  const ledgerTeam = await prisma.team.create({ data: { id: id("team"), name: "ledger-only", ownerUserId: ruleOwner.id, status: "active" } });
  const ledgerPlan = await createPlan(prisma, "personal");
  const ledgerSub = await createSubscription(prisma, { planId: ledgerPlan.id, userId: ruleOwner.id, expireAt: later });
  await prisma.trafficLedger.create({ data: { id: id("ledger"), teamId: ledgerTeam.id, userId: ruleOwner.id, subscriptionId: ledgerSub.id, usedTrafficGb: 1, recordedAt: now } });
  const ledgerPreview = await service.preview("team", ledgerTeam.id, admin.id);
  assert.equal(ledgerPreview.requiresForce, true);
  assert.equal(ledgerPreview.related.find((entry) => entry.key === "trafficRecords")?.count, 1);
  await assert.rejects(service.delete("team", ledgerTeam.id, { force: false, actorUserId: admin.id }), /需要确认强制删除/);

  // 5. 没有关联数据的账号和团队：直接删。
  const bare = await createUser(prisma, "user");
  assert.equal((await service.preview("user", bare.id, admin.id)).requiresForce, false);
  await service.delete("user", bare.id, { force: false, actorUserId: admin.id });
  const bareTeam = await prisma.team.create({ data: { id: id("team"), name: "empty", ownerUserId: teamMember.id, status: "active" } });
  assert.equal((await service.preview("team", bareTeam.id, admin.id)).requiresForce, false);
  await service.delete("team", bareTeam.id, { force: false, actorUserId: admin.id });
  assert.equal(await prisma.team.count({ where: { id: bareTeam.id } }), 0);

  await assert.rejects(service.preview("subscription", "missing", admin.id), /不存在/);

  // 6. 预检之后、删除之前有人给空套餐开了订阅：加锁事务里重新校验，未强制的删除要被拒绝。
  const racePlan = await createPlan(prisma, "personal");
  const racing = new AdminDeletionService(prisma as never, runtime, clientRuntime as never, adminEvents as never);
  (racing as unknown as { revokeLeasesBestEffort: () => Promise<void> }).revokeLeasesBestEffort = async () => {
    await createSubscription(prisma, { planId: racePlan.id, userId: customer.id, expireAt: later });
  };
  await assert.rejects(racing.delete("plan", racePlan.id, { force: false, actorUserId: admin.id }), /需要确认强制删除/);
  assert.equal(await prisma.subscription.count({ where: { planId: racePlan.id } }), 1, "新订阅不能被未经确认地级联删掉");

  // 7. 节点账号在预检之后才建出来：也要收到 REMOVE_USER。
  const lateSub = await createSubscription(prisma, { planId: racePlan.id, userId: customer.id, expireAt: later });
  let lateBindingId = "";
  (racing as unknown as { revokeLeasesBestEffort: () => Promise<void> }).revokeLeasesBestEffort = async () => {
    lateBindingId = (await createBinding(prisma, { subscriptionId: lateSub.id, userId: customer.id, nodeId: node.id })).id;
  };
  await racing.delete("subscription", lateSub.id, { force: true, actorUserId: admin.id });
  assert.equal((await prisma.nodeCommandJob.findFirstOrThrow({ where: { bindingId: lateBindingId } })).commandType, "REMOVE_USER");

  // 8. 两个管理员同时互删：只能成功一个。
  const admin2 = await createUser(prisma, "admin");
  const outcomes = await Promise.allSettled([
    service.delete("user", admin.id, { force: true, actorUserId: admin2.id }),
    service.delete("user", admin2.id, { force: true, actorUserId: admin.id })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1, "并发互删后至少保留一个管理员");
  assert.equal(await prisma.user.count({ where: { role: "admin" } }), 1);

  await prisma.$disconnect();
  console.log("admin deletion postgres regression passed");
}

async function createUser(prisma: PrismaClient, role: "admin" | "user") {
  const userId = id("user");
  return prisma.user.create({ data: { id: userId, email: `${userId}@example.com`, displayName: userId, role, status: "active", passwordHash: "x", lastSeenAt: new Date() } });
}

async function createPlan(prisma: PrismaClient, scope: "personal" | "team") {
  return prisma.plan.create({ data: { id: id("plan"), name: scope === "team" ? "团队套餐" : "个人套餐", scope, totalTrafficGb: 100, renewable: true } });
}

async function createSubscription(prisma: PrismaClient, input: { planId: string; userId?: string; teamId?: string; expireAt: Date }) {
  return prisma.subscription.create({ data: {
    id: id("sub"), planId: input.planId, userId: input.userId ?? null, teamId: input.teamId ?? null,
    totalTrafficGb: 100, usedTrafficGb: 0, remainingTrafficGb: 100, totalTrafficBytes: 100n * 1024n ** 3n,
    expireAt: input.expireAt, state: "active", renewable: true, lastSyncedAt: new Date()
  } });
}

async function createNode(prisma: PrismaClient) {
  return prisma.node.create({ data: {
    id: id("node"), name: "n", region: "r", provider: "p", tags: [], recommended: false, latencyMs: 0, protocol: "vless", security: "reality",
    serverHost: "h", serverPort: 443, uuid: randomUUID(), flow: "xtls-rprx-vision", realityPublicKey: "k", shortId: "s", serverName: "sn", fingerprint: "chrome"
  } });
}

async function createBinding(prisma: PrismaClient, input: { subscriptionId: string; userId: string; teamId?: string; nodeId: string }) {
  return prisma.panelClientBinding.create({ data: {
    id: id("binding"), subscriptionId: input.subscriptionId, userId: input.userId, teamId: input.teamId ?? null, nodeId: input.nodeId,
    panelClientEmail: `${id("e")}@node`, panelClientId: randomUUID(), panelInboundId: 1, source: "direct"
  } });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
