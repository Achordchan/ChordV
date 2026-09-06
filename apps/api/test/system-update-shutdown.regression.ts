import "reflect-metadata";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Controller, Get, Module, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FileInterceptor } from "@nestjs/platform-express";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { DrainCancelledError, WorkBudgetExceededError, WorkLifecycle, workLifecycle, withShutdownDeadline } from "../src/work-lifecycle";
import { SystemUpdateService } from "../src/modules/common/system-update.service";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { ClientTicketService } from "../src/modules/common/client-ticket.service";
import { ClientRuntimeEventsService } from "../src/modules/common/client-runtime-events.service";
import { AdminRuntimeEventsService } from "../src/modules/common/admin-runtime-events.service";
import { AgentEventsService } from "../src/modules/agent/agent-events.service";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const requestStarted = deferred();
const requestDone = deferred();
let uploadBytes = 0;
const disconnectedStarted = deferred();
const disconnectedDone = deferred();
class TestController {
  async disconnected() { disconnectedStarted.resolve(); await disconnectedDone.promise; return "done"; }
  async slow() { requestStarted.resolve(); await requestDone.promise; return "finished"; }
  upload(file: { buffer: Buffer }) { uploadBytes = file.buffer.length; return "uploaded"; }
}
Controller()(TestController);
Get("disconnected")(TestController.prototype, "disconnected", Object.getOwnPropertyDescriptor(TestController.prototype, "disconnected")!);
Get("slow")(TestController.prototype, "slow", Object.getOwnPropertyDescriptor(TestController.prototype, "slow")!);
Post("upload")(TestController.prototype, "upload", Object.getOwnPropertyDescriptor(TestController.prototype, "upload")!);
UseInterceptors(FileInterceptor("file"))(TestController.prototype, "upload", Object.getOwnPropertyDescriptor(TestController.prototype, "upload")!);
UploadedFile()(TestController.prototype, "upload", 0);
class TestModule {}
Module({ controllers: [TestController] })(TestModule);

function call(port: number, method: string, route: string, headers = {}) {
  let status = 0;
  let request!: http.ClientRequest;
  const result = new Promise<string>((resolve, reject) => {
    const req = http.request({ port, host: "127.0.0.1", method, path: route, headers }, (res) => {
      status = res.statusCode ?? 0;
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    request = req;
  });
  return { request, result, status: () => status };
}

function serviceAt(dir: string) {
  const service = new SystemUpdateService({} as never, {} as never);
  (service as any).config.stateDir = dir;
  return service;
}
const marker = { version: "2.0.0", operationId: "sysop-drain", kind: "update", migrationApplied: true };

async function assertRealHttpDrain() {
  const lifecycle = new WorkLifecycle();
  const app = await NestFactory.create(TestModule, { logger: false });
  app.use(lifecycle.middleware);
  app.useGlobalInterceptors(lifecycle);
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer();
  const port = server.address().port;
  const slow = call(port, "GET", "/slow"); slow.request.end();
  await requestStarted.promise;
  const disconnected = call(port, "GET", "/disconnected"); disconnected.request.end();
  void disconnected.result.catch(() => undefined);
  await disconnectedStarted.promise; disconnected.request.destroy();
  const upload = call(port, "POST", "/upload", { "content-type": "multipart/form-data; boundary=test" });
  upload.request.write('--test\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nabc');
  await sleep(50);
  const job = deferred(); lifecycle.track(job.promise);
  const deferredJob = deferred(); lifecycle.defer(() => deferredJob.promise, 10);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chordv-drain-"));
  const service = serviceAt(dir);
  let closed = false, released = false, exited = false;
  service.configureShutdown(async () => {
    await lifecycle.drain(server, 4000);
    assert.equal(released, false);
    await app.close(); closed = true;
  }, (error) => { console.error(error); }, () => lifecycle.assertHealthy());
  const exit = process.exit;
  process.exit = ((code: number) => { assert.equal(code, 0); assert.ok(closed); assert.equal(released, false); exited = true; }) as never;
  try {
    const task = (service as any).drainAndExit({ assertHeld: async () => assert.equal(released, false), release: async () => { released = true; } }, marker.operationId, marker);
    await sleep(750);
    assert.equal(exited, false, "600ms is not a drain");
    await assert.rejects(fs.access(path.join(dir, "pending.json")));
    // Admission middleware rejects a pipelined/keepalive request even when the TCP
    // connection predates server.close(). New TCP connections are refused by Node.
    let admitted = false;
    const response = { writeHead: (code: number) => assert.equal(code, 503), end: () => undefined };
    lifecycle.middleware({} as never, response as never, () => { admitted = true; });
    assert.equal(admitted, false);
    upload.request.end('\r\n--test--\r\n'); requestDone.resolve();
    assert.equal(await upload.result, "uploaded"); assert.equal(uploadBytes, 3);
    assert.equal(await slow.result, "finished");
    await sleep(30); assert.equal(exited, false, "scheduled work survives response completion");
    job.resolve(); await sleep(30); assert.equal(exited, false, "queued followup is also awaited");
    deferredJob.resolve(); await sleep(30);
    assert.equal(exited, false, "disconnected async controller must still settle");
    disconnectedDone.resolve(); await task;
    assert.ok(exited); assert.equal(released, false, "dedicated lock held through actual exit boundary");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "pending.json"), "utf8")), marker);
  } finally { process.exit = exit; server.closeAllConnections(); await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
}

async function assertDedicatedLockLifecycle() {
  class PgStub extends EventEmitter {
    ended = false;
    unlocked = false;
    async connect() {}
    async query(sql: string) { if (sql.includes("pg_advisory_unlock")) this.unlocked = true; return { rows: [{ locked: true }] }; }
    async end() { this.ended = true; this.emit("end"); }
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chordv-drain-lock-"));
  const service = serviceAt(dir);
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://unused/test";
  const pg = new PgStub();
  const lock = await (service as any).acquireLock(() => pg);
  const exit = process.exit;
  process.exit = (() => { assert.equal(pg.ended, false); assert.equal(pg.unlocked, false); }) as never;
  try {
    service.configureShutdown(async () => {
      service.onModuleDestroy();
      assert.equal(pg.ended, false, "Nest destroy hook cannot release dedicated lock");
      await assert.rejects((service as any).acquireLock(() => new PgStub()), /取消中/);
    }, () => undefined, () => undefined);
    await (service as any).drainAndExit(lock, marker.operationId, marker);
    assert.equal(pg.ended, false); assert.equal(pg.unlocked, false);
  } finally {
    process.exit = exit; await lock.release();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function assertFailures() {
  const exit = process.exit;
  try {
    for (const scenario of ["drain", "cancel", "hooks", "lock", "final-lock", "write", "audit", "revoke"]) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chordv-drain-fail-"));
      const service = serviceAt(dir);
      let released = false, fenced = false, checks = 0, exited = 0;
      // Once the failure is durably audited and the pending intent revoked (or
      // was never written), the process exits non-zero so the supervisor can
      // relaunch the SAME version through its readiness gate — staying alive
      // but deaf required a manual restart for every drain timeout. Only the
      // revoke-failure scenario keeps its fence instead of exiting.
      process.exit = ((code: number) => {
        exited += 1;
        assert.equal(code, 1, "failed shutdown must exit non-zero for supervisor restart");
      }) as never;
      service.configureShutdown(async () => {
        await assert.rejects(fs.access(path.join(dir, "pending.json")));
        if (scenario === "drain") throw new Error("active task timed out");
        if (scenario === "cancel") throw new DrainCancelledError();
        if (scenario === "hooks") await withShutdownDeadline(Promise.reject(new Error("destroy hook failed")), 50);
      }, () => { fenced = true; }, () => undefined);
      if (scenario === "write") (service as any).writePendingMarker = async () => { throw new Error("disk full"); };
      // Deterministic audit-write failure: chmod cannot block a root test runner.
      if (scenario === "audit") (service as any).writeFileDurable = async () => { throw new Error("state volume read-only"); };
      if (scenario === "revoke") {
        (service as any).writePendingMarker = async () => { throw new Error("rename failed"); };
        (service as any).clearPendingMarker = async () => { throw new Error("read-only state"); };
      }
      await (service as any).drainAndExit({ assertHeld: async () => {
        checks += 1;
        if ((scenario === "lock" && checks === 2) || (scenario === "final-lock" && checks === 3)) throw new Error("lock lost");
      }, release: async () => { released = true; } }, marker.operationId, marker);
      assert.ok(fenced);
      assert.equal(released, scenario !== "revoke", "never release fence if pending revocation fails");
      await assert.rejects(fs.access(path.join(dir, "pending.json")));
      if (scenario === "revoke" || scenario === "cancel" || scenario === "audit") {
        assert.equal(exited, 0, "revoked-intent, signal-cancelled and un-auditable failures must stay fenced for manual recovery");
      } else {
        assert.equal(exited, 1, "audited failure must exit for supervisor restart");
      }
      if (scenario !== "revoke" && scenario !== "cancel" && scenario !== "audit") {
        const result = JSON.parse(await fs.readFile(path.join(dir, `operation-result.${marker.operationId}.json`), "utf8"));
        assert.equal(result.status, "failed"); assert.equal(result.migrationApplied, false);
        assert.equal(result.version, undefined, "preserve original audit target");
        const bytes = JSON.stringify(result);
        exited = 0;
        await (service as any).drainAndExit({ assertHeld: async () => { throw new Error("later failure"); }, release: async () => undefined }, marker.operationId, marker);
        assert.equal(await fs.readFile(path.join(dir, `operation-result.${marker.operationId}.json`), "utf8"), bytes, "do not overwrite terminal result");
        assert.equal(exited, 1, "repeat failure must still exit after re-auditing");
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
    await assert.rejects(withShutdownDeadline(new Promise(() => undefined), 25), /timed out/);
  } finally { process.exit = exit; }
}

async function assertBudgetedWorkReleasesOnTimeout() {
  // A budgeted task that never settles must release its work item when the
  // budget expires — this is the primitive that keeps a hung remote call from
  // blocking a self-update drain for the whole drain window ("N work items
  // remain" in production).
  const lifecycle = new WorkLifecycle();
  const server = http.createServer(); await new Promise<void>((resolve) => server.listen(0, resolve));
  const hung = new Promise<string>(() => undefined);
  class BudgetExceeded extends Error {}
  await assert.rejects(lifecycle.awaitWithBudget(hung, 25, () => new BudgetExceeded("budget")), BudgetExceeded);
  await lifecycle.drain(server, 2_000);
  clearInterval((lifecycle as unknown as { recoveryHold?: NodeJS.Timeout }).recoveryHold);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // A task that settles in time resolves normally and still releases.
  const prompt = new WorkLifecycle();
  const server2 = http.createServer(); await new Promise<void>((resolve) => server2.listen(0, resolve));
  assert.equal(await prompt.awaitWithBudget(Promise.resolve("ok"), 1_000), "ok");
  await prompt.drain(server2, 2_000);
  clearInterval((prompt as unknown as { recoveryHold?: NodeJS.Timeout }).recoveryHold);
  await new Promise<void>((resolve) => server2.close(() => resolve()));
}

async function assertTimeoutAndDisconnectedWork() {
  const lifecycle = new WorkLifecycle();
  const server = http.createServer(); await new Promise<void>((resolve) => server.listen(0, resolve));
  const unfinished = deferred(); lifecycle.track(unfinished.promise);
  await assert.rejects(lifecycle.drain(server, 30), /Drain timed out/);
  assert.equal(lifecycle.isDraining, true); unfinished.resolve();
  const cancelled = new WorkLifecycle();
  const server3 = http.createServer(); await new Promise<void>((resolve) => server3.listen(0, resolve));
  const cancelledWork = deferred(); cancelled.track(cancelledWork.promise);
  const cancelling = cancelled.drain(server3, 1000);
  cancelled.cancelDrain();
  await assert.rejects(cancelling, /interrupted/);
  assert.equal(cancelled.isDraining, true);
  cancelledWork.resolve(); clearInterval((cancelled as any).recoveryHold);
  const second = new WorkLifecycle();
  const left = deferred();
  // A rejecting Promise.all sibling must not hide the remaining write.
  await assert.rejects(second.all([Promise.reject(new Error("first failed")), left.promise]));
  const server2 = http.createServer(); await new Promise<void>((resolve) => server2.listen(0, resolve));
  let drained = false; const drain = second.drain(server2, 2000).then(() => { drained = true; });
  await sleep(650); assert.equal(drained, false); left.resolve(); await drain;
}

async function assertDrainBeforeListen() {
  const lifecycle = new WorkLifecycle();
  const server = http.createServer();
  const work = deferred(); lifecycle.track(work.promise);
  let closed = false;
  const drain = lifecycle.drain(server, 1000).then(() => { closed = true; });
  await sleep(50);
  assert.equal(closed, false, "unopened HTTP server does not mean registered startup work is done");
  work.resolve(); await drain;
  lifecycle.assertHealthy();
  assert.equal((lifecycle as any).recoveryHold, undefined);
  const failed = new WorkLifecycle();
  const broken = http.createServer();
  broken.close = ((callback: (error?: Error) => void) => {
    callback(Object.assign(new Error("real close failure"), { code: "EIO" })); return broken;
  }) as typeof broken.close;
  await assert.rejects(failed.drain(broken, 1000), /real close failure/);
}

async function assertActualScheduledAndStreams() {
  // Use the actual decorated cron worker, not a synthetic app.close mock.
  const batch = deferred(); let claims = 0;
  const worker = Object.create(RuntimeSessionService.prototype) as RuntimeSessionService;
  Object.assign(worker, { prisma: { panelSyncJob: { findMany: async () => { claims++; await batch.promise; return []; } } }, logger: { warn() {} } });
  const running = worker.retryPendingPanelSyncJobs(); await sleep(10); assert.equal(claims, 1);
  const client = new ClientRuntimeEventsService({} as never);
  const admin = new AdminRuntimeEventsService({} as never);
  const validation = deferred();
  const clientSub = client.streamForUser("u", { validate: () => validation.promise }).subscribe();
  const adminSub = admin.stream().subscribe();
  // A connected node agent holds its command stream open indefinitely: unless the
  // drain completes it too, its request work items are never released and the HTTP
  // server never finishes closing (every panel update stalled on exactly this).
  let agentClaims = 0;
  const agentEvents = Object.create(AgentEventsService.prototype) as AgentEventsService;
  Object.assign(agentEvents, {
    prisma: { nodeCommandJob: { findMany: async () => { agentClaims++; return []; } } },
    subscribers: new Map(), logger: { error() {}, warn() {} }, retrying: false
  });
  const agentSub = agentEvents.stream("agent-1", async () => undefined).subscribe();
  const janitor = Object.create(ClientTicketService.prototype) as any;
  const cleanup = deferred(); let cleanups = 0;
  janitor.pruneExpiredPendingAttachmentsAndCleanup = async () => { cleanups++; await cleanup.promise; };
  janitor.startPendingAttachmentJanitor();
  const server = http.createServer(); await new Promise<void>((resolve) => server.listen(0, resolve));
  let drained = false;
  await sleep(10);
  const drain = workLifecycle.drain(server, 4000).then(() => { drained = true; });
  await worker.retryPendingPanelSyncJobs(); assert.equal(claims, 1, "no cron DB claims during drain");
  const agentClaimsBeforeDrain = agentClaims;
  await agentEvents.retryDueCommands();
  assert.equal(agentClaims, agentClaimsBeforeDrain, "no agent command claims during drain");
  assert.ok(clientSub.closed && adminSub.closed, "SSE subscriptions explicitly completed");
  assert.ok(agentSub.closed, "agent command stream explicitly completed");
  assert.equal((agentEvents as unknown as { subscribers: Map<string, Set<unknown>> }).subscribers.size, 0,
    "agent stream teardown ran (sink unregistered)");
  await sleep(750); assert.equal(drained, false);
  batch.resolve(); await running; await sleep(20); assert.equal(drained, false);
  cleanup.resolve(); validation.resolve(); await drain; assert.equal(cleanups, 1);
}

async function assertBudgetWindowsAndNoRaceTrack() {
  // A budget must account for the WAITING window only. `Promise.race([track(task),
  // timeoutTask])` looks equivalent but keeps the work item until the underlying
  // promise settles, so one hung remote call blocks a whole self-update drain.
  const lifecycle = new WorkLifecycle();
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const never = new Promise<string>(() => undefined);
  const expired = await lifecycle.awaitWithBudgetElse(never, 20, () => "fallback");
  assert.equal(expired, "fallback", "expiry resolves with the lazy fallback");

  let built = 0;
  const settledFast = await lifecycle.awaitWithBudgetElse(Promise.resolve("real"), 5_000, () => { built++; return "fallback"; });
  assert.equal(settledFast, "real");
  assert.equal(built, 0, "fallback is never built on the happy path");

  await assert.rejects(
    lifecycle.awaitWithBudgetElse(Promise.reject(new Error("task blew up")), 5_000, () => "fallback"),
    /task blew up/,
    "a task failure propagates instead of being swallowed as an expiry"
  );
  // A nested budget expiring is the TASK failing, not ours: it must propagate, or the
  // caller silently gets fallback data under a timeout value that never elapsed.
  const nested = lifecycle.awaitWithBudget(new Promise<string>(() => undefined), 10);
  await assert.rejects(
    lifecycle.awaitWithBudgetElse(nested, 5_000, () => "fallback"),
    (error: unknown) => error instanceof WorkBudgetExceededError && error.timeoutMs === 10,
    "a nested budget expiry propagates instead of being taken for our own"
  );

  await assert.rejects(lifecycle.awaitWithBudget(never, 20), (error: unknown) => {
    assert.ok(error instanceof WorkBudgetExceededError);
    assert.equal((error as WorkBudgetExceededError).timeoutMs, 20);
    return true;
  });

  // The abandoned task is still pending, yet the drain must not wait for it.
  await lifecycle.drain(server, 1000);

  // A budget window is only legitimate when the abandoned work has ANOTHER owner (a
  // retry queue that will re-run it, a background logger). Work whose whole purpose is
  // to CREATE the durable record has no such owner: releasing its accounting lets a
  // self-update close Prisma and exit mid-enqueue, leaving the local change without the
  // panel sync it implies. Those helpers therefore stay tracked. They are local DB
  // enqueues, so the drain waits on the database, never on an unreachable panel.
  // Converting them needs "persist a retry record, THEN bound the wait" — until that
  // exists this list must SHRINK, never grow.
  const keptTracked = new Map<string, number>([
    ["src/modules/common/runtime-session.service.ts", 2],   // queuePanelAccessSyncForNodeSubscription, withNodePanelBindingSubscriptionBudget
    ["src/modules/common/admin-node.service.ts", 2],        // runAfterLocalNodeSaveWithBudget, tryRunAfterLocalNodeSave
    ["src/modules/common/admin-subscription.service.ts", 1] // withSubscriptionFollowUpBudget
  ]);
  const found = new Map<string, number>();
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const hits = (await fs.readFile(full, "utf8")).split("Promise.race([workLifecycle.track(").length - 1;
      if (hits > 0) found.set(path.relative(path.join(__dirname, ".."), full), hits);
    }
  };
  await walk(path.join(__dirname, "../src"));
  for (const [file, hits] of found) {
    const allowed = keptTracked.get(file) ?? 0;
    assert.ok(
      hits <= allowed,
      `${file} races ${hits} tracked task(s) but only ${allowed} are documented as durable-intent: ` +
      "use awaitWithBudget/awaitWithBudgetElse, or keep the work tracked without a race"
    );
  }
  for (const [file, allowed] of keptTracked) {
    assert.ok((found.get(file) ?? 0) <= allowed, `stale exception for ${file}`);
  }
}

async function repeatedSignalChild() {
  const source = await fs.readFile(path.join(__dirname, "../src/main.ts"), "utf8");
  const start = source.indexOf('  for (const signal of ["SIGTERM", "SIGINT"] as const) {');
  const end = source.indexOf('  app.setGlobalPrefix', start);
  assert.ok(start >= 0 && end > start, "exercise the production signal registration block");
  const lifecycle = new WorkLifecycle();
  const server = http.createServer();
  const startup = process.env.CHORDV_SIGNAL_TEST_STARTUP === "true";
  if (!startup) await new Promise<void>((resolve) => server.listen(0, resolve));
  lifecycle.track(startup ? sleep(100) : new Promise<void>(() => undefined));
  const shutdown = async () => {
    process.send?.("draining");
    await lifecycle.drain(server, 10_000);
    if (startup) {
      await fs.writeFile(path.join(process.env.CHORDV_SIGNAL_TEST_DIR!, "closed"), "shutdown completed");
      return;
    }
    // If the production handler lets drain complete incorrectly, this is observable.
    await fs.writeFile(path.join(process.env.CHORDV_SIGNAL_TEST_DIR!, "pending.json"), "unsafe");
  };
  const cancel = lifecycle.cancelDrain.bind(lifecycle);
  lifecycle.cancelDrain = () => { cancel(); process.send?.("cancelled"); };
  new Function("workLifecycle", "shutdown", "DrainCancelledError", source.slice(start, end).replace(" as const", ""))(lifecycle, shutdown, DrainCancelledError);
  process.send?.("ready");
}

async function assertRepeatedSignals() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chordv-drain-signals-"));
  const child = spawn(process.execPath, ["--import", "tsx", __filename], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, CHORDV_SIGNAL_TEST_DIR: dir },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  const messages: string[] = [];
  let stderr = "";
  child.on("message", (message) => messages.push(String(message)));
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const awaitMessage = async (message: string, count = 1) => {
    const deadline = Date.now() + 10_000;
    while (messages.filter((value) => value === message).length < count) {
      assert.equal(child.exitCode, null, stderr);
      assert.equal(child.signalCode, null, "same signal must not restore default termination");
      assert.ok(Date.now() < deadline, `Child did not reach ${message}: ${stderr}`);
      await sleep(20);
    }
  };
  try {
    await awaitMessage("ready");
    child.kill("SIGTERM"); await awaitMessage("draining");
    await sleep(50);
    child.kill("SIGTERM"); await awaitMessage("cancelled");
    // Repetition after cancellation must also retain the process fence.
    child.kill("SIGTERM"); await awaitMessage("cancelled", 2);
    await sleep(750);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    await assert.rejects(fs.access(path.join(dir, "pending.json")));
  } finally {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function assertStartupSignal() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chordv-startup-signal-"));
  const child = spawn(process.execPath, ["--import", "tsx", __filename], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, CHORDV_SIGNAL_TEST_DIR: dir, CHORDV_SIGNAL_TEST_STARTUP: "true" },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  child.on("message", message => { if (message === "ready") child.kill("SIGTERM"); });
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`startup shutdown stuck: ${stderr}`)), 10_000);
    })]);
    assert.equal(code, 0, stderr);
    assert.equal(await fs.readFile(path.join(dir, "closed"), "utf8"), "shutdown completed");
    assert.doesNotMatch(stderr, /fenced|ERR_SERVER_NOT_RUNNING/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.CHORDV_SIGNAL_TEST_DIR) { await repeatedSignalChild(); return; }
  await assertRepeatedSignals();
  await assertStartupSignal();
  await assertRealHttpDrain();
  await assertDedicatedLockLifecycle();
  await assertFailures();
  await assertBudgetedWorkReleasesOnTimeout();
  await assertTimeoutAndDisconnectedWork();
  await assertDrainBeforeListen();
  await assertActualScheduledAndStreams();
  await assertBudgetWindowsAndNoRaceTrack();
  console.log("system-update graceful shutdown regressions passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
