import "reflect-metadata";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AgentHeartbeatDto } from "../src/modules/agent/agent.dto";
import { buildAdminPresenceSnapshot, toDirectPresenceLeases, type DirectPresenceBindingRow } from "../src/modules/common/client-presence.service";
import {
  DIRECT_ONLINE_WINDOW_SECONDS,
  normalizeDirectOnline,
  recordDirectOnline
} from "../src/modules/common/direct-presence";

const now = new Date("2026-11-27T02:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

type Binding = {
  id: string;
  nodeId: string;
  directOnlineSince: Date | null;
  directLastOnlineAt: Date | null;
  directOnlineIpCount: number;
};

/** 只实现 recordDirectOnline 用到的 updateMany 条件子集，按真实语义在内存里执行。 */
function fakePrisma(rows: Binding[]) {
  const matches = (row: Binding, where: Record<string, any>): boolean => {
    if (where.nodeId !== undefined && row.nodeId !== where.nodeId) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.id?.notIn && where.id.notIn.includes(row.id)) return false;
    if (where.directOnlineIpCount?.gt !== undefined && !(row.directOnlineIpCount > where.directOnlineIpCount.gt)) return false;
    if (where.OR) {
      return where.OR.some((clause: Record<string, any>) => {
        const [key, value] = Object.entries(clause)[0];
        const current = (row as any)[key] as Date | null;
        if (value === null) return current === null;
        if (value.lt) return current !== null && current.getTime() < value.lt.getTime();
        return false;
      });
    }
    return true;
  };
  return {
    rows,
    panelClientBinding: {
      async updateMany({ where, data }: { where: Record<string, any>; data: Partial<Binding> }) {
        let count = 0;
        for (const row of rows) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      }
    }
  };
}

function binding(id: string, nodeId = "node_1", overrides: Partial<Binding> = {}): Binding {
  return { id, nodeId, directOnlineSince: null, directLastOnlineAt: null, directOnlineIpCount: 0, ...overrides };
}

async function testRecord() {
  assert.deepEqual([...normalizeDirectOnline([
    { bindingId: "b1", ipCount: 1 }, { bindingId: "b1", ipCount: 3 }, { bindingId: "", ipCount: 1 }, { bindingId: "b2", ipCount: 0 }
  ])], [["b1", 3]], "重复取最大，非法条目丢弃");

  const longAgo = ago(3600);
  const prisma = fakePrisma([
    binding("fresh"),
    binding("continuing", "node_1", { directOnlineSince: ago(600), directLastOnlineAt: ago(15), directOnlineIpCount: 1 }),
    binding("returning", "node_1", { directOnlineSince: longAgo, directLastOnlineAt: ago(DIRECT_ONLINE_WINDOW_SECONDS + 5), directOnlineIpCount: 0 }),
    binding("leaving", "node_1", { directOnlineSince: ago(600), directLastOnlineAt: ago(15), directOnlineIpCount: 2 }),
    binding("other-node", "node_2", { directOnlineSince: ago(600), directLastOnlineAt: ago(15), directOnlineIpCount: 1 })
  ]);
  await recordDirectOnline(prisma as never, "node_1", [
    { bindingId: "fresh", ipCount: 1 },
    { bindingId: "continuing", ipCount: 2 },
    { bindingId: "returning", ipCount: 1 },
    { bindingId: "other-node", ipCount: 5 }
  ], now);
  const byId = new Map(prisma.rows.map((row) => [row.id, row]));
  assert.equal(byId.get("fresh")!.directOnlineSince?.getTime(), now.getTime(), "首次在线从现在算起");
  assert.equal(byId.get("fresh")!.directOnlineIpCount, 1);
  assert.equal(byId.get("continuing")!.directOnlineSince?.getTime(), ago(600).getTime(), "持续在线沿用开始时间");
  assert.equal(byId.get("continuing")!.directOnlineIpCount, 2);
  assert.equal(byId.get("continuing")!.directLastOnlineAt?.getTime(), now.getTime());
  assert.equal(byId.get("returning")!.directOnlineSince?.getTime(), now.getTime(), "离线超过窗口后重新计时");
  assert.equal(byId.get("leaving")!.directOnlineIpCount, 0, "这次没报告的账号置为不在线");
  assert.equal(byId.get("leaving")!.directLastOnlineAt?.getTime(), ago(15).getTime(), "保留最近在线时间");
  assert.equal(byId.get("other-node")!.directOnlineIpCount, 1, "不写其他节点的绑定");
  assert.equal(byId.get("other-node")!.directLastOnlineAt?.getTime(), ago(15).getTime());

  // 空列表＝观察到了、没人在线。
  await recordDirectOnline(prisma as never, "node_1", [], now);
  assert.ok(prisma.rows.filter((row) => row.nodeId === "node_1").every((row) => row.directOnlineIpCount === 0));
  assert.equal(byId.get("other-node")!.directOnlineIpCount, 1);
}

function testHeartbeatDto() {
  const valid = (payload: Record<string, unknown>) => validateSync(plainToInstance(AgentHeartbeatDto, {
    bootId: "boot", version: "go-0.0.36", configRevision: "7", queueDepth: 0, xrayStatus: "healthy", ...payload
  }), { whitelist: true }).length === 0;
  assert.equal(valid({}), true, "旧版 Agent 不带该字段");
  assert.equal(valid({ onlineUsers: [] }), true);
  assert.equal(valid({ onlineUsers: [{ bindingId: "b1", ipCount: 2 }] }), true);
  assert.equal(valid({ onlineUsers: [{ bindingId: "b1", ipCount: 0 }] }), false);
  assert.equal(valid({ onlineUsers: [{ bindingId: "", ipCount: 1 }] }), false);
  assert.equal(valid({ onlineUsers: Array.from({ length: 5001 }, (_, i) => ({ bindingId: `b${i}`, ipCount: 1 })) }), false);
}

function testSnapshot() {
  const node = { id: "node_us", name: "My-US", region: "美国", countryCode: "US", provider: "搬瓦工", protocol: "vless", security: "reality" };
  const subscription = {
    id: "sub_team", teamId: "team_1", state: "active" as const, expireAt: new Date("2026-12-27T00:00:00Z"),
    totalTrafficGb: 100, usedTrafficGb: 42, remainingTrafficGb: 58, plan: { name: "团队版" }, team: { name: "示例团队" }
  };
  const row = (overrides: Partial<DirectPresenceBindingRow>): DirectPresenceBindingRow => ({
    id: "b_owner", userId: "user_owner", directOnlineSince: ago(300), directLastOnlineAt: ago(10), directOnlineIpCount: 1,
    node, subscription, ...overrides
  });
  const leases = toDirectPresenceLeases([
    row({}),
    row({ id: "b_member", userId: "user_member", directLastOnlineAt: ago(DIRECT_ONLINE_WINDOW_SECONDS + 30) }),
    row({ id: "b_gone", userId: "user_gone", directOnlineIpCount: 0, directLastOnlineAt: ago(40) }),
    row({ id: "b_orphan", userId: null }),
    row({ id: "b_old", userId: "user_old", directOnlineIpCount: 0, directOnlineSince: ago(90 * 86_400), directLastOnlineAt: ago(30 * 86_400) })
  ], now);
  assert.equal(leases.length, 4, "没有用户的绑定忽略");

  const snapshot = buildAdminPresenceSnapshot({
    now,
    users: [
      { id: "user_owner", displayName: "团队负责人", email: "owner@example.com", teamMemberships: [{ team: { id: "team_1", name: "示例团队" } }] },
      { id: "user_member", displayName: "成员", email: "member@example.com", teamMemberships: [{ team: { id: "team_1", name: "示例团队" } }] },
      { id: "user_gone", displayName: "离开", email: "gone@example.com", teamMemberships: [] },
      { id: "user_old", displayName: "老用户", email: "old@example.com", teamMemberships: [] }
    ],
    presence: [], streams: [], leases, clientVersions: []
  });
  const owner = snapshot.users.find((user) => user.userId === "user_owner")!;
  assert.equal(owner.state, "connected", "订阅链接在线算已连接");
  assert.equal(owner.onlineSince, ago(300).toISOString());
  assert.equal(owner.sessions.length, 1);
  assert.equal(owner.sessions[0].via, "subscription_link");
  assert.equal(owner.sessions[0].onlineIpCount, 1);
  assert.equal(owner.sessions[0].connectionMode, null);
  assert.equal(owner.sessions[0].node.name, "My-US");
  const member = snapshot.users.find((user) => user.userId === "user_member")!;
  assert.equal(member.state, "offline", "节点超过窗口没再报告就算离线");
  assert.equal(member.lastOnlineAt, ago(DIRECT_ONLINE_WINDOW_SECONDS + 30).toISOString());
  const gone = snapshot.users.find((user) => user.userId === "user_gone")!;
  assert.equal(gone.state, "offline", "节点报告不在线即离线");
  assert.equal(gone.lastOnlineAt, ago(40).toISOString());
  const old = snapshot.users.find((user) => user.userId === "user_old")!;
  assert.equal(old.state, "offline");
  assert.equal(old.lastOnlineAt, ago(30 * 86_400).toISOString(), "离线一个月后仍显示最近在线时间");
  assert.deepEqual(snapshot.counts, { online: 1, connected: 1, idle: 0 });
}

async function main() {
  await testRecord();
  testHeartbeatDto();
  testSnapshot();
  console.log("direct presence regression ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
