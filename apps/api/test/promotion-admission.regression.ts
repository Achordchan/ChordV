import "reflect-metadata";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { PromotionAdmission, promotionAdmission } from "../src/promotion-admission";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { LEFT_HEALTHY_PATH, SKIPPED_HELD_STEP, waitForSupervisor } from "./supervisor-wait";

async function directAdmission() {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-admission-"));
  const file = path.join(root, "approved-generation");
  const gate = new PromotionAdmission("new-generation", file);
  let mutations = 0;
  const server = createServer((req, res) => gate.middleware(req, res, () => {
    if (!req.url?.startsWith("/api/health")) mutations++;
    res.end("ok");
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const saved = { ...(promotionAdmission as any) };
  try {
    for (const route of ["/api/health", "/api/health/ready"]) assert.equal((await fetch(url + route)).status, 200);
    assert.equal((await fetch(url + "/api/business", { method: "POST", body: "invalid json" })).status, 503);
    writeFileSync(file, "previous-generation");
    assert.equal((await fetch(url + "/api/business")).status, 503);
    rmSync(file); mkdirSync(file);
    assert.equal((await fetch(url + "/api/business")).status, 503, "unreadable approval must not admit");
    rmSync(file, { recursive: true });
    let claims = 0;
    const worker = Object.create(RuntimeSessionService.prototype) as RuntimeSessionService;
    Object.assign(worker, { prisma: { leaseRevocationJob: { findMany: async () => { claims++; return []; } } }, logger: { warn() {} } });
    Object.assign(promotionAdmission, { token: "new-generation", file, approved: false });
    await worker.retryPendingLeaseRevocationJobs(); assert.equal(claims, 0, "cron cannot claim work before approval");
    writeFileSync(file, "new-generation");
    assert.equal((await fetch(url + "/api/business", { method: "POST" })).status, 200);
    assert.equal(mutations, 1);
    await worker.retryPendingLeaseRevocationJobs(); assert.equal(claims, 1);
    assert.equal(new PromotionAdmission("next-generation", file).isApproved(), false, "old token cannot approve a restarted process");
  } finally {
    Object.assign(promotionAdmission, saved);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

async function supervisorApproval() {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-supervisor-admission-"));
  const state = path.join(root, "state"), bin = path.join(root, "bin");
  mkdirSync(state); mkdirSync(bin);
  const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const address = portServer.address(); assert.ok(address && typeof address === "object");
  const port = address.port; await new Promise<void>(resolve => portServer.close(() => resolve()));
  const blocker = path.join(root, "block-approval"), launches = path.join(root, "launches"), mutations = path.join(root, "mutations");
  // One line per SUPERVISOR health probe (only it sends X-Forwarded-Proto): the
  // generation's token and the gate's own admission decision at that probe.
  const probes = path.join(root, "gate-probes");
  const approval = path.join(state, "approved-generation");
  writeFileSync(blocker, "blocked");
  writeFileSync(approval, "old-token");
  const entry = "apps/api/dist/apps/api/src/main.js";
  for (const version of ["0.0.1", "0.0.2"]) {
    const release = path.join(root, "releases", version);
    mkdirSync(path.dirname(path.join(release, entry)), { recursive: true });
    mkdirSync(path.join(release, "apps/admin/dist"), { recursive: true });
    writeFileSync(path.join(release, "apps/admin/dist/index.html"), "test bundle");
    writeFileSync(path.join(release, entry), `require(${JSON.stringify(require.resolve("tsx/cjs"))});
const {PromotionAdmission}=require(${JSON.stringify(path.resolve(__dirname, "../src/promotion-admission.ts"))});
const gate=new PromotionAdmission(),http=require('http'),fs=require('fs');
const token=process.env.CHORDV_SYSTEM_APPROVAL_TOKEN;
http.createServer((req,res)=>gate.middleware(req,res,()=>{
 if(req.url==='/api/health/ready'){
  if(req.headers['x-forwarded-proto'])fs.appendFileSync(${JSON.stringify(probes)},token+' '+gate.isApproved()+'\\n');
  res.end(JSON.stringify({token}));return;
 }
 if(req.url==='/exit'){res.end('exit');setTimeout(()=>process.exit(0),20);return;}
 fs.appendFileSync(${JSON.stringify(mutations)},'mutation\\n');res.end('ok');
})).listen(Number(process.env.CHORDV_API_PORT),'127.0.0.1',()=>fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify({token})+'\\n'));
`);
  }
  writeFileSync(path.join(bin, "mv"), `#!/usr/bin/env bash
if [[ "\${!#}" == "$CHORDV_TEST_APPROVAL" && -f "$CHORDV_TEST_BLOCKER" ]]; then exit 1; fi
exec /bin/mv "$@"
`, { mode: 0o755 });
  writeFileSync(path.join(state, "promoting.json"), JSON.stringify({ version: "0.0.2", operationId: "sysop-admission", kind: "update", migrationApplied: false }));
  writeFileSync(path.join(state, "last-good-version"), "0.0.1");
  const child = spawn("bash", [path.resolve(__dirname, "../../../deploy/backend/entrypoint.sh")], {
    detached: true, stdio: ["ignore", "ignore", "pipe"], env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CHORDV_TEST_APPROVAL: approval, CHORDV_TEST_BLOCKER: blocker,
      TSX_TSCONFIG_PATH: path.resolve(__dirname, "../tsconfig.json"),
      CHORDV_SYSTEM_NODE_BIN: process.execPath, CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"),
      CHORDV_SYSTEM_STATE_DIR: state, CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public"),
      CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"), CHORDV_API_PORT: String(port),
      CHORDV_SUPERVISOR_MIGRATE: "false", CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "2"
    }
  });
  let logs = ""; child.stderr.on("data", chunk => { logs += chunk; });
  const url = `http://127.0.0.1:${port}`;
  const until = (what: string, done: () => boolean, failOn = SKIPPED_HELD_STEP) => waitForSupervisor(child, what, done, () => logs, failOn);
  const launchCount = () => existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n").length : 0;
  const gateProbes = (token: string) => readFileSync(probes, "utf8").trim().split("\n")
    .filter(line => line.startsWith(token + " ")).map(line => line.slice(token.length + 1));
  try {
    await until("first generation held at approval", () => logs.includes("cannot approve current process"));
    const first = await (await fetch(url + "/api/health/ready")).json() as { token: string };
    assert.ok(first.token && first.token !== "old-token");
    assert.equal((await fetch(url + "/api/business", { method: "POST" })).status, 503);
    assert.equal(existsSync(mutations), false);
    rmSync(blocker);
    await until("first generation approval", () => readFileSync(approval, "utf8") === first.token);
    assert.equal((await fetch(url + "/api/business", { method: "POST" })).status, 200);
    // The relaunch is NOT held, so an approval issued before its gate completes would
    // be visible. Rather than racing a request against stabilization, the stub records
    // its admission decision at every supervisor probe: the first generation's approval
    // (still on disk throughout the relaunch's gate) must admit none of them. That
    // generation's own "healthy + stable" line may still be in flight, so only real
    // detours fail fast here.
    await fetch(url + "/exit");
    await until("relaunch", () => launchCount() === 2, LEFT_HEALTHY_PATH);
    const second = await (await fetch(url + "/api/health/ready")).json() as { token: string };
    assert.notEqual(second.token, first.token);
    await until("relaunched generation approval", () => readFileSync(approval, "utf8") === second.token, LEFT_HEALTHY_PATH);
    for (const token of [first.token, second.token]) {
      // The readiness probe plus one per stabilization second, all before approval.
      assert.ok(gateProbes(token).length >= 1 + 2, `gate probes for ${token}: ${gateProbes(token)}`);
      assert.deepEqual([...new Set(gateProbes(token))], ["false"], "no generation may be admitted before its gate completes");
    }
    assert.equal((await fetch(url + "/api/business", { method: "POST" })).status, 200);
    assert.equal(readFileSync(mutations, "utf8"), "mutation\nmutation\n");
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already stopped */ }
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  const source = readFileSync(path.resolve(__dirname, "../src/main.ts"), "utf8");
  assert.ok(source.indexOf("app.use(promotionAdmission.middleware)") < source.indexOf("app.use(workLifecycle.middleware)"));
  await directAdmission(); await supervisorApproval();
  console.log("promotion-admission.regression.ts passed (HTTP/cron gate, storage failure, approval, fresh restart token)");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
