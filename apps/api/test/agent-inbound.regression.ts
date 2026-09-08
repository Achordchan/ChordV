import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AgentService } from "../src/modules/agent/agent.service";
import { renderInstallScript, renderXrayInstall } from "../src/modules/agent/agent-install.controller";
import {
  INBOUND_DEFAULTS,
  inboundSpecKey,
  isPublicUnicastAddress,
  normalizeInboundSpec,
  parseIPv6Bytes,
  SUPPORTED_FINGERPRINTS,
  parseInboundReport
} from "../src/modules/agent/agent-inbound";
import { DEFAULT_TRUSTED_PROXIES, resolveTrustProxy } from "../src/trust-proxy";
import { isNodeOnboardingReady } from "../src/modules/common/node-onboarding-policy";
import { toAdminNodeRecord } from "../src/modules/common/node-import.utils";

const read = (relative: string) => readFileSync(path.resolve(__dirname, relative), "utf8");

const goodReport = (overrides: Record<string, unknown> = {}) => ({
  inbound: {
    requestId: "11111111-2222-4333-8444-555555555555",
    inboundTag: "vless-in",
    serverHost: "203.0.113.7",
    serverPort: 443,
    realityPublicKey: "k".repeat(43),
    shortId: "0123456789abcdef",
    serverName: "www.microsoft.com",
    flow: "xtls-rprx-vision",
    fingerprint: "chrome",
    spiderX: "/",
    xrayVersion: "Xray 1.8.24",
    changed: true,
    liveVerifiedAt: "2026-09-07T00:00:00.000Z",
    ...overrides
  }
});

function testCommandTypeIsDeclaredEverywhere() {
  // Six declaration sites; a missing one is either a compile error or, worse,
  // a command the server will happily queue and the agent will reject.
  assert.match(read("../../../packages/shared/src/types.ts"), /\|\s*"ENSURE_INBOUND"/);
  assert.match(read("../prisma/schema.prisma"), /enum NodeAgentCommandType \{[^}]*ENSURE_INBOUND/s);
  assert.match(read("../src/modules/agent/agent.dto.ts"), /@IsIn\(\[[^\]]*"ENSURE_INBOUND"/s);
  assert.match(read("../../node-agent/src/types.ts"), /AGENT_COMMAND_TYPES = \[[^\]]*'ENSURE_INBOUND'/s);
  // The runtime-session union drifted from the shared type once; it must now be
  // imported rather than re-listed.
  const runtimeSession = read("../src/modules/common/runtime-session.service.ts");
  assert.match(runtimeSession, /commandType: NodeAgentCommandType,/);
  assert.equal(/commandType: "ENSURE_USER" \| "ENABLE_USER"/.test(runtimeSession), false);
  const migrations = read("../prisma/migrations/20260907200000_agent_ensure_inbound_command/migration.sql");
  assert.match(migrations, /ALTER TYPE "NodeAgentCommandType" ADD VALUE IF NOT EXISTS 'ENSURE_INBOUND';/);
}

function testSpecNormalization() {
  const spec = normalizeInboundSpec({});
  assert.deepEqual(spec, { ...INBOUND_DEFAULTS, serverNames: [...INBOUND_DEFAULTS.serverNames], rotateKeys: false });
  assert.equal(normalizeInboundSpec({ listenPort: 8443 }).listenPort, 8443);
  assert.equal(normalizeInboundSpec({ rotateKeys: true }).rotateKeys, true);
  for (const fingerprint of SUPPORTED_FINGERPRINTS) {
    assert.equal(normalizeInboundSpec({ fingerprint }).fingerprint, fingerprint);
  }

  for (const [label, payload] of [
    ["port too large", { listenPort: 70000 }],
    ["port zero", { listenPort: 0 }],
    ["port not an integer", { listenPort: 443.5 }],
    ["dest without port", { dest: "www.microsoft.com" }],
    ["dest hostname invalid", { dest: "bad host:443" }],
    // The Reality fallback forwards unauthenticated public traffic to `dest`:
    // a loopback/private target would tunnel into the machine's own services.
    ["dest loopback", { dest: "127.0.0.1:10085" }],
    ["dest localhost", { dest: "localhost:443" }],
    ["dest private", { dest: "10.0.0.5:443" }],
    ["dest metadata", { dest: "169.254.169.254:80" }],
    ["empty serverNames", { serverNames: [] }],
    ["too many serverNames", { serverNames: Array(9).fill("a.example.com") }],
    ["serverName invalid", { serverNames: ["bad host"] }],
    ["unsupported flow", { flow: "xtls-rprx-direct" }],
    ["fingerprint invalid", { fingerprint: "Chrome!" }],
    // A client-side setting the server can never verify: Xray accepts the
    // deployment either way and every generated config carries the bad value.
    ["fingerprint unsupported", { fingerprint: "garbage" }],
    ["spiderX without slash", { spiderX: "path" }],
    ["spiderX with quote", { spiderX: '/a"b' }],
    ["rotateKeys not boolean", { rotateKeys: "yes" }],
    ["inboundTag invalid", { inboundTag: "a b" }]
  ] as const) {
    assert.throws(() => normalizeInboundSpec(payload as Record<string, unknown>), /入站参数|不合法/, `应拒绝：${label}`);
  }

  // Re-issuing the same deployment must collapse onto one job, whatever the
  // key order or serverNames order.
  assert.equal(
    inboundSpecKey("node-1", normalizeInboundSpec({ serverNames: ["a.example.com", "b.example.com"] })),
    inboundSpecKey("node-1", normalizeInboundSpec({ serverNames: ["b.example.com", "a.example.com"] }))
  );
  assert.notEqual(inboundSpecKey("node-1", spec), inboundSpecKey("node-2", spec));
  assert.notEqual(inboundSpecKey("node-1", spec), inboundSpecKey("node-1", normalizeInboundSpec({ listenPort: 8443 })));
}

function testPublicAddressPolicy() {
  for (const host of ["203.0.113.7", "8.8.8.8", "2001:db8::1"]) {
    assert.equal(isPublicUnicastAddress(host), true, `${host} 应视为公网地址`);
  }
  for (const host of [
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.10.1",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "ff02::1",
    // Same addresses spelled differently: text prefixes would let these through
    // and make an unreachable endpoint activatable.
    "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::ffff:192.168.1.1",
    "::ffff:127.0.0.1", "[::1]", "fc00:0:0:0:0:0:0:1", "FE80::abcd",
    "pending-agent", "example.com", ""
  ]) {
    assert.equal(isPublicUnicastAddress(host), false, `${host} 不应被当作可用公网地址`);
  }
  // A hostname is not accepted here: clients dial what the agent reported, and
  // the agent reports the address the control plane observed.
  assert.equal(isPublicUnicastAddress("172.32.0.1"), true, "172.32/12 之外不属于私网");
  assert.equal(isPublicUnicastAddress("::ffff:203.0.113.7"), true, "映射的公网 IPv4 仍可用");
  assert.deepEqual(parseIPv6Bytes("::1")?.slice(-2), [0, 1]);
  assert.deepEqual(parseIPv6Bytes("2001:db8::1")?.slice(0, 4), [0x20, 0x01, 0x0d, 0xb8]);
  assert.equal(parseIPv6Bytes("not-an-address"), null);
}

function testReportValidation() {
  const spec = normalizeInboundSpec({});
  assert.deepEqual(parseInboundReport(goodReport(), spec), {
    serverHost: "203.0.113.7",
    serverPort: 443,
    realityPublicKey: "k".repeat(43),
    shortId: "0123456789abcdef",
    serverName: "www.microsoft.com",
    flow: "xtls-rprx-vision",
    fingerprint: "chrome",
    spiderX: "/"
  });

  for (const [label, overrides] of [
    ["private address", { serverHost: "10.1.2.3" }],
    ["loopback", { serverHost: "127.0.0.1" }],
    ["placeholder", { serverHost: "pending-agent" }],
    ["port mismatch", { serverPort: 8443 }],
    ["short public key", { realityPublicKey: "k".repeat(20) }],
    ["odd shortId", { shortId: "abc" }],
    ["non-hex shortId", { shortId: "zzzz" }],
    ["unordered serverName", { serverName: "www.example.org" }],
    ["tag mismatch", { inboundTag: "other" }],
    ["flow mismatch", { flow: "" }],
    ["fingerprint mismatch", { fingerprint: "safari" }],
    ["spiderX mismatch", { spiderX: "/other" }]
  ] as const) {
    assert.throws(() => parseInboundReport(goodReport(overrides as Record<string, unknown>), spec), /Agent 上报/, `应拒绝：${label}`);
  }
  assert.throws(() => parseInboundReport({}, spec), /缺少 inbound/);
  assert.throws(() => parseInboundReport(undefined, spec), /缺少入站部署结果/);
}

async function testWriteBackAndActivation() {
  const spec = normalizeInboundSpec({});
  const node: Record<string, unknown> = {
    registrationStatus: "agent_ready",
    protocol: "vless",
    security: "reality",
    serverHost: "pending-agent",
    serverPort: 0,
    uuid: "11111111-1111-4111-8111-111111111111",
    realityPublicKey: "",
    serverName: "",
    fingerprint: "chrome",
    isActive: false
  };
  // Before the inbound report the node can never be activated: this is exactly
  // the gap R2 closes.
  assert.equal(isNodeOnboardingReady(node), false);

  const runComplete = async (options: { result: unknown; appliedRevision?: bigint }) => {
    const updates: Array<Record<string, unknown>> = [];
    const jobUpdates: Array<Record<string, unknown>> = [];
    let applied = options.appliedRevision ?? 0n;
    const tx = {
      $queryRaw: async () => [],
      nodeCommandJob: {
        findFirst: async () => ({ id: "command-1", commandType: "ENSURE_INBOUND", payload: spec, targetRevision: 5n, dedupeKey: "node-1:ENSURE_INBOUND:abc" }),
        update: async ({ data }: { data: Record<string, unknown> }) => { jobUpdates.push(data); return {}; }
      },
      node: {
        // Mirrors the conditional UPDATE: a stale writer matches no rows.
        updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, unknown> }) => {
          if (applied >= (where.inboundAppliedRevision?.lt as bigint)) return { count: 0 };
          applied = data.inboundAppliedRevision as bigint;
          updates.push(data);
          return { count: 1 };
        }
      },
      panelClientBinding: { updateMany: async () => ({ count: 0 }) }
    };
    const service = new AgentService(
      { $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx) } as never,
      { publish() {} } as never,
      { publishSubscriptionUpdated: async () => undefined } as never
    );
    await service.completeCommand({ id: "agent-1", nodeId: "node-1" } as never, "command-1", { status: "completed", result: options.result } as never);
    // Completing an ENSURE_INBOUND releases its dedupe key.
    assert.match(String(jobUpdates[0]?.dedupeKey ?? ""), /:done:command-1$/);
    return updates;
  };

  const [written] = await runComplete({ result: goodReport() });
  assert.equal(written?.inboundAppliedRevision, 5n, "写回必须同时推进已应用 revision");
  delete written?.inboundAppliedRevision;
  assert.deepEqual(written, {
    serverHost: "203.0.113.7",
    serverPort: 443,
    realityPublicKey: "k".repeat(43),
    shortId: "0123456789abcdef",
    serverName: "www.microsoft.com",
    flow: "xtls-rprx-vision",
    fingerprint: "chrome",
    spiderX: "/"
  });
  // Activation becomes POSSIBLE, but the node stays inactive: shipping users to
  // an inbound nobody smoke-tested is the operator's call.
  assert.equal(isNodeOnboardingReady({ ...node, ...written }), true);
  assert.equal(Object.hasOwn(written, "isActive"), false);
  assert.equal(Object.hasOwn(written, "registrationStatus"), false);

  // A report that fails validation writes nothing at all — half-applied
  // connection parameters look activatable and cannot connect.
  await assert.rejects(runComplete({ result: goodReport({ serverHost: "10.0.0.9" }) }), /公网地址不可用/);

  // A delayed result must not overwrite a newer deployment. The guard is the
  // conditional update itself, so two concurrent completions cannot interleave.
  assert.deepEqual(await runComplete({ result: goodReport(), appliedRevision: 9n }), []);
}

async function testDedupeReleaseIsInboundOnly() {
  // Other command types keep their caller-supplied key as an idempotency
  // contract: releasing it would let a delayed ENABLE_USER retry re-enable a
  // user who has since been disabled.
  for (const [commandType, released] of [["ENSURE_INBOUND", true], ["ENABLE_USER", false]] as const) {
    const jobUpdates: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: async () => [],
      nodeCommandJob: {
        findFirst: async () => ({ id: "job-1", commandType, payload: {}, targetRevision: 5n, dedupeKey: "node-1:key" }),
        update: async ({ data }: { data: Record<string, unknown> }) => { jobUpdates.push(data); return {}; }
      },
      node: { updateMany: async () => ({ count: 1 }) },
      panelClientBinding: { updateMany: async () => ({ count: 0 }) }
    };
    const service = new AgentService(
      { $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx) } as never,
      { publish() {} } as never,
      { publishSubscriptionUpdated: async () => undefined } as never
    );
    const result = commandType === "ENSURE_INBOUND" ? goodReport() : { disableWatermarks: {} };
    await service.completeCommand({ id: "agent-1", nodeId: "node-1" } as never, "job-1", { status: "completed", result } as never);
    assert.equal(Object.hasOwn(jobUpdates[0] ?? {}, "dedupeKey"), released, `${commandType} 的去重键释放策略不符`);
  }
}

/** In-memory NodeCommandJob table modelling the unique index, a monotonic clock, and per-node serialization. */
function commandJobStore() {
  const rows: Array<Record<string, any>> = [];
  let clock = 0;
  let revision = 6n;
  let applied = 12n;
  // Models the Node row lock: $transaction bodies run exclusively, so the
  // interleaved-request test can prove the service keeps its whole decision
  // inside the serialized section.
  let txLock: Promise<void> = Promise.resolve();
  const store: {
    rows: Array<Record<string, any>>;
    prisma: Record<string, any>;
    /** One-shot pause for the next job INSERT, to interleave two requests. */
    gate: Promise<void> | null;
    gateHit: boolean;
    /** Simulates another administrator's deployment completing. */
    applyDeployment: (value: bigint) => void;
  } = { rows, prisma: null as unknown as Record<string, any>, gate: null, gateHit: false, applyDeployment: (value: bigint) => { applied = value; } };
  const prisma: Record<string, any> = {
    nodeAgent: { findFirst: async () => ({ id: "agent-1", agentId: "agent-1", nodeId: "node-1" }) },
    $queryRaw: async () => [],
    $transaction: async (run: (tx: Record<string, any>) => Promise<unknown>) => {
      const previous = txLock;
      let release!: () => void;
      txLock = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await run(prisma);
      } finally {
        release();
      }
    },
    node: { update: async () => ({ agentConfigRevision: ++revision, inboundAppliedRevision: applied }) },
    panelClientBinding: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const bindings: Record<string, Record<string, any>> = {
          "binding-a": { id: "binding-a", nodeId: "node-1", subscriptionId: "sub-1", userId: "user-1", teamId: "team-1" },
          "binding-b": { id: "binding-b", nodeId: "node-1", subscriptionId: "sub-2", userId: "user-2", teamId: null }
        };
        return bindings[where.id] ?? null;
      }
    },
    nodeCommandJob: {
      findUnique: async ({ where }: { where: { dedupeKey: string } }) =>
        rows.find((row) => row.dedupeKey === where.dedupeKey) ?? null,
      findFirst: async ({ where }: { where: Record<string, any> }) =>
        rows.find((row) => row.nodeId === where.nodeId
          && row.commandType === where.commandType
          && row.targetRevision > where.targetRevision.gt) ?? null,
      updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        let count = 0;
        for (const row of rows) {
          if (where.id !== undefined) {
            if (row.id === where.id && row.dedupeKey === where.dedupeKey) { Object.assign(row, data); count += 1; }
            continue;
          }
          // resolveExhaustedCommands' scope filters (binding or node+type).
          const scopeMatches = where.bindingId !== undefined
            ? row.bindingId === where.bindingId
            : row.nodeId === where.nodeId && row.commandType === where.commandType;
          if (scopeMatches && row.status === "cancelled" && row.resolvedAt == null) { Object.assign(row, data); count += 1; }
        }
        return { count };
      },
      upsert: async ({ where, create }: { where: { dedupeKey: string }; create: Record<string, any> }) => {
        const existing = rows.find((row) => row.dedupeKey === where.dedupeKey);
        if (existing) return existing;
        if (store.gate) {
          const gate = store.gate;
          store.gate = null;
          store.gateHit = true;
          await gate;
        }
        const row = { ...create, status: "pending", attempts: 0, createdAt: new Date(Date.UTC(2026, 0, 1) + ++clock * 60_000) };
        rows.push(row);
        return row;
      },
      create: async ({ data }: { data: Record<string, any> }) => {
        if (store.gate) {
          const gate = store.gate;
          store.gate = null;
          store.gateHit = true;
          await gate;
        }
        const row = { ...data, status: "pending", attempts: 0, createdAt: new Date(Date.UTC(2026, 0, 1) + ++clock * 60_000) };
        rows.push(row);
        return row;
      },
      findUniqueOrThrow: async ({ where }: { where: { dedupeKey: string } }) => {
        const row = rows.find((item) => item.dedupeKey === where.dedupeKey);
        if (!row) throw new Error("模拟唯一键冲突后未找到已提交的命令");
        return row;
      },
    },
  };
  store.prisma = prisma;
  return store;
}

async function testDedupeScope() {
  // Model the unique index: the same dedupeKey collapses onto one row. That is
  // what makes two concurrent identical requests one operation — a read-then-
  // insert could let both observe "nothing outstanding" and schedule two
  // disruptive restarts.
  const store = commandJobStore();
  const service = new AgentService(store.prisma as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);

  const first = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  const second = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  assert.equal(store.rows.length, 1, "未完成的同规格请求必须折叠成一条");
  assert.equal(first.commandId, second.commandId);
  // The payload is normalized before it is persisted: the report is compared
  // against exactly this row.
  assert.deepEqual(store.rows[0].payload, { ...INBOUND_DEFAULTS, serverNames: [...INBOUND_DEFAULTS.serverNames], rotateKeys: false });

  // Completion releases the key (see the rename in completeCommand), so the
  // same deployment can be ordered again — otherwise a node could never return
  // to a port it used before, and a second rotation would be impossible.
  const [key, row] = [store.rows[0].dedupeKey as string, store.rows[0]];
  Object.assign(row, { dedupeKey: `${key}:done:${row.id}` });
  await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  assert.equal(store.rows.length, 2, "已完成的部署必须可以再次下发");

  // A different spec is a different operation.
  await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: { listenPort: 8443 } } as never);
  assert.equal(store.rows.length, 3);
}

async function testGetCommandOutcome() {
  // The admin deploy poll asks for the COMMAND's own terminal state: a higher
  // node-level applied revision can belong to a later deployment while this
  // command failed.
  const found = new AgentService({
    nodeCommandJob: { findFirst: async () => ({ status: "failed", lastError: "入站部署后未能确认生效" }) }
  } as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
  assert.deepEqual(
    await found.getCommandOutcome("node-1", "command-1"),
    { status: "failed", lastError: "入站部署后未能确认生效" }
  );
  // A missing row (history cleanup) is honestly null, not a guess.
  const missing = new AgentService({
    nodeCommandJob: { findFirst: async () => null }
  } as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
  assert.equal(await missing.getCommandOutcome("node-1", "gone"), null);
}

async function testUserCommandResolutionIsBindingScoped() {
  // Ordering ENSURE_USER for ONE user must resolve only THAT binding's
  // exhausted failure: a node-scoped resolution would clear every other
  // user's failed provisioning on the node without repairing anything.
  const store = commandJobStore();
  store.rows.push(
    { id: "exhausted-a", dedupeKey: "old:a", nodeId: "node-1", commandType: "ENSURE_USER", status: "cancelled", resolvedAt: null, bindingId: "binding-a", subscriptionId: "sub-1", userId: "user-1", teamId: "team-1", targetRevision: 1n, createdAt: new Date(0) },
    { id: "exhausted-b", dedupeKey: "old:b", nodeId: "node-1", commandType: "ENSURE_USER", status: "cancelled", resolvedAt: null, bindingId: "binding-b", subscriptionId: "sub-2", userId: "user-2", teamId: null, targetRevision: 2n, createdAt: new Date(1) }
  );
  const service = new AgentService(store.prisma as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);

  await service.queueCommand("node-1", { type: "ENSURE_USER", payload: { bindingId: "binding-a", email: "a@example.invalid", uuid: "u1" } } as never);

  const exhaustedA = store.rows.find((row) => row.id === "exhausted-a");
  const exhaustedB = store.rows.find((row) => row.id === "exhausted-b");
  assert.ok(exhaustedA?.resolvedAt instanceof Date, "被重新下发的绑定，其耗尽失败应被解决");
  assert.equal(exhaustedB?.resolvedAt ?? null, null, "其他用户绑定的耗尽失败不得被顺带解决");

  const ordered = store.rows.find((row) => row.id !== "exhausted-a" && row.id !== "exhausted-b");
  assert.deepEqual(
    ordered && { bindingId: ordered.bindingId, subscriptionId: ordered.subscriptionId, userId: ordered.userId, teamId: ordered.teamId },
    { bindingId: "binding-a", subscriptionId: "sub-1", userId: "user-1", teamId: "team-1" },
    "用户命令必须带归属列（管理端按订阅/用户聚合依赖它们）"
  );

  // A binding that belongs to another node is refused, not silently executed.
  await assert.rejects(
    () => service.queueCommand("node-1", { type: "ENSURE_USER", payload: { bindingId: "binding-x", email: "x@example.invalid", uuid: "u2" } } as never),
    /不属于该节点/,
    "他节点的绑定不得被命令操作"
  );
}

async function testInboundCasGuard() {
  // An idle open form never learns that another administrator's deployment
  // completed (no admin event, no polling) — the CLIENT-side revision gate
  // cannot prevent that race. The enqueue must carry the form's expected
  // applied revision and be rejected atomically when the node moved past it.
  const store = commandJobStore();
  const service = new AgentService(store.prisma as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);

  // Matching expectation: the command is created.
  const fresh = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {}, expectedInboundAppliedRevision: "12" } as never);
  assert.ok(fresh.commandId, "期望 revision 一致时正常入队");

  // Stale expectation (another admin deployed to 13 meanwhile): rejected, and
  // NOTHING is enqueued.
  store.applyDeployment(13n);
  const before = store.rows.length;
  await assert.rejects(
    () => service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: { listenPort: 8443 }, expectedInboundAppliedRevision: "12" } as never),
    /节点部署已更新/,
    "过期期望必须被拒绝"
  );
  assert.equal(store.rows.length, before, "被拒绝的提交不得创建任务");

  // Absent expectation: no guard (backward compatible).
  const unguarded = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  assert.ok(unguarded.commandId, "未携带期望值时不做 CAS 校验");
}

async function testDedupeInterveningDeployment() {
  // 443 → 8443 → 443 again with NOTHING completed (the agent is disconnected):
  // the third request must not collapse onto the first command — it carries an
  // older revision than the 8443 one, so 8443 would remain the newest
  // operation and the agent's stale-revision guard would reject the reused
  // command; the operator's last request would never run.
  const store = commandJobStore();
  const service = new AgentService(store.prisma as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
  const port443 = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  const port8443 = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: { listenPort: 8443 } } as never);
  assert.notEqual(port443.commandId, port8443.commandId);

  const again = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  assert.notEqual(again.commandId, port443.commandId, "存在更新的部署请求时不得折叠回旧命令");
  assert.notEqual(again.commandId, port8443.commandId);
  // The fresh command carries a newly allocated revision NEWER than 8443's:
  // once every queued command has run (or the stale ones were rejected), the
  // node ends on the operator's last request.
  assert.ok(BigInt(again.targetRevision) > BigInt(port8443.targetRevision), "新命令必须拿到新分配的更高 revision");
  // The outstanding 443 job released the base key to the fresh command — a
  // fourth identical request collapses onto the FRESH one, not the old one.
  const fourth = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  assert.equal(fourth.commandId, again.commandId, "没有更新的间隔部署时仍应折叠（双击）");
  // Every job keeps a unique key, and the superseded one is recognisable.
  assert.equal(new Set(store.rows.map((row: Record<string, any>) => row.dedupeKey)).size, store.rows.length);
  assert.match(String(store.rows.find((row: Record<string, any>) => row.id === port443.commandId)?.dedupeKey), /:superseded:/);
}

async function testDedupeInterveningWhileRunning() {
  // Same timeline, but the first 443 command is already RUNNING (the agent
  // picked it up while disconnected from the control plane and has not
  // reported). Releasing only pending jobs would leave the key held, the
  // upsert would collapse onto the old command, and 8443 would stay the
  // newest deployment — the exact bug this PR fixes.
  const store = commandJobStore();
  const service = new AgentService(store.prisma as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
  const port443 = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  Object.assign(store.rows[0], { status: "running" });
  const port8443 = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: { listenPort: 8443 } } as never);

  const again = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  assert.notEqual(again.commandId, port443.commandId, "运行中的旧命令同样必须释放键、不得折叠");
  assert.ok(BigInt(again.targetRevision) > BigInt(port8443.targetRevision), "新命令必须拿到新分配的更高 revision");
  assert.match(String(store.rows.find((row: Record<string, any>) => row.id === port443.commandId)?.dedupeKey), /:superseded:/);

  // A job that completed concurrently released its key the completion way and
  // must not be touched: the rename matches nothing when the row no longer
  // holds the base key.
  const fresh = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: { listenPort: 9443 } } as never);
  const freshRow = store.rows.find((row: Record<string, any>) => row.id === fresh.commandId)!;
  Object.assign(freshRow, { status: "completed", dedupeKey: `${freshRow.dedupeKey}:done:${freshRow.id}` });
  const after = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: { listenPort: 9443 } } as never);
  assert.notEqual(after.commandId, fresh.commandId, "已完成的命令释放键后，同规格必须可以再次下发");
  assert.equal(String(freshRow.dedupeKey).endsWith(":done:" + String(freshRow.id)), true, "完成流程释放的键不得被改写");
}

async function testDedupeInterleavedRequests() {
  // The 8443 request has ALLOCATED its revision but not yet inserted its job
  // when the second 443 request arrives — plain concurrency, no queueing
  // order needed. Without per-node serialization the 443 request sees no
  // intervening job, collapses onto the obsolete revision-1 command, and the
  // node ends on 8443 despite the later 443 request: the unique index only
  // arbitrates same-key writes, and this check is cross-job.
  const store = commandJobStore();
  const service = new AgentService(store.prisma as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
  const port443 = await service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  let releaseInsert!: () => void;
  store.gate = new Promise<void>((resolve) => { releaseInsert = resolve; });

  const eightFourFourThree = service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: { listenPort: 8443 } } as never);
  await new Promise<void>((resolve) => {
    const check = () => (store.gateHit ? resolve() : setTimeout(check, 5));
    check();
  });
  assert.equal(store.gateHit, true, "8443 请求必须已到达插入点（revision 已分配、任务未可见）");

  const again = service.queueCommand("node-1", { type: "ENSURE_INBOUND", payload: {} } as never);
  let completed = false;
  void again.then(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(completed, false, "并发的同规格请求必须在节点串行化点等待，而不是看到一半的状态");

  releaseInsert();
  const [a, b] = [await eightFourFourThree, await again];
  assert.notEqual(b.commandId, port443.commandId, "并发交错时也不得折叠回旧命令");
  assert.ok(BigInt(b.targetRevision) > BigInt(a.targetRevision), "后到的请求必须拿到更高的 revision");
  assert.match(String(store.rows.find((row: Record<string, any>) => row.id === port443.commandId)?.dedupeKey), /:superseded:/);
}

function testInstallerAndDownloadRoute() {
  const script = renderInstallScript({ token: "chordv_register_" + "a".repeat(20), apiBase: "https://example.com" });
  const section = renderXrayInstall();
  assert.ok(script.includes(section), "安装脚本必须内联 Xray 安装段，便于单独回归");

  // Same origin as the agent tarball: a second download host would widen what
  // an install trusts and add a reachability dependency.
  assert.match(section, /\$API_BASE\/agent-download\/xray\/\$ARCH/);
  assert.match(section, /sha256sum -c -/);
  // Xray's config belongs to root; the agent may not write what root runs.
  assert.match(section, /install -d -m 0755 -o root -g root \/etc\/chordv\/xray/);
  // The fragments are seeded from the trusted copy, and only when absent.
  assert.match(section, /source="\$TRUSTED_DIR\/deploy\/\$\{fragment##\*:\}"/);
  assert.match(section, /install -m 0644 -o root -g root "\$source" "\$target"/);
  // The helper is copied OUT of the agent-writable release directory.
  // Root must not load anything through the release tree: the service user
  // extracts it, so a compromised agent could substitute the script root runs.
  assert.equal(/\$CURRENT_LINK/.test(section), false, "root 执行/加载的文件不得取自发布目录");
  assert.match(section, /install -d -m 0700 -o root -g root "\$TRUSTED_DIR"/);
  assert.match(section, /tar[^\n]*-xzf "\$ARCHIVE" -C "\$TRUSTED_DIR"/);
  assert.match(section, /install -m 0755 -o root -g root "\$TRUSTED_DIR\/dist\/src\/xray-apply.js" "\$HELPER_DIR\/xray-apply.js"/);
  assert.match(section, /ExecStart=\$\{NODE_BIN@Q\} \$HELPER_DIR\/xray-apply.js/);
  assert.equal(/ExecStart=.*\$CURRENT_LINK/.test(section), false, "root 助手不得直接从发布目录执行");
  assert.match(section, /install -d -m 0700 -o "\$SERVICE_USER" -g "\$SERVICE_USER" "\$REQUEST_DIR"/);
  // Root publishes results outside anything the agent can write: an
  // agent-owned result directory can be swapped for a symlink into confdir.
  assert.match(section, /install -d -m 0755 -o root -g root "\$RESULT_DIR"/);
  assert.match(script, /CHORDV_XRAY_RESULT_DIR=\/var\/lib\/chordv-xray/);
  // Reinstalls must not silently replace an operator's metering fragment.
  assert.match(section, /cmp -s "\$target" "\$source"/);
  assert.match(section, /PathChanged=\$REQUEST_DIR\/pending.json/);
  // The oneshot helper synchronously restarts Xray; ordering it after
  // xray.service lets systemd hold that restart until this start job finishes.
  const applyUnit = section.slice(section.indexOf("chordv-xray-apply.service <<APPLYUNIT"), section.indexOf("APPLYUNIT\n\ncat"));
  assert.equal(/After=xray.service/.test(applyUnit), false, "助手单元不得排在 xray.service 之后");
  assert.match(section, /ReadOnlyPaths=\/etc\/chordv\/xray/);
  // An operator's own Xray must not be taken over: replacing that unit points it
  // at a config directory with no user-facing inbound and restarts it.
  assert.match(section, /chordv-managed: xray/);
  assert.match(section, /已存在不是由本安装脚本管理的 Xray 服务/);
  // A vendor unit under /usr/lib or /lib is overridden by ours in /etc, so the
  // guard must ask systemd what it resolves rather than only looking in /etc.
  assert.match(section, /systemctl show -p FragmentPath --value xray.service/);
  assert.match(section, /\/usr\/lib\/systemd\/system\/xray.service/);
  assert.match(section, /DropInPaths/);
  assert.match(section, /NoNewPrivileges=true/);
  // The agent unit keeps its hardening and now depends on Xray.
  // Ordering only: Requires= would stop the agent every time the helper
  // restarts Xray, killing the very command that asked for the restart.
  assert.match(script, /Wants=network-online.target xray.service/);
  assert.equal(/^Requires=xray.service$/m.test(script), false);
  assert.match(script, /NoNewPrivileges=true/);
  // The rendered unit may REQUIRE the handoff directory: this installer creates
  // it in the same run. (The checked-in deploy/chordv-node-agent.service serves
  // the agent-only install-systemd.sh and must keep that same path optional —
  // a hard path the installer does not create would stop systemd from setting
  // up the mount namespace at all.)
  assert.match(script, /^ReadWritePaths=\/var\/lib\/chordv-xray\/requests$/m);
  // The installer's own staging cleanup must survive: the Xray section must not
  // install an EXIT trap of its own.
  assert.equal(/trap [^\n]*EXIT/.test(section), false);

  const controller = read("../src/modules/agent/agent-download.controller.ts");
  assert.match(controller, /CHORDV_XRAY_DIST_DIR/);
  assert.match(controller, /agent-download\/xray\/:name/);
  // Unconfigured is an error in its own right; falling back to another source
  // would quietly widen the trust set.
  assert.match(controller, /未配置 Xray 分发/);
  assert.match(controller, /O_NOFOLLOW/);
}

/**
 * whoami's observed address is what a node deploys as its serverHost, and in
 * the supplied 1Panel topology it arrives through TWO appending proxies
 * (openresty → admin nginx → api). This exercises the exact express/proxy-addr
 * resolution main.ts configures, over a real socket: the walk must land on the
 * agent's address past both proxy hops, and a peer outside the trusted set
 * must be taken at socket value with its X-Forwarded-For ignored.
 */
async function testWhoamiAcrossProxyHops() {
  assert.equal(resolveTrustProxy({}), DEFAULT_TRUSTED_PROXIES);
  assert.equal(resolveTrustProxy({ CHORDV_API_TRUSTED_PROXIES: "false" }), undefined);
  assert.equal(resolveTrustProxy({ CHORDV_API_TRUSTED_PROXIES: "10.0.0.0/8" }), "10.0.0.0/8");

  const express = (await import("express")).default;
  const ask = async (trust: string | undefined, headers: Record<string, string>): Promise<string> => {
    const app = express();
    if (trust !== undefined) app.set("trust proxy", trust);
    app.get("/ip", (req, res) => res.send(req.ip ?? ""));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/ip`, { headers });
      return (await response.text()).trim();
    } finally {
      server.close();
    }
  };
  // Two hops, as deployed: the socket peer is the admin container, then the
  // openresty-side address, then the VPS the agent dialed from. Trusting one
  // hop (the old setting) would have resolved to 172.18.0.5.
  assert.equal(await ask(DEFAULT_TRUSTED_PROXIES, { "x-forwarded-for": "203.0.113.9, 172.18.0.5" }), "203.0.113.9");
  // A single-hop topology proxying straight to the api.
  assert.equal(await ask(DEFAULT_TRUSTED_PROXIES, { "x-forwarded-for": "203.0.113.9" }), "203.0.113.9");
  // The agent's own forged entry cannot pass the entries the proxies appended.
  assert.equal(
    await ask(DEFAULT_TRUSTED_PROXIES, { "x-forwarded-for": "198.51.100.1, 203.0.113.9, 172.18.0.5" }),
    "203.0.113.9"
  );
  // A peer outside the trusted set is judged by its socket address alone.
  assert.equal(await ask("10.0.0.0/8", { "x-forwarded-for": "203.0.113.9" }), "127.0.0.1");
}

function testAdminNodeRecordInboundFields() {
  // The admin deploy flow displays exactly these fields, and its completion
  // poll keys off inboundAppliedRevision — the serializer must carry them.
  const base = {
    id: "node-1", name: "node", region: "r", provider: "p", tags: [], recommended: false,
    latencyMs: 0, probeLatencyMs: null, protocol: "vless", security: "reality",
    serverHost: "203.0.113.7", serverPort: 443, serverName: "www.microsoft.com",
    shortId: "0123456789abcdef", spiderX: "/",
    statsLastSyncedAt: null,
    probeStatus: "unknown", probeCheckedAt: null, probeError: null,
    createdAt: new Date(0), updatedAt: new Date(0)
  };
  const deployed = toAdminNodeRecord({
    ...base,
    realityPublicKey: "k".repeat(43), flow: "xtls-rprx-vision", fingerprint: "chrome", inboundAppliedRevision: 12n
  });
  assert.equal(deployed.realityPublicKey, "k".repeat(43));
  assert.equal(deployed.flow, "xtls-rprx-vision");
  assert.equal(deployed.fingerprint, "chrome");
  assert.equal(deployed.inboundAppliedRevision, "12");

  // Placeholder node (registered, never deployed) and legacy rows without the
  // columns must not surface undefined to the UI.
  const placeholder = toAdminNodeRecord(base);
  assert.deepEqual(
    { realityPublicKey: placeholder.realityPublicKey, flow: placeholder.flow, fingerprint: placeholder.fingerprint, inboundAppliedRevision: placeholder.inboundAppliedRevision },
    { realityPublicKey: "", flow: "", fingerprint: "", inboundAppliedRevision: "0" }
  );
  const legacy = toAdminNodeRecord({ ...base, inboundAppliedRevision: null });
  assert.equal(legacy.inboundAppliedRevision, "0");
}

async function testGetInboundSpec() {
  // The reissue form preserves fields it does not edit from the COMPLETE
  // deployed spec — the last APPLIED job's payload. The node record is a
  // lossy projection (one serverName, no dest, no inboundTag).
  const spec = { ...INBOUND_DEFAULTS, serverNames: [...INBOUND_DEFAULTS.serverNames], rotateKeys: false, listenPort: 8443, dest: "proxy.example.org:8443" };
  const run = async (node: { inboundAppliedRevision: bigint } | null, job: unknown) => {
    const service = new AgentService({
      node: { findUnique: async () => node },
      nodeCommandJob: { findFirst: async () => job }
    } as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
    return service.getInboundSpec("node-1");
  };
  assert.deepEqual(await run({ inboundAppliedRevision: 12n }, { payload: spec }), { spec });
  // Nothing applied yet: revision 0 (or no node at all) has no spec.
  assert.deepEqual(await run({ inboundAppliedRevision: 0n }, { payload: spec }), { spec: null });
  assert.deepEqual(await run(null, { payload: spec }), { spec: null });
  // A NONZERO applied revision whose job row is gone (e.g. command history
  // was cleaned up) must fail loudly: answering "no spec" — identical to a
  // never-deployed node — would let the reissue form fall back to the lossy
  // node record and silently drop SNIs / replace the dest / reset the tag.
  await assert.rejects(
    () => run({ inboundAppliedRevision: 12n }, null),
    /部署规格记录缺失/,
    "applied 但规格缺失必须报错而不是当作未部署"
  );
}

function main() {
  testCommandTypeIsDeclaredEverywhere();
  testSpecNormalization();
  testPublicAddressPolicy();
  testReportValidation();
  testInstallerAndDownloadRoute();
  testAdminNodeRecordInboundFields();
  return testGetInboundSpec().then(() => {
  return testWhoamiAcrossProxyHops()
    .then(testWriteBackAndActivation)
    .then(testDedupeScope)
    .then(testUserCommandResolutionIsBindingScoped)
    .then(testDedupeInterveningDeployment)
    .then(testInboundCasGuard)
    .then(testGetCommandOutcome)
    .then(testDedupeInterveningWhileRunning)
    .then(testDedupeInterleavedRequests)
    .then(testDedupeReleaseIsInboundOnly);
  });
}

main().then(() => console.log("agent inbound regression passed (命令声明齐全、规格与上报校验、写回与激活边界、安装脚本与分发路由)"));
