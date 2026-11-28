import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./mygo-local-config.mjs";
import { agentPrivateDatabase, isolatedAgentEnvironment, readAgentLocalConfig } from "../tests/e2e/agent-isolation.mjs";
import { adminEvents, managedProcess, runBuild, transparentAgentProxy, waitForState as eventState } from "../tests/e2e/agent-harness.mjs";
import { sqlID } from "../tests/e2e/local-postgres.mjs";

if (process.argv.length !== 2) throw new Error("Agent隔离验收不接受外部API、schema或二进制参数");
const local = await readAgentLocalConfig();
const db = await agentPrivateDatabase(local);
let base;
const run = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
const ids = {};
const processes = [];
const report = { run, platform: process.platform, architecture: process.arch, checks: [], pids: {}, schema: db.schema, buildCommands: [], cleanupErrors: [] };
const temporary = await mkdtemp(path.join(os.tmpdir(), "chordv-agent-e2e-"));
const output = path.join(PROJECT_ROOT, "output/e2e/agent", run);
const binaries = path.join(temporary, "bin");
await mkdir(output, { recursive: true, mode: 0o700 });
await mkdir(binaries, { mode: 0o700 });
let stream, proxy, fixture, agent, server, releaseUsageRequests;
let publicBefore;
let adminToken, adminRefresh;
const events = new EventEmitter();
const interruption = new AbortController();
const onSignal = (signal) => {
  if (interruption.signal.aborted) return;
  report.interruption = signal;
  interruption.abort(new Error(`隔离验收被${signal}中断`));
  for (const proc of processes) {
    proc.requestStop();
    proc.events.emit("change");
  }
  events.emit("change");
};
const onInterrupt = () => onSignal("SIGINT");
const onTerminate = () => onSignal("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
const assertRunning = () => interruption.signal.throwIfAborted();
const waitForState = (label, check, notifications, timeoutMs) => eventState(label, async () => {
  assertRunning();
  const value = await check();
  assertRunning();
  return value;
}, notifications, timeoutMs);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "TMPDIR", "SystemRoot", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "GOPATH", "GOMODCACHE", "GOCACHE", "GOTOOLCHAIN", "GOPROXY", "GOSUMDB"].includes(key)));

async function api(method, route, body, token = adminToken) {
  assertRunning();
  const response = await fetch(`${base}${route}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([interruption.signal, AbortSignal.timeout(35000)])
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
const note = (check, details = {}) => { report.checks.push({ check, ...details }); process.stdout.write(`通过：${check}\n`); };
const nodeState = () => db.json(`SELECT jsonb_build_object('registrationStatus',"registrationStatus",'isActive',"isActive",'inboundAppliedRevision',"inboundAppliedRevision"::text) FROM "Node" WHERE id=${sqlID(ids.nodeId)};`);
const accounting = () => db.json(`SELECT jsonb_build_object('usedBytes',s."usedTrafficBytes"::text,'snapshotBytes',coalesce((SELECT sum("totalBytes") FROM "TrafficSnapshot" WHERE "subscriptionId"=s.id),0)::text,'snapshotGeneration',(SELECT "counterGeneration" FROM "TrafficSnapshot" WHERE "subscriptionId"=s.id LIMIT 1),'bindingUplinkBytes',coalesce((SELECT sum("lastUplinkBytes") FROM "PanelClientBinding" WHERE "subscriptionId"=s.id),0)::text,'bindingDownlinkBytes',coalesce((SELECT sum("lastDownlinkBytes") FROM "PanelClientBinding" WHERE "subscriptionId"=s.id),0)::text,'accountedBatchCount',(SELECT count(*) FROM "NodeUsageBatch" WHERE "nodeId"=${sqlID(ids.nodeId)} AND "accountedAt" IS NOT NULL)) FROM "Subscription" s WHERE id=${sqlID(ids.subscriptionId)};`);
const commands = () => db.json(`SELECT coalesce(jsonb_agg(jsonb_build_object('commandType',"commandType",'status',status,'result',result,'error',"lastError") ORDER BY "createdAt"),'[]'::jsonb) FROM "NodeCommandJob" WHERE "nodeId"=${sqlID(ids.nodeId)};`);

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
async function sourceSnapshot() {
  const files = {};
  async function visit(dir) {
    for (const item of await readdir(path.join(PROJECT_ROOT, dir), { withFileTypes: true })) {
      const name = path.join(dir, item.name);
      if (item.isDirectory()) await visit(name);
      else if ((!item.name.endsWith("_test.go") && /\.(go|sql|json)$/.test(item.name)) || /go\.(mod|sum)$/.test(item.name)) files[name] = await digest(path.join(PROJECT_ROOT, name));
    }
  }
  for (const dir of ["apps/server", "apps/agent", "packages/release-protocol"]) await visit(dir);
  for (const file of ["apps/server/internal/api/assets/install-go-agent.sh", "scripts/mygo-agent-e2e.mjs", "tests/e2e/agent-isolation.mjs", "tests/e2e/local-postgres.mjs", "tests/e2e/agent-harness.mjs"]) files[file] = await digest(path.join(PROJECT_ROOT, file));
  return files;
}
try {
  publicBefore = await db.publicSnapshot();
  report.sources = await sourceSnapshot();
  assertRunning();
  await db.create();
  assertRunning();
  const builds = [
    ["apps/server", "isolated-server", "./internal/e2e/cmd/isolated-server", true],
    ["apps/agent", "e2e-local-node", "./internal/e2e/cmd/local-node", true],
    ["apps/agent", "e2e-chordv-agent", "./cmd/chordv-agent", false]
  ];
  report.binaries = {};
  for (const [module, name, target, tagged] of builds) {
    assertRunning();
    const args = ["build", ...(tagged ? ["-tags=e2e"] : []), "-o", path.join(binaries, name), target];
    report.buildCommands.push({ cwd: module, command: ["go", ...args] });
    await runBuild("go", args, { cwd: path.join(PROJECT_ROOT, module), env: { ...env, CGO_ENABLED: "0" } });
    report.binaries[name] = await digest(path.join(binaries, name));
    assertRunning();
  }
  assert.deepEqual(await sourceSnapshot(), report.sources, "构建期间源码发生变化，不能声称验证同一快照");
  const adminEmail = `${run}-admin@chordv.local`;
  const adminPassword = randomBytes(24).toString("hex");
  const serverEnv = isolatedAgentEnvironment(local, temporary, db.schema, env);
  server = managedProcess(path.join(binaries, "isolated-server"), [], { cwd: temporary, env: {
    ...serverEnv, CHORDV_AGENT_E2E_SCHEMA_NONCE: db.nonce,
    CHORDV_AGENT_E2E_ADMIN_EMAIL: adminEmail, CHORDV_LOCAL_ADMIN_PASSWORD: adminPassword
  } });
  processes.push(server);
  report.pids.server = server.child.pid;
  const ready = await waitForState("私有schema真实Go后台启动", () => server.ready, server.events, 30000);
  assert.equal(ready.schema, db.schema);
  assert.deepEqual(ready.searchPath, [db.schema, "pg_catalog"]);
  assert.equal(ready.pid, server.child.pid);
  assert.match(ready.base, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.notEqual(new URL(ready.base).port, "3100");
  base = ready.base;
  report.apiBase = base;
  report.searchPath = ready.searchPath;
  assert.equal(await db.sql("SELECT current_schema();"), db.schema);
  note("当前源码构建的独立Go后台、随机回环端口及无public回退的私有schema");
  fixture = managedProcess(path.join(binaries, "e2e-local-node"), [], { env, cwd: temporary });
  processes.push(fixture);
  report.pids.fixture = fixture.child.pid;
  const node = await waitForState("真实 Reality 节点启动", () => fixture.ready, fixture.events, 12000);
  const session = await api("POST", "/api/auth/admin/login", { email: adminEmail, password: adminPassword }, "");
  adminToken = session.accessToken;
  adminRefresh = session.refreshToken;
  stream = await adminEvents(base, adminToken);
  stream.events.on("change", () => events.emit("change"));
  const created = await api("POST", "/api/admin/nodes/agent-native", { name: run, region: "本地", provider: "本地 E2E", panelInbound: {
    mode: "validate_panel", listenPort: node.port, serverHost: "127.0.0.1", realityPublicKey: node.publicKey,
    shortId: node.shortId, serverNames: [node.serverName], flow: "", fingerprint: "chrome", spiderX: "/",
    panelVersion: "3.1.0", inboundTag: node.inboundTag, tagOverrideConfirmed: true
  } });
  ids.nodeId = created.node.id;
  proxy = await transparentAgentProxy(base);
  proxy.events.on("change", () => events.emit("change"));
  agent = managedProcess(path.join(binaries, "e2e-chordv-agent"), [], { cwd: temporary, env: {
    ...env, CHORDV_API_BASE_URL: proxy.url, CHORDV_REGISTER_TOKEN: created.registerToken,
    CHORDV_NODE_PUBLIC_HOST: "127.0.0.1", XRAY_API_ADDRESS: node.grpc, XRAY_INBOUND_TAG: node.inboundTag,
    AGENT_DATABASE_PATH: path.join(temporary, "agent.db"), AGENT_CREDENTIALS_PATH: path.join(temporary, "credentials.json"),
    AGENT_SAMPLE_INTERVAL_MS: "200", AGENT_HEARTBEAT_INTERVAL_MS: "1000"
  } });
  agent.ready.catch(() => {});
  processes.push(agent);
  agent.events.on("change", () => events.emit("change"));
  report.pids.agent = agent.child.pid;
  await waitForState("真实 Agent 注册与 ENSURE_INBOUND 回执", async () => {
    if (agent.child.exitCode !== null) throw new Error("Agent 启动失败，私有诊断已保留");
    const state = await nodeState();
    return state.registrationStatus === "agent_ready" && state.isActive && BigInt(state.inboundAppliedRevision) > 0n && state;
  }, events);
  note("Agent 注册、真实 Reality 入站只读校验及回执");
  const password = randomBytes(24).toString("hex");
  const email = `${run}@chordv.local`;
  const user = await api("POST", "/api/admin/users", { email, displayName: run, password, role: "user" });
  ids.userId = user.id;
  const plan = await api("POST", "/api/admin/plans", { name: run, scope: "personal", totalTrafficGb: 1, renewable: true, maxConcurrentSessions: 2, isActive: true });
  ids.planId = plan.id;
  const sub = await api("POST", "/api/admin/subscriptions", { userId: user.id, planId: plan.id, expireAt: new Date(Date.now() + 3600000).toISOString() });
  ids.subscriptionId = sub.id;
  await api("PUT", `/api/admin/subscriptions/${sub.id}/nodes`, { nodeIds: [ids.nodeId] });
  const client = await api("POST", "/api/auth/login", { email, password }, "");
  const runtime = await api("POST", "/api/client/session/connect", { nodeId: ids.nodeId, mode: "global" }, client.accessToken);
  assert.equal(runtime.outbound.server, "127.0.0.1");
  assert.equal(runtime.outbound.port, node.port);
  assert.equal(runtime.outbound.realityPublicKey, node.publicKey);
  const before = await fixture.rpc("snapshot");
  assert.equal(before.users.length, 1);
  assert.equal(before.users[0].uuid ?? before.users[0].UUID, runtime.outbound.uuid);
  note("ENSURE_USER 由真实 Agent 执行，客户端取得真实连接租约");
  await waitForState("初始供给命令真实完成", async () => (await commands()).every((job) => job.status === "completed"), events);
  const provisioningState = () => db.json(`SELECT jsonb_build_object('nodeRevision',n."agentConfigRevision"::text,'jobs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',j.id,'type',j."commandType",'status',j.status,'revision',j."targetRevision"::text) ORDER BY j.id),'[]'::jsonb) FROM "NodeCommandJob" j WHERE j."nodeId"=n.id),'bindings',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'status',b.status,'uuid',b."panelClientId",'revision',b."directRevision"::text) ORDER BY b.id),'[]'::jsonb) FROM "PanelClientBinding" b WHERE b."nodeId"=n.id)) FROM "Node" n WHERE n.id=${sqlID(ids.nodeId)};`);
  const stableProvisioning = await provisioningState();
  const stableXray = await fixture.rpc("snapshot");
  for (const [index, change] of [
    { displayName: `${run}-edited-active`, status: "active" },
    { displayName: `${run}-edited-omitted` },
    { displayName: `${run}-edited-active-again`, status: "active", role: "user", maxConcurrentSessionsOverride: null }
  ].entries()) {
    const edited = await api("PATCH", `/api/admin/users/${user.id}`, change);
    assert.equal(edited.displayName, change.displayName);
    assert.equal(edited.status, "active");
    assert.deepEqual(await provisioningState(), stableProvisioning, `普通资料保存第${index + 1}次不应新增供给命令或修订`);
    assert.deepEqual((await fixture.rpc("snapshot")).users, stableXray.users, "资料编辑不应改写真实Xray账号");
    const heartbeat = await api("POST", "/api/client/session/heartbeat", { sessionId: runtime.sessionId }, client.accessToken);
    assert.equal(heartbeat.status, "active", "相同状态编辑后原JWT和租约应继续有效");
  }
  note("真实Agent链的相同启用状态/省略状态/完整编辑保存不重复供给且原租约有效", { edits: 3, nodeRevisionUnchanged: true, commandInventoryUnchanged: true, bindingRevisionUnchanged: true, realXrayUserUnchanged: true });
  const payloadBytes = 262144;
  const transfer = await fixture.rpc("transfer", { runtime, bytes: payloadBytes });
  assert.equal(transfer.contentVerified, true);
  const after = await fixture.rpc("snapshot");
  assert.equal(after.counters.length, 1);
  assert.equal(after.counters[0].uplinkBytes, String(payloadBytes));
  assert.equal(after.counters[0].downlinkBytes, String(payloadBytes));
  note("真实 VLESS/Reality 上下行传输及内容核对", transfer);
  const billed = await waitForState("真实 Agent 采样与数据库精确入账", async () => {
    const state = await accounting();
    return state.usedBytes === String(payloadBytes * 2) && state;
  }, events);
  assert.equal(billed.snapshotBytes, billed.usedBytes);
  assert.equal(billed.bindingUplinkBytes, String(payloadBytes));
  assert.equal(billed.bindingDownlinkBytes, String(payloadBytes));
  assert.ok(billed.accountedBatchCount > 0);
  const usage = await waitForState("捕获真实上传批次", () => proxy.batches.find((batch) => batch.payload.samples.some((sample) => BigInt(sample.uplinkBytes) > 0n && BigInt(sample.downlinkBytes) > 0n)), events);
  const sample = usage.payload.samples.find((sample) => BigInt(sample.uplinkBytes) > 0n && BigInt(sample.downlinkBytes) > 0n);
  assert.equal(billed.snapshotGeneration, sample.counterGeneration);
  assert.match(usage.payload.sequence, /^[1-9][0-9]*$/);
  assert.equal(await db.json(`SELECT to_jsonb("accountedAt" IS NOT NULL) FROM "NodeUsageBatch" WHERE "nodeId"=${sqlID(ids.nodeId)} AND "bootId"=${sqlID(usage.payload.bootId)} AND sequence=${usage.payload.sequence};`), true);
  const duplicate = await proxy.replay(usage);
  assert.equal(duplicate.duplicate, true);
  const unchanged = await accounting();
  assert.equal(unchanged.usedBytes, billed.usedBytes);
  assert.equal(unchanged.snapshotBytes, billed.snapshotBytes);
  assert.equal(unchanged.bindingUplinkBytes, billed.bindingUplinkBytes);
  assert.equal(unchanged.bindingDownlinkBytes, billed.bindingDownlinkBytes);
  note("真实计量批次入账与原样重放幂等", { uplinkBytes: String(payloadBytes), downlinkBytes: String(payloadBytes), billedBytes: billed.usedBytes, snapshotBytes: billed.snapshotBytes, audit: "个人订阅：NodeUsageBatch、TrafficSnapshot、PanelClientBinding" });
  // Delay forwarding the exact request bytes, without synthesizing a response.
  // The agent keeps durable pending usage while consuming the disable command.
  releaseUsageRequests = proxy.holdUsageRequests();
  const tailBytes = 65536;
  await fixture.rpc("transfer", { runtime, bytes: tailBytes });
  await waitForState("捕获待转发的真实计量请求", () => proxy.heldUsageRequestCount > 0, events);
  await api("PATCH", `/api/admin/users/${user.id}`, { status: "disabled" });
  await waitForState("停用后 Agent 从真实 Xray 撤销用户", async () => {
    const state = await fixture.rpc("snapshot");
    const jobs = await commands();
    return state.users.length === 0 && jobs.some((job) => job.commandType === "DISABLE_USER" && job.status === "completed");
  }, events);
  const revoked = await db.json(`SELECT jsonb_build_object('status',status,'reason',"revokedReason") FROM "NodeSessionLease" WHERE "sessionId"='${runtime.sessionId.replaceAll("'", "''")}';`);
  assert.equal(revoked.status, "revoked");
  const disable = (await commands()).findLast((job) => job.commandType === "DISABLE_USER" && job.status === "completed");
  const watermarks = disable.result.disableWatermarks;
  assert.ok(Array.isArray(watermarks));
  assert.ok(watermarks.length > 0, "停用前必须存在真实未确认批次");
  const storedWatermarks = await db.json(`SELECT "directDisableWatermarks" FROM "PanelClientBinding" WHERE "nodeId"=${sqlID(ids.nodeId)} AND "subscriptionId"=${sqlID(ids.subscriptionId)};`);
  assert.deepEqual(storedWatermarks, watermarks);
  releaseUsageRequests();
  releaseUsageRequests = undefined;
  for (const mark of watermarks) {
    assert.match(mark.sequenceThrough, /^(0|[1-9][0-9]*)$/);
    await waitForState("停用最终计量水位结算", () => db.json(`SELECT to_jsonb(EXISTS(SELECT 1 FROM "NodeAgent" WHERE "nodeId"=${sqlID(ids.nodeId)} AND "bootId"=${sqlID(mark.bootId)} AND "lastAckSequence">=${mark.sequenceThrough}) AND NOT EXISTS(SELECT 1 FROM "NodeUsageBatch" WHERE "nodeId"=${sqlID(ids.nodeId)} AND "bootId"=${sqlID(mark.bootId)} AND sequence<=${mark.sequenceThrough} AND "accountedAt" IS NULL));`), events);
  }
  const finalAccounting = await waitForState("停用尾流量精确入账", async () => {
    const state = await accounting();
    return state.usedBytes === String((payloadBytes + tailBytes) * 2) && state;
  }, events);
  assert.equal(finalAccounting.snapshotBytes, finalAccounting.usedBytes);
  note("停用最终计量水位已由真实 Agent 结算", { watermarks: watermarks.length, settled: true, tailUplinkBytes: tailBytes, tailDownlinkBytes: tailBytes, finalBilledBytes: finalAccounting.usedBytes });
  // A new real transport must fail after the account is removed, not merely show a changed DB flag.
  await assert.rejects(fixture.rpc("transfer", { runtime, bytes: 1024 }));
  note("账号停用、租约撤销、真实 Xray 用户删除、旧凭据新连接被拒绝", revoked);
  const disabledProvisioning = await provisioningState();
  const securityState = () => db.json(`SELECT jsonb_build_object('authVersion',u."authVersion",'refreshTokens',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'revokedAt',t."revokedAt") ORDER BY t.id),'[]'::jsonb) FROM "RefreshToken" t WHERE t."userId"=u.id)) FROM "User" u WHERE u.id=${sqlID(user.id)};`);
  const disabledSecurity = await securityState();
  await api("PATCH", `/api/admin/users/${user.id}`, { status: "disabled", displayName: `${run}-disabled-metadata` });
  assert.deepEqual(await provisioningState(), disabledProvisioning, "相同停用状态不应再次修改节点供给");
  assert.deepEqual(await securityState(), disabledSecurity, "相同停用状态不应重复撤权或重写已撤销凭据");
  note("真实Agent链的相同停用资料保存不重复撤权或供给", { authVersionUnchanged: true, revokedRefreshTokensUnchanged: true, commandInventoryUnchanged: true });
  await api("PATCH", `/api/admin/users/${user.id}`, { status: "active" });
  await waitForState("真实重新启用供给完成", async () => {
    const state = await fixture.rpc("snapshot");
    return state.users.length === 1 && (await commands()).every((job) => job.status === "completed");
  }, events);
  const resumedSession = await api("POST", "/api/auth/login", { email, password }, "");
  const resumedRuntime = await api("POST", "/api/client/session/connect", { nodeId: ids.nodeId, mode: "global" }, resumedSession.accessToken);
  const enabledProvisioning = await provisioningState();
  assert.equal(enabledProvisioning.jobs.filter((job) => job.type === "ENSURE_USER").length,
    disabledProvisioning.jobs.filter((job) => job.type === "ENSURE_USER").length + 1, "一次真实重新启用只应新增一次供给");
  assert.ok(BigInt(enabledProvisioning.nodeRevision) > BigInt(disabledProvisioning.nodeRevision));
  const resumedBytes = 2048;
  const resumedTransfer = await fixture.rpc("transfer", { runtime: resumedRuntime, bytes: resumedBytes });
  assert.equal(resumedTransfer.contentVerified, true);
  const resumedAccounting = await waitForState("重新启用后的真实流量继续精确结算", async () => {
    const state = await accounting();
    return state.usedBytes === String((payloadBytes + tailBytes + resumedBytes) * 2) && state;
  }, events);
  assert.equal(resumedAccounting.snapshotBytes, resumedAccounting.usedBytes);
  note("真实重新启用保留必要供给并恢复传输计费", { newEnsureCommands: 1, resumedBytesEachDirection: resumedBytes, finalBilledBytes: resumedAccounting.usedBytes });

  const jobs = await commands();
  for (const type of ["ENSURE_INBOUND", "ENSURE_USER", "DISABLE_USER"]) assert.ok(jobs.some((job) => job.commandType === type && job.status === "completed"));
  report.commands = jobs.map(({ commandType, status }) => ({ commandType, status }));
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = interruption.signal.aborted ? interruption.signal.reason.message : error.message;
  if (ids.nodeId) {
    report.commands = await commands().then((jobs) => jobs.map(({ commandType, status, error }) => ({ commandType, status, error }))).catch(() => []);
  }
  process.exitCode = 1;
} finally {
  releaseUsageRequests?.();
  const clean = async (label, operation) => {
    try { return await operation(); }
    catch (error) { report.cleanupErrors.push({ label, error: error.message }); return undefined; }
  };
  if (adminRefresh && !interruption.signal.aborted) await clean("private admin logout", () => api("POST", "/api/auth/logout", { refreshToken: adminRefresh }));
  await clean("SSE", () => stream?.stop());
  for (const proc of processes.reverse()) await clean(`process ${proc.child.pid}`, async () => {
    // The isolated HTTP host allows 10 seconds for accepted requests to drain.
    await proc.stop(proc === server ? 12000 : undefined);
    assert.ok(proc.child.exitCode !== null || proc.child.signalCode !== null, "自有进程未退出");
    if (proc === server) assert.equal(proc.child.exitCode, 0, "独立后台未正常结束请求并退出");
    assert.notEqual(proc.child.signalCode, "SIGKILL", "自有进程未能正常退出，保留强制终止结果");
  });
  report.processTermination = processes.map((proc) => ({ pid: proc.child.pid, exitCode: proc.child.exitCode, signal: proc.child.signalCode }));
  report.processesStopped = processes.every((proc) => proc.child.exitCode !== null || proc.child.signalCode !== null);
  await clean("transparent proxy", () => proxy?.stop());
  report.schemaCleanup = await clean("private schema", () => db.cleanup());
  await clean("public data unchanged", async () => {
    const after = await db.publicSnapshot();
    assert.deepEqual(after, publicBefore, "public表名或全部行摘要改变");
    report.publicData = { tables: after.length, unchanged: true, before: publicBefore, after };
  });
  await clean("source snapshot", async () => {
    assert.deepEqual(await sourceSnapshot(), report.sources, "验收期间源码变化");
    report.sourcesStable = true;
  });
  if (report.result === "passed" && report.cleanupErrors.length === 0) await clean("private temporary binaries", async () => {
    await rm(temporary, { recursive: true });
    report.temporaryRemoved = true;
  });
  report.cleaned = report.cleanupErrors.length === 0 && report.processesStopped && report.schemaCleanup?.remaining === 0;
  if (!report.cleaned) report.result = "failed";
  if (report.result === "failed") {
    const privateLog = path.join(output, "diagnostic.log");
    await writeFile(privateLog, [server?.diagnostic(), fixture?.diagnostic(), agent?.diagnostic()].filter(Boolean).join("\n"), { mode: 0o600 });
    report.privateDiagnostic = privateLog;
    report.retainedTemporary = temporary;
    process.exitCode = 1;
  }
  report.limitations = [`${process.platform}/${process.arch} 本地回环生产API/Agent/Xray链，不替代独立VPS、systemd或3x-ui面板安装验收`, "后台host仅测试tag，复用实际Config/API/Start/迁移，不是生产CLI进程启动验收", "私有schema共享同一本地PostgreSQL数据库；public行摘要一致不证明共享锁、统计或主进程内存无交互", "未读取根.env，未修改系统代理、证书或线上服务"];
  const reportPath = path.join(output, "report.json");
  report.observedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(`E2E ${report.result}，清理${report.cleaned ? "完成" : "失败"}；报告：${reportPath}\n`);
  if (report.error) process.stderr.write(`${report.error}\n`);
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
}
