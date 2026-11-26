import "reflect-metadata";
import assert from "node:assert/strict";
import { GUARDS_METADATA, HEADERS_METADATA } from "@nestjs/common/constants";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import {
  SubscriptionLinkSettingsController,
  UserSubscriptionLinkController
} from "../src/modules/admin/subscription-link.controller";
import {
  buildNodesDocument,
  buildNoticeDocument,
  buildNoticeShareLink,
  buildSubscriptionLinkUrl,
  buildVlessRealityShareLink,
  generateSubscriptionLinkToken,
  hashSubscriptionLinkToken,
  isSubscriptionLinkToken,
  SUBSCRIPTION_LINK_INVALID_NOTICE,
  SUBSCRIPTION_LINK_NOTICES,
  type SubscriptionLinkNode
} from "../src/modules/common/subscription-link";
import { SubscriptionLinkService } from "../src/modules/common/subscription-link.service";

// Subscription links for third-party clients: what the token is, what the link
// returns for every state a user can be in, and who may issue or reset one.

const DAY = 86_400_000;
const GIB = 1024n * 1024n * 1024n;

function decodeBody(body: string): string[] {
  return Buffer.from(body, "base64").toString("utf8").split("\n");
}

function shareNode(overrides: Partial<SubscriptionLinkNode> = {}): SubscriptionLinkNode {
  return {
    nodeId: "node_a",
    name: "美国 01",
    serverHost: "us1.example.com",
    serverPort: 443,
    uuid: "11111111-2222-4333-8444-555555555555",
    flow: "xtls-rprx-vision",
    realityPublicKey: "5C3G02RWVBX3e2tHAh9d69Vk4g8JwG2Zx2N0TTTPD2M",
    shortId: "0123abcd",
    serverName: "www.example.org",
    fingerprint: "chrome",
    spiderX: "/",
    mldsa65Verify: "",
    ...overrides
  };
}

// --- an in-memory stand-in for the tables the service reads -------------------

type Row = Record<string, any>;

function createDatabase() {
  const db = {
    users: [] as Row[],
    teams: [] as Row[],
    teamMembers: [] as Row[],
    subscriptions: [] as Row[],
    nodes: [] as Row[],
    accesses: [] as Row[],
    bindings: [] as Row[],
    links: [] as Row[],
    settings: null as Row | null,
    /** Runs once, just before the next subscriptionLink.create, to stage a race. */
    beforeLinkCreate: null as null | (() => void)
  };
  const bySubscriptionOrder = (left: Row, right: Row) =>
    right.expireAt.getTime() - left.expireAt.getTime() || right.createdAt.getTime() - left.createdAt.getTime();
  const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  const prisma = {
    systemSetting: {
      findUnique: async () => db.settings,
      upsert: async ({ create, update }: any) =>
        (db.settings = { ...create, ...update, updatedAt: new Date("2026-11-26T00:00:00Z") })
    },
    user: {
      findUnique: async ({ where }: any) => db.users.find((user) => user.id === where.id) ?? null
    },
    teamMember: {
      findUnique: async ({ where }: any) => {
        const member = db.teamMembers.find((item) => item.userId === where.userId);
        if (!member) return null;
        const team = db.teams.find((item) => item.id === member.teamId)!;
        return {
          ...member,
          team: {
            ...team,
            subscriptions: db.subscriptions.filter((item) => item.teamId === team.id).sort(bySubscriptionOrder)
          }
        };
      }
    },
    subscription: {
      findMany: async ({ where }: any) =>
        db.subscriptions.filter((item) => item.userId === where.userId).sort(bySubscriptionOrder)
    },
    panelClientBinding: {
      findMany: async ({ where }: any) =>
        db.bindings
          .filter(
            (item) =>
              item.subscriptionId === where.subscriptionId &&
              item.userId === where.userId &&
              item.status === where.status &&
              item.source === where.source
          )
          .map((item) => ({ ...item, node: db.nodes.find((node) => node.id === item.nodeId)! }))
    },
    subscriptionNodeAccess: {
      findMany: async ({ where }: any) =>
        db.accesses.filter((item) => item.subscriptionId === where.subscriptionId).map((item) => ({ nodeId: item.nodeId }))
    },
    subscriptionLink: {
      findUnique: async ({ where }: any) => db.links.find((link) => link.userId === where.userId) ?? null,
      create: async ({ data }: any) => {
        const stage = db.beforeLinkCreate;
        db.beforeLinkCreate = null;
        stage?.();
        if (db.links.some((link) => link.userId === data.userId || link.token === data.token)) throw uniqueViolation();
        const row = { createdAt: new Date(), rotatedAt: null, ...data };
        db.links.push(row);
        return row;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = db.links.find((link) => link.userId === where.userId);
        if (existing) return Object.assign(existing, update);
        const row = { createdAt: new Date(), rotatedAt: null, ...create };
        db.links.push(row);
        return row;
      }
    }
  };
  return { db, service: new SubscriptionLinkService(prisma as never) };
}

function subscription(overrides: Row = {}): Row {
  return {
    id: "sub_1",
    userId: "user_1",
    teamId: null,
    state: "active",
    expireAt: new Date(Date.now() + 30 * DAY),
    createdAt: new Date(Date.now() - 10 * DAY),
    totalTrafficGb: 100,
    usedTrafficGb: 25,
    remainingTrafficGb: 75,
    totalTrafficBytes: 100n * GIB,
    usedTrafficBytes: 25n * GIB,
    ...overrides
  };
}

function nodeRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    name: `节点 ${id}`,
    isActive: true,
    protocol: "vless",
    security: "reality",
    serverHost: `${id}.example.com`,
    serverPort: 443,
    uuid: "99999999-9999-4999-8999-999999999999",
    flow: "xtls-rprx-vision",
    realityPublicKey: "5C3G02RWVBX3e2tHAh9d69Vk4g8JwG2Zx2N0TTTPD2M",
    shortId: "0123abcd",
    serverName: "www.example.org",
    fingerprint: "chrome",
    spiderX: "/",
    mldsa65Verify: "",
    registrationStatus: "agent_ready",
    ...overrides
  };
}

function binding(nodeId: string, overrides: Row = {}): Row {
  return {
    id: `binding_${nodeId}`,
    subscriptionId: "sub_1",
    userId: "user_1",
    nodeId,
    status: "active",
    source: "direct",
    panelClientId: `uuid-of-user_1-on-${nodeId}`,
    ...overrides
  };
}

/** One active user with an active personal subscription and a live credential on each of `nodeIds`. */
function seedPersonal(nodeIds: string[] = ["node_a", "node_b"]) {
  const context = createDatabase();
  context.db.users.push({ id: "user_1", status: "active" });
  context.db.subscriptions.push(subscription());
  for (const nodeId of nodeIds) {
    context.db.nodes.push(nodeRow(nodeId));
    context.db.accesses.push({ subscriptionId: "sub_1", nodeId });
    context.db.bindings.push(binding(nodeId));
  }
  return context;
}

async function main() {
  // --- the token --------------------------------------------------------------

  const first = generateSubscriptionLinkToken();
  const second = generateSubscriptionLinkToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/, "token 是 32 字节随机数的 base64url，可以直接放进路径");
  assert.equal(Buffer.from(first, "base64url").length, 32);
  assert.notEqual(first, second);
  assert.equal(isSubscriptionLinkToken(first), true);
  for (const bad of ["", "short", `${first}x`, first.slice(1), `${first.slice(0, 42)}/`, `${first.slice(0, 42)}=`]) {
    assert.equal(isSubscriptionLinkToken(bad), false, `${JSON.stringify(bad)} 不是合法 token`);
  }
  // The distribution layer is keyed by this and by nothing else, so the
  // definition is pinned to a published test vector rather than to itself.
  assert.equal(
    hashSubscriptionLinkToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(buildSubscriptionLinkUrl("https://my.example.com", first), `https://my.example.com/s/${first}`);
  assert.equal(buildSubscriptionLinkUrl("https://my.example.com/", first), `https://my.example.com/s/${first}`);

  // --- one node as a share link -------------------------------------------------

  assert.equal(
    buildVlessRealityShareLink(shareNode()),
    "vless://11111111-2222-4333-8444-555555555555@us1.example.com:443" +
      "?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.org&fp=chrome" +
      "&pbk=5C3G02RWVBX3e2tHAh9d69Vk4g8JwG2Zx2N0TTTPD2M&sid=0123abcd&spx=%2F&type=tcp&headerType=none" +
      "#%E7%BE%8E%E5%9B%BD%2001"
  );
  {
    // Every field survives a standards-conforming parse: what a client reads
    // back is what the node row said.
    const node = shareNode({ name: "日本 #2 / 直连 & 50%", spiderX: "/path?x=1 2", shortId: "" });
    const url = new URL(buildVlessRealityShareLink(node));
    assert.equal(url.protocol, "vless:");
    assert.equal(url.username, node.uuid);
    assert.equal(url.hostname, node.serverHost);
    assert.equal(url.port, "443");
    assert.equal(url.searchParams.get("pbk"), node.realityPublicKey);
    assert.equal(url.searchParams.get("sni"), node.serverName);
    assert.equal(url.searchParams.get("sid"), "");
    assert.equal(url.searchParams.get("spx"), "/path?x=1 2");
    assert.equal(url.searchParams.get("security"), "reality");
    assert.equal(decodeURIComponent(url.hash.slice(1)), node.name);
    assert.ok(!buildVlessRealityShareLink(node).includes("+"), "空格必须写成 %20，不能写成 +");
  }
  // The agent installs a user with the vision flow or with none; a link must
  // not name a flow the node will not accept.
  for (const flow of ["", "none", "xtls-rprx-direct"]) {
    assert.ok(!buildVlessRealityShareLink(shareNode({ flow })).includes("flow="), `flow=${JSON.stringify(flow)} 不应写进链接`);
  }
  assert.ok(
    buildVlessRealityShareLink(shareNode({ serverHost: "2001:db8::1" })).includes("@[2001:db8::1]:443?"),
    "IPv6 地址必须加方括号"
  );
  assert.ok(buildVlessRealityShareLink(shareNode({ serverHost: "[2001:db8::1]" })).includes("@[2001:db8::1]:443?"));
  assert.ok(buildVlessRealityShareLink(shareNode({ spiderX: "" })).includes("&spx=%2F&"));
  assert.ok(!buildVlessRealityShareLink(shareNode({ mldsa65Verify: null })).includes("pqv="));
  assert.ok(buildVlessRealityShareLink(shareNode({ mldsa65Verify: " abc_DEF-123 " })).includes("&pqv=abc_DEF-123#"));

  // --- the document ------------------------------------------------------------

  {
    const usage = { usedBytes: 25n * GIB, totalBytes: 100n * GIB, expireAt: new Date("2027-01-01T00:00:00Z") };
    const a = shareNode({ nodeId: "node_a", name: "B 节点" });
    const b = shareNode({ nodeId: "node_b", name: "A 节点", uuid: "22222222-2222-4222-8222-222222222222" });
    const c = shareNode({ nodeId: "node_c", name: "A 节点", uuid: "33333333-3333-4333-8333-333333333333" });
    const document = buildNodesDocument([a, b, c], usage);
    assert.equal(document.kind, "nodes");
    assert.equal(document.notice, null);
    assert.deepEqual(document.nodes.map((node) => node.nodeId), ["node_b", "node_c", "node_a"], "按名称排序，同名按节点 ID");
    assert.deepEqual(decodeBody(document.body), [b, c, a].map(buildVlessRealityShareLink));
    assert.equal(document.userinfo, "upload=0; download=26843545600; total=107374182400; expire=1798761600");
    // Published on change: the same state must render to the same bytes
    // whatever order the rows came back in.
    assert.deepEqual(buildNodesDocument([c, a, b], usage), document);
    assert.equal(
      buildNodesDocument([a], { ...usage, usedBytes: -5n }).userinfo,
      "upload=0; download=0; total=107374182400; expire=1798761600",
      "负的已用流量按 0 输出"
    );

    // No nodes is a notice, never an empty body: an empty subscription makes
    // clients keep what they already have.
    const empty = buildNodesDocument([], usage);
    assert.equal(empty.kind, "notice");
    assert.equal(empty.notice, SUBSCRIPTION_LINK_NOTICES.no_nodes);
    assert.deepEqual(decodeBody(empty.body), [buildNoticeShareLink(SUBSCRIPTION_LINK_NOTICES.no_nodes)]);
    assert.equal(empty.userinfo, document.userinfo);
  }
  {
    const notice = buildNoticeDocument(SUBSCRIPTION_LINK_INVALID_NOTICE);
    assert.equal(notice.userinfo, null);
    const [line, ...rest] = decodeBody(notice.body);
    assert.deepEqual(rest, []);
    const url = new URL(line);
    assert.equal(url.protocol, "vless:");
    assert.equal(url.hostname, "127.0.0.1", "提示节点不能指向任何真实服务器");
    assert.equal(decodeURIComponent(url.hash.slice(1)), SUBSCRIPTION_LINK_INVALID_NOTICE);
    for (const text of Object.values(SUBSCRIPTION_LINK_NOTICES)) {
      assert.notEqual(text, SUBSCRIPTION_LINK_INVALID_NOTICE, "链接无效的提示不能和某个账号状态的提示相同");
    }
  }

  // --- what a user's link returns ------------------------------------------------

  {
    const { service } = seedPersonal();
    const document = await service.render("user_1");
    assert.equal(document.kind, "nodes");
    assert.deepEqual(document.nodes, [
      { nodeId: "node_a", name: "节点 node_a" },
      { nodeId: "node_b", name: "节点 node_b" }
    ]);
    const lines = decodeBody(document.body);
    assert.equal(new URL(lines[0]).username, "uuid-of-user_1-on-node_a", "链接里是用户自己在该节点上的凭据");
    assert.equal(new URL(lines[1]).username, "uuid-of-user_1-on-node_b");
    assert.ok(!document.body.includes("99999999"), "节点行上的共享 UUID 不能出现在订阅里");
    assert.match(document.userinfo ?? "", /^upload=0; download=26843545600; total=107374182400; expire=\d+$/);
  }

  // Each reason a link has nothing to give is its own sentence.
  const notices: Array<[string, (db: ReturnType<typeof createDatabase>["db"]) => void, string, boolean]> = [
    ["账号被停用", (db) => { db.users[0].status = "disabled"; }, SUBSCRIPTION_LINK_NOTICES.account_disabled, false],
    ["账号不存在", (db) => { db.users.length = 0; }, SUBSCRIPTION_LINK_NOTICES.account_disabled, false],
    ["没有订阅", (db) => { db.subscriptions.length = 0; }, SUBSCRIPTION_LINK_NOTICES.no_subscription, false],
    ["订阅过了到期时间", (db) => { db.subscriptions[0].expireAt = new Date(Date.now() - 1000); }, SUBSCRIPTION_LINK_NOTICES.subscription_expired, true],
    ["订阅被标记为到期", (db) => { db.subscriptions[0].state = "expired"; }, SUBSCRIPTION_LINK_NOTICES.subscription_expired, true],
    ["流量用完", (db) => { db.subscriptions[0].remainingTrafficGb = 0; }, SUBSCRIPTION_LINK_NOTICES.subscription_exhausted, true],
    ["订阅被标记为用尽", (db) => { db.subscriptions[0].state = "exhausted"; }, SUBSCRIPTION_LINK_NOTICES.subscription_exhausted, true],
    ["订阅暂停", (db) => { db.subscriptions[0].state = "paused"; }, SUBSCRIPTION_LINK_NOTICES.subscription_paused, true],
    ["没有分配节点", (db) => { db.accesses.length = 0; db.bindings.length = 0; }, SUBSCRIPTION_LINK_NOTICES.no_nodes, true]
  ];
  for (const [label, mutate, expected, hasUsage] of notices) {
    const { db, service } = seedPersonal();
    mutate(db);
    const document = await service.render("user_1");
    assert.equal(document.kind, "notice", label);
    assert.equal(document.notice, expected, label);
    assert.deepEqual(document.nodes, [], label);
    assert.deepEqual(decodeBody(document.body), [buildNoticeShareLink(expected)], `${label}：只返回一条提示节点`);
    assert.ok(!document.body.includes("uuid-of-user_1"), `${label}：不能带出任何凭据`);
    assert.equal(document.userinfo !== null, hasUsage, `${label}：有订阅才带用量信息`);
  }

  // A credential row can outlive what it was issued for; only a node the user
  // can actually use right now is listed.
  const excluded: Array<[string, (db: ReturnType<typeof createDatabase>["db"]) => void]> = [
    ["凭据已停用", (db) => { db.bindings[1].status = "disabled"; }],
    ["凭据已删除", (db) => { db.bindings[1].status = "deleted"; }],
    ["凭据不是 Agent 直管的", (db) => { db.bindings[1].source = "xui"; }],
    ["凭据属于别的订阅", (db) => { db.bindings[1].subscriptionId = "sub_old"; }],
    ["凭据属于别的用户", (db) => { db.bindings[1].userId = "user_2"; }],
    ["节点已取消授权", (db) => { db.accesses.pop(); }],
    ["节点已下线", (db) => { db.nodes[1].isActive = false; }],
    ["节点还没完成接入", (db) => { db.nodes[1].registrationStatus = "pending_register"; }],
    ["节点地址还是占位符", (db) => { db.nodes[1].serverHost = "pending-agent"; }],
    ["节点不是 Reality", (db) => { db.nodes[1].registrationStatus = null; db.nodes[1].security = "tls"; }],
    ["节点缺 Reality 公钥", (db) => { db.nodes[1].registrationStatus = null; db.nodes[1].realityPublicKey = " "; }]
  ];
  for (const [label, mutate] of excluded) {
    const { db, service } = seedPersonal();
    mutate(db);
    const document = await service.render("user_1");
    assert.deepEqual(document.nodes.map((node) => node.nodeId), ["node_a"], label);
    assert.equal(decodeBody(document.body).length, 1, label);
  }

  {
    // A team member's link follows the TEAM's subscription and lists only the
    // member's own credentials — never a teammate's, and never the personal
    // subscription they may also still have.
    const { db, service } = createDatabase();
    db.users.push({ id: "user_1", status: "active" }, { id: "user_2", status: "active" });
    db.teams.push({ id: "team_1", status: "active" });
    db.teamMembers.push({ userId: "user_1", teamId: "team_1" }, { userId: "user_2", teamId: "team_1" });
    db.subscriptions.push(
      subscription({ id: "sub_team", userId: null, teamId: "team_1", totalTrafficBytes: 500n * GIB, usedTrafficBytes: 1n * GIB }),
      subscription({ id: "sub_personal" })
    );
    db.nodes.push(nodeRow("node_a"), nodeRow("node_b"));
    db.accesses.push({ subscriptionId: "sub_team", nodeId: "node_a" }, { subscriptionId: "sub_personal", nodeId: "node_b" });
    db.bindings.push(
      binding("node_a", { subscriptionId: "sub_team", panelClientId: "uuid-of-user_1-on-team" }),
      binding("node_a", { id: "binding_other", subscriptionId: "sub_team", userId: "user_2", panelClientId: "uuid-of-user_2-on-team" }),
      binding("node_b", { subscriptionId: "sub_personal", panelClientId: "uuid-of-user_1-personal" })
    );
    const document = await service.render("user_1");
    assert.deepEqual(document.nodes.map((node) => node.nodeId), ["node_a"]);
    assert.deepEqual(decodeBody(document.body).map((line) => new URL(line).username), ["uuid-of-user_1-on-team"]);
    assert.match(document.userinfo ?? "", /download=1073741824; total=536870912000;/, "用量是团队订阅的用量");

    db.teams[0].status = "disabled";
    const disabled = await service.render("user_1");
    assert.equal(disabled.notice, SUBSCRIPTION_LINK_NOTICES.team_disabled);
    assert.ok(!disabled.body.includes("uuid-of-user_1"));
  }
  {
    // Subscriptions that predate byte accounting carry only the GB figures.
    const { db, service } = seedPersonal(["node_a"]);
    Object.assign(db.subscriptions[0], { totalTrafficBytes: 0n, usedTrafficBytes: 0n, totalTrafficGb: 2, usedTrafficGb: 0.5 });
    assert.match((await service.render("user_1")).userinfo ?? "", /download=536870912; total=2147483648;/);
  }

  // --- issuing and resetting ------------------------------------------------------

  {
    const { db, service } = seedPersonal(["node_a"]);
    await assert.rejects(service.getForUser("nobody"), NotFoundException);
    await assert.rejects(service.ensureForUser("nobody"), NotFoundException);
    await assert.rejects(service.resetForUser("nobody"), NotFoundException);
    assert.equal(db.links.length, 0, "不存在的用户不能留下链接");

    assert.deepEqual(await service.getForUser("user_1"), { link: null }, "查看不会顺手签发链接");
    assert.equal(db.links.length, 0);

    const previousOrigin = process.env.CHORDV_SUBSCRIPTION_LINK_ORIGIN;
    delete process.env.CHORDV_SUBSCRIPTION_LINK_ORIGIN;
    try {
      const issued = (await service.ensureForUser("user_1")).link!;
      assert.equal(db.links.length, 1);
      const token = db.links[0].token as string;
      assert.equal(isSubscriptionLinkToken(token), true);
      assert.equal(db.links[0].tokenHash, hashSubscriptionLinkToken(token));
      assert.equal(issued.url, null, "没配置订阅域名时没有可用的链接");
      assert.equal(issued.backupUrl, null);
      assert.equal(issued.rotatedAt, null);
      assert.deepEqual(issued.preview, { kind: "nodes", notice: null, nodes: [{ nodeId: "node_a", name: "节点 node_a" }] });

      // The environment supplies a default; a saved setting replaces it.
      process.env.CHORDV_SUBSCRIPTION_LINK_ORIGIN = " https://env.example.com/ ";
      assert.equal((await service.getForUser("user_1")).link!.url, `https://env.example.com/s/${token}`);
      for (const unusable of ["http://env.example.com", "https://env.example.com/sub", "not a url"]) {
        process.env.CHORDV_SUBSCRIPTION_LINK_ORIGIN = unusable;
        assert.deepEqual(await service.getSettings(), { origin: null, backupOrigin: null, updatedAt: null }, `${unusable} 不可用时按未配置处理`);
      }
      process.env.CHORDV_SUBSCRIPTION_LINK_ORIGIN = "https://env.example.com";

      for (const bad of [
        { origin: "http://my.example.com", backupOrigin: null },
        { origin: "https://my.example.com/s", backupOrigin: null },
        { origin: "https://u:p@my.example.com", backupOrigin: null },
        { origin: "https://my.example.com", backupOrigin: "https://MY.example.com/" },
        { origin: null, backupOrigin: "https://backup.example.net" },
        { origin: "  ", backupOrigin: "https://backup.example.net" }
      ]) {
        await assert.rejects(service.saveSettings(bad), BadRequestException, JSON.stringify(bad));
      }
      assert.equal(db.settings, null, "被拒绝的设置不能落库");
      const saved = await service.saveSettings({ origin: " https://MY.example.com/ ", backupOrigin: "https://backup.example.net" });
      assert.equal(saved.origin, "https://my.example.com");
      assert.equal(saved.backupOrigin, "https://backup.example.net");
      const shown = (await service.getForUser("user_1")).link!;
      assert.equal(shown.url, `https://my.example.com/s/${token}`);
      assert.equal(shown.backupUrl, `https://backup.example.net/s/${token}`);

      // Issuing again hands back the same link: a customer's link must not
      // change because an admin opened the page twice.
      assert.equal((await service.ensureForUser("user_1")).link!.url, shown.url);
      assert.equal(db.links.length, 1);
      assert.equal(db.links[0].token, token);

      const createdAt = db.links[0].createdAt as Date;
      const reset = (await service.resetForUser("user_1")).link!;
      const nextToken = db.links[0].token as string;
      assert.equal(db.links.length, 1);
      assert.notEqual(nextToken, token, "重置必须换掉 token");
      assert.equal(db.links[0].tokenHash, hashSubscriptionLinkToken(nextToken));
      assert.equal(reset.url, `https://my.example.com/s/${nextToken}`);
      assert.equal(reset.createdAt, createdAt.toISOString());
      assert.ok(reset.rotatedAt, "重置时间要记下来");
      assert.deepEqual(reset.preview.nodes, shown.preview.nodes, "重置只换链接，不动节点和凭据");

      // Clearing the setting takes the links down rather than falling back to
      // the environment: an explicit choice wins over a default.
      await service.saveSettings({ origin: null, backupOrigin: null });
      assert.equal((await service.getForUser("user_1")).link!.url, null);
    } finally {
      if (previousOrigin === undefined) delete process.env.CHORDV_SUBSCRIPTION_LINK_ORIGIN;
      else process.env.CHORDV_SUBSCRIPTION_LINK_ORIGIN = previousOrigin;
    }
  }
  {
    // Resetting a user who never had a link issues one.
    const { db, service } = seedPersonal(["node_a"]);
    const reset = (await service.resetForUser("user_1")).link!;
    assert.equal(db.links.length, 1);
    assert.equal(reset.rotatedAt, null, "第一次签发不算重置");
  }
  {
    // Two admins issue at the same moment: both must end up holding the same
    // link, not one of them an error.
    const { db, service } = seedPersonal(["node_a"]);
    db.beforeLinkCreate = () => {
      db.links.push({ userId: "user_1", token: "w".repeat(43), tokenHash: "winner", createdAt: new Date(), rotatedAt: null });
    };
    await service.saveSettings({ origin: "https://my.example.com", backupOrigin: null });
    const issued = (await service.ensureForUser("user_1")).link!;
    assert.equal(issued.url, `https://my.example.com/s/${"w".repeat(43)}`);
    assert.equal(db.links.length, 1);
  }

  // --- who may reach it -------------------------------------------------------------

  for (const controller of [UserSubscriptionLinkController, SubscriptionLinkSettingsController]) {
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, controller), [AdminAuthGuard], `${controller.name} 只允许管理员`);
  }
  // A response carrying a link is a response carrying a credential.
  for (const method of ["get", "ensure", "reset"] as const) {
    assert.deepEqual(
      Reflect.getMetadata(HEADERS_METADATA, UserSubscriptionLinkController.prototype[method]),
      [{ name: "Cache-Control", value: "no-store" }],
      `${method} 的响应不能被缓存`
    );
  }
  {
    const calls: string[] = [];
    const controller = new UserSubscriptionLinkController({
      getForUser: async (userId: string) => { calls.push(`get:${userId}`); return { link: null }; },
      ensureForUser: async (userId: string) => { calls.push(`ensure:${userId}`); return { link: null }; },
      resetForUser: async (userId: string) => { calls.push(`reset:${userId}`); return { link: null }; }
    } as never);
    await controller.get("user_1");
    await controller.ensure("user_1");
    await controller.reset("user_1");
    assert.deepEqual(calls, ["get:user_1", "ensure:user_1", "reset:user_1"]);
  }

  console.log("subscription-link.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
