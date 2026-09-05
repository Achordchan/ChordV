import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration test for the supervisor's central failure mode: a promoted release
 * that fails the readiness/health gate must be AUTOMATICALLY ROLLED BACK to the
 * last-good version, and a terminal audit result must be recorded for the app to
 * consume. This drives the real deploy/1panel/chordv/entrypoint.sh with stub
 * releases (a healthy good version and a crash-on-start bad version), so a
 * regression that leaves `current`/`desired-version` on the broken release, or
 * that never records the outcome, is caught in CI — none of which the metadata /
 * signature unit tests exercise.
 */

const APP_ENTRY = "apps/api/dist/apps/api/src/main.js";
const ADMIN_ENTRY = "apps/admin/dist/index.html";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = [path.resolve(here, "../../.."), process.cwd(), path.resolve(process.cwd(), "../..")].find(
  (candidate) => existsSync(path.join(candidate, "deploy/1panel/chordv/entrypoint.sh"))
);
assert.ok(repoRoot, "must locate repo root containing the supervisor entrypoint");
const entrypoint = path.join(repoRoot, "deploy/1panel/chordv/entrypoint.sh");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function writeRelease(root: string, version: string, kind: "good" | "bad", port: number) {
  const dir = path.join(root, "releases", version);
  mkdirSync(path.join(dir, "apps/api/dist/apps/api/src"), { recursive: true });
  mkdirSync(path.join(dir, "apps/admin/dist"), { recursive: true });
  const main =
    kind === "good"
      ? `const http=require('http');const p=process.env.CHORDV_API_PORT||3000;` +
        `http.createServer((_q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{"status":"ready"}');})` +
        `.listen(p,'127.0.0.1');setInterval(()=>{},1<<30);`
      : // Bad release: crash immediately on launch so the health gate fails fast
        // (no need to wait out the health timeout) → supervisor must roll back.
        `process.exit(1);`;
  writeFileSync(path.join(dir, APP_ENTRY), main);
  writeFileSync(path.join(dir, ADMIN_ENTRY), "<!doctype html><title>stub</title>");
  writeFileSync(path.join(dir, "SYSTEM_VERSION"), version);
  return dir;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

type ResultMarker = { operationId?: string; status?: string; version?: string; migrationApplied?: boolean };

async function waitForResult(file: string, timeoutMs: number): Promise<ResultMarker | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as ResultMarker;
      } catch {
        // mid-write; retry
      }
    }
    await sleep(250);
  }
  return null;
}

/**
 * Boot the supervisor with an in-flight promotion of a crash-on-start release
 * (0.0.2) over a last-good release (0.0.1) whose health is parameterized, and
 * return the terminal result the supervisor records for the operation.
 */
async function runRollbackScenario(lastGoodKind: "good" | "bad") {
  const port = await freePort();
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-"));
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  writeRelease(root, "0.0.1", lastGoodKind, port);
  writeRelease(root, "0.0.2", "bad", port);
  writeFileSync(path.join(stateDir, "last-good-version"), "0.0.1");
  writeFileSync(path.join(stateDir, "desired-version"), "0.0.2");
  const opId = `sysop-rollback-${lastGoodKind}`;
  writeFileSync(
    path.join(stateDir, "promoting.json"),
    JSON.stringify({ version: "0.0.2", operationId: opId, kind: "update", migrationApplied: false })
  );

  const env = {
    ...process.env,
    CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"),
    CHORDV_SYSTEM_STATE_DIR: stateDir,
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
    CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port),
    CHORDV_SUPERVISOR_MIGRATE: "false",
    // Keep the bad releases' health gate short so the (fast) crash path dominates and
    // the "last-good also fails" scenario doesn't sit out a long timeout per attempt.
    CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "8",
    CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
  };

  const child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    const result = await waitForResult(path.join(stateDir, `operation-result.${opId}.json`), 60_000);
    const desired = existsSync(path.join(stateDir, "desired-version"))
      ? readFileSync(path.join(stateDir, "desired-version"), "utf8").trim()
      : "";
    let served = false;
    if (lastGoodKind === "good") {
      const serveDeadline = Date.now() + 15_000;
      while (Date.now() < serveDeadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
          if (res.status === 200) {
            served = true;
            break;
          }
        } catch {
          // not up yet
        }
        await sleep(300);
      }
    }
    const currentTarget = existsSync(path.join(root, "current"))
      ? path.basename(readlinkSync(path.join(root, "current")))
      : "";
    const badDiscarded = !existsSync(path.join(root, "releases", "0.0.2"));
    const lastGoodExists = existsSync(path.join(root, "releases", "0.0.1"));
    return { result, desired, served, currentTarget, badDiscarded, lastGoodExists, opId, stderr };
  } finally {
    // Kill the whole supervisor process group (supervisor + any relaunched app that
    // holds the port) so the test frees the port and leaves nothing behind.
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  // Scenario A: last-good is healthy → the promotion of the broken release is
  // auto-rolled-back, and the terminal 'rolledback' result is recorded ONLY after
  // last-good itself is serving (deferred finalization). This is the feature's
  // central failure mode; a regression here would leave the audit or the running
  // symlink on the broken release.
  {
    const s = await runRollbackScenario("good");
    assert.ok(s.result, `supervisor did not record a result within timeout.\nsupervisor stderr:\n${s.stderr}`);
    assert.equal(s.result.operationId, s.opId, "result must be keyed to the failed operation");
    assert.equal(s.result.status, "rolledback", "a health-gate failure must be recorded as a rollback");
    assert.equal(s.result.version, "0.0.1", "rollback must land on the last-good version");
    assert.equal(s.result.migrationApplied, false, "migrationApplied must be carried from the promoting marker");
    assert.equal(s.desired, "0.0.1", "desired-version must be rolled back to last-good");
    assert.equal(s.currentTarget, "0.0.1", "current symlink must point at the last-good release");
    assert.equal(s.badDiscarded, true, "failed update release must be discarded");
    assert.equal(s.lastGoodExists, true, "last-good release must survive");
    assert.ok(s.served, `rolled-back good version must actually be serving.\nsupervisor stderr:\n${s.stderr}`);
  }

  // Scenario B: last-good ALSO fails to come up. The rollback did NOT restore service,
  // so the outcome must be 'failed' — NEVER 'rolledback'. This is the exact defect the
  // deferred-finalization fix addresses: a premature 'rolledback' written before the
  // fallback was health-checked would wrongly claim success.
  {
    const s = await runRollbackScenario("bad");
    assert.ok(s.result, `supervisor did not record a result within timeout.\nsupervisor stderr:\n${s.stderr}`);
    assert.equal(s.result.operationId, s.opId, "result must be keyed to the operation");
    assert.equal(
      s.result.status,
      "failed",
      `a rollback whose fallback also failed must be 'failed', not 'rolledback' (got '${s.result.status}').\nsupervisor stderr:\n${s.stderr}`
    );
  }
}

void main().then(() => {
  console.log("system-update-supervisor.regression.ts passed");
});
