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

async function main() {
  const port = await freePort();
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-"));
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  // last-good = 0.0.1 (healthy). A promotion of 0.0.2 (crashes on start) is in
  // flight: promoting.json makes the supervisor resume it as a health-gated
  // promotion that can roll back, exactly as after a mid-promotion restart.
  writeRelease(root, "0.0.1", "good", port);
  writeRelease(root, "0.0.2", "bad", port);
  writeFileSync(path.join(stateDir, "last-good-version"), "0.0.1");
  writeFileSync(path.join(stateDir, "desired-version"), "0.0.2");
  const opId = "sysop-rollback-test";
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
    CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "20",
    CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
  };

  const child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const resultFile = path.join(stateDir, `operation-result.${opId}.json`);
  const deadline = Date.now() + 45_000;
  let resultRaw: string | null = null;
  try {
    while (Date.now() < deadline) {
      if (existsSync(resultFile)) {
        resultRaw = readFileSync(resultFile, "utf8");
        break;
      }
      await sleep(250);
    }

    assert.ok(resultRaw, `supervisor did not record a rollback result within timeout.\nsupervisor stderr:\n${stderr}`);
    const result = JSON.parse(resultRaw) as {
      operationId?: string;
      status?: string;
      version?: string;
      migrationApplied?: boolean;
    };
    assert.equal(result.operationId, opId, "result must be keyed to the failed operation");
    assert.equal(result.status, "rolledback", "a health-gate failure must be recorded as a rollback");
    assert.equal(result.version, "0.0.1", "rollback must land on the last-good version");
    assert.equal(result.migrationApplied, false, "migrationApplied must be carried from the promoting marker");

    // desired-version + current symlink must point at the last-good version, not
    // the broken release — otherwise a restart would relaunch the crash-looper.
    const settleDeadline = Date.now() + 15_000;
    let desired = "";
    while (Date.now() < settleDeadline) {
      desired = readFileSync(path.join(stateDir, "desired-version"), "utf8").trim();
      if (desired === "0.0.1") break;
      await sleep(200);
    }
    assert.equal(desired, "0.0.1", "desired-version must be rolled back to last-good");

    const currentTarget = path.basename(readlinkSync(path.join(root, "current")));
    assert.equal(currentTarget, "0.0.1", "current symlink must point at the last-good release");

    // The failed 'update' release is discarded so it is never offered as a rollback
    // target; the last-good release must survive.
    assert.equal(existsSync(path.join(root, "releases", "0.0.2")), false, "failed update release must be discarded");
    assert.ok(existsSync(path.join(root, "releases", "0.0.1")), "last-good release must survive");

    // The rolled-back good version must actually be serving (the supervisor relaunched
    // it and it passed the readiness gate) — proof the rollback restored service.
    let served = false;
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
    assert.ok(served, `rolled-back good version must be serving.\nsupervisor stderr:\n${stderr}`);
  } finally {
    // Kill the whole supervisor process group (supervisor + relaunched app that
    // holds the port) so the test frees the port and leaves nothing behind.
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(root, { recursive: true, force: true });
  }
}

void main().then(() => {
  console.log("system-update-supervisor.regression.ts passed");
});
