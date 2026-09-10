import "reflect-metadata";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { Module, Controller, Get, Res, BadRequestException, ForbiddenException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkLifecycle } from "../src/work-lifecycle";
import { AgentDownloadController, sendArtifact } from "../src/modules/agent/agent-download.controller";
import { isNodeOnboardingReady } from "../src/modules/common/node-onboarding-policy";
import { AdminNodeService } from "../src/modules/common/admin-node.service";
import { ClientAccessService } from "../src/modules/common/client-access.service";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { DevDataService } from "../src/modules/common/dev-data.service";

async function nodeGuards() {
  const good = { id: "native", registrationStatus: "agent_ready", isActive: false, protocol: "vless", security: "reality",
    serverHost: "node.example.com", serverPort: 443, uuid: "uuid", realityPublicKey: "public-key", serverName: "example.com", fingerprint: "chrome",
    controlMode: "direct_primary" };
  assert.equal(isNodeOnboardingReady(good), true);
  assert.equal(isNodeOnboardingReady({ registrationStatus: null }), true, "legacy validation remains separate");
  const invalid = [
    { ...good, registrationStatus: null, serverHost: "pending-agent", serverPort: 0 },
    { ...good, registrationStatus: "pending_register" }, { ...good, serverHost: "pending-agent", serverPort: 0 },
    { ...good, serverHost: " PENDING-AGENT " }, { ...good, serverPort: 65536 }, { ...good, serverPort: 1.5 },
    { ...good, realityPublicKey: "" }, { ...good, serverName: "" }
  ];
  for (const node of invalid) {
    assert.equal(isNodeOnboardingReady(node), false);
    const admin = Object.assign(Object.create(AdminNodeService.prototype), {
      prisma: { node: { findUnique: async () => node, update: () => assert.fail("invalid node activation must not write") } }
    }) as AdminNodeService;
    await assert.rejects(admin.updateNode(node.id, { isActive: true }), BadRequestException);
    const runtime = Object.assign(Object.create(RuntimeSessionService.prototype), {
      prisma: { node: { findUnique: async () => ({ ...node, isActive: true }) } }
    }) as RuntimeSessionService;
    await assert.rejects(runtime.connect({ nodeId: node.id } as never), ForbiddenException);
    const data = Object.assign(Object.create(DevDataService.prototype), {
      requireSubscription: async () => ({ id: "sub" }),
      prisma: { subscriptionNodeAccess: { findMany: async () => [] }, node: { findMany: async () => [node] } }
    }) as any;
    await assert.rejects(data.updateSubscriptionNodeAccessLocked("sub", { nodeIds: [node.id] }), /不能分配/);
  }
  const access = Object.assign(Object.create(ClientAccessService.prototype), {
    authSessionService: { authenticateAccessToken: async () => ({ id: "user" }) },
    resolveSubscriptionAccessForUser: async () => ({ subscription: { id: "sub", state: "active", expireAt: new Date(Date.now() + 60000), remainingTrafficGb: 1 } }),
    prisma: { subscriptionNodeAccess: { findMany: async () => invalid.map(node => ({ nodeId: node.id, node: { ...node, isActive: true } })) } }
  }) as ClientAccessService;
  assert.deepEqual(await access.getNodes(), [], "bad persisted activation must not leak endpoints to clients");
}

let artifactUnderTest = "";
class DownloadFixtureController {
  download(response: any) { return sendArtifact(artifactUnderTest, "application/octet-stream", "测试产物", response); }
}
Controller()(DownloadFixtureController);
Get("fixture-artifact")(DownloadFixtureController.prototype, "download", Object.getOwnPropertyDescriptor(DownloadFixtureController.prototype, "download")!);
Res()(DownloadFixtureController.prototype, "download", 0);
class DownloadModule {}
Module({ controllers: [AgentDownloadController, DownloadFixtureController] })(DownloadModule);
async function abortedDownloadDrain() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "chordv-download-drain-"));
  const old = process.env.CHORDV_AGENT_DIST_DIR;
  process.env.CHORDV_AGENT_DIST_DIR = dir;
  const file = path.join(dir, "chordv-agent-linux-x64.tar.gz");
  artifactUnderTest = file;
  const app = await NestFactory.create(DownloadModule, { logger: false });
  const lifecycle = new WorkLifecycle();
  app.use(lifecycle.middleware); app.useGlobalInterceptors(lifecycle); app.setGlobalPrefix("api");
  try {
    await fs.writeFile(file, "complete artifact");
    await app.listen(0, "127.0.0.1");
    const server = app.getHttpServer(), port = server.address().port;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/api/fixture-artifact`)).text(), "complete artifact");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/agent-download/linux-x64`)).status, 410);
    const secret = path.join(dir, "private-secret");
    await fs.writeFile(secret, "PRIVATE_SENTINEL");
    await fs.unlink(file); await fs.symlink(secret, file);
    const linked = await fetch(`http://127.0.0.1:${port}/api/fixture-artifact`);
    assert.equal(linked.status, 404); assert.ok(!(await linked.text()).includes("PRIVATE_SENTINEL"));
    await fs.unlink(file); await fs.mkdir(file);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/fixture-artifact`)).status, 404);
    await fs.rmdir(file);
    const fifo = spawnSync("mkfifo", [file]); assert.equal(fifo.status, 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/fixture-artifact`, { signal: AbortSignal.timeout(1500) })).status, 404);
    await fs.unlink(file); await fs.writeFile(file, "original-opened-artifact");
    const opened = path.join(dir, "opened-artifact");
    const originalOpen = fs.open;
    let swapped = false;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === file) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const result = await stat();
          if (!swapped) { swapped = true; await fs.rename(file, opened); await fs.symlink(secret, file); }
          return result;
        }) as typeof handle.stat;
      }
      return handle;
    }) as typeof fs.open;
    try {
      const raced = await fetch(`http://127.0.0.1:${port}/api/fixture-artifact`);
      assert.equal(await raced.text(), "original-opened-artifact", "filename replacement cannot redirect the opened descriptor");
    } finally { fs.open = originalOpen; }
    assert.equal(swapped, true);
    await fs.unlink(file); await fs.rename(opened, file);
    const handle = await fs.open(file, "w"); await handle.truncate(128 * 1024 * 1024); await handle.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/fixture-artifact`, res => {
          res.once("data", () => { res.destroy(); req.destroy(); });
          res.once("close", () => resolve());
          res.on("error", () => undefined);
        });
        req.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
      });
    }
    await lifecycle.drain(server, 1500);
    lifecycle.assertHealthy();
  } finally {
    app.getHttpServer().closeAllConnections(); await app.close();
    if (old === undefined) delete process.env.CHORDV_AGENT_DIST_DIR; else process.env.CHORDV_AGENT_DIST_DIR = old;
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function main() { await nodeGuards(); await abortedDownloadDrain(); console.log("agent onboarding safety regressions passed (activation/assignment/client guards, HTTP aborts/drain)"); }
void main().catch(error => { console.error(error); process.exitCode = 1; });
