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
async function runRollbackScenario(lastGoodKind: "good" | "bad", resumeLanding = false) {
  const port = await freePort();
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-"));
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  writeRelease(root, "0.0.1", lastGoodKind, port);
  // A resumed landing may already have discarded the original candidate.
  if (!resumeLanding) writeRelease(root, "0.0.2", "bad", port);
  writeFileSync(path.join(stateDir, "last-good-version"), "0.0.1");
  writeFileSync(path.join(stateDir, "desired-version"), resumeLanding ? "0.0.1" : "0.0.2");
  const opId = `sysop-rollback-${lastGoodKind}${resumeLanding ? "-resumed" : ""}`;
  writeFileSync(
    path.join(stateDir, "promoting.json"),
    JSON.stringify(resumeLanding
      ? { version: "0.0.1", operationId: opId, kind: "rollback", migrationApplied: true, rollbackFrom: "0.0.2" }
      : { version: "0.0.2", operationId: opId, kind: "update", migrationApplied: false })
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

/**
 * Boot the supervisor with a MANUAL (operator-requested) rollback staged as a pending
 * marker (kind=rollback, NO rollbackFrom) to a healthy target, and return the terminal
 * result. A manual rollback that comes up healthy must finalize as 'success', never
 * 'rolledback' (which is reserved for an automatic post-failure rollback landing).
 */
async function runManualRollbackScenario() {
  const port = await freePort();
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-"));
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  writeRelease(root, "0.0.1", "good", port); // rollback target (older, healthy)
  writeRelease(root, "0.0.2", "good", port); // currently running (healthy)
  writeFileSync(path.join(stateDir, "last-good-version"), "0.0.2");
  writeFileSync(path.join(stateDir, "desired-version"), "0.0.2");
  const opId = "sysop-manual-rollback";
  // Operator rollback: the app stages pending.json kind=rollback with NO rollbackFrom.
  writeFileSync(
    path.join(stateDir, "pending.json"),
    JSON.stringify({ version: "0.0.1", operationId: opId, kind: "rollback", migrationApplied: false })
  );

  const env = {
    ...process.env,
    CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"),
    CHORDV_SYSTEM_STATE_DIR: stateDir,
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
    CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port),
    CHORDV_SUPERVISOR_MIGRATE: "false",
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
    return { result, opId, stderr };
  } finally {
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Boot the supervisor with an in-flight update whose promoting marker says it WILL
 * migrate (migrationApplied=true), but make the pre-migration snapshot FAIL (no
 * DATABASE_URL). The migration therefore never runs, so the auto-rollback result must
 * record migrationApplied=FALSE — not the marker's true — so the audit/UI never claims
 * the schema changed when it did not.
 */
async function runSnapshotFailureScenario() {
  const port = await freePort();
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-"));
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  writeRelease(root, "0.0.1", "good", port); // last-good target
  writeRelease(root, "0.0.2", "good", port); // candidate (never launched: snapshot fails first)
  writeFileSync(path.join(stateDir, "last-good-version"), "0.0.1");
  writeFileSync(path.join(stateDir, "desired-version"), "0.0.2");
  const opId = "sysop-snapshot-fail";
  writeFileSync(
    path.join(stateDir, "promoting.json"),
    JSON.stringify({ version: "0.0.2", operationId: opId, kind: "update", migrationApplied: true })
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"),
    CHORDV_SYSTEM_STATE_DIR: stateDir,
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
    CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port),
    CHORDV_SUPERVISOR_MIGRATE: "false",
    CHORDV_SYSTEM_UPDATE_SNAPSHOT: "true",
    CHORDV_SYSTEM_UPDATE_BACKUP_DIR: path.join(stateDir, "backups"),
    CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "8",
    CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
  };
  delete env.DATABASE_URL; // force run_snapshot to fail before any migration runs

  const child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    const result = await waitForResult(path.join(stateDir, `operation-result.${opId}.json`), 60_000);
    return { result, opId, stderr };
  } finally {
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, message: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message());
    await sleep(100);
  }
}

/** Fail actual atomic renames until the test releases them, without restarting the app. */
async function runFinalizationRetryScenario(fault: "result" | "last-good", resumeLanding = false) {
  const port = await freePort();
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-retry-"));
  const stateDir = path.join(root, "state");
  const binDir = path.join(root, "bin");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir);
  const version = resumeLanding ? "0.0.1" : "0.0.2";
  const release = writeRelease(root, version, "good", port);
  const launchFile = path.join(root, "launches");
  const appFile = path.join(release, APP_ENTRY);
  writeFileSync(appFile,
    `require('fs').appendFileSync(${JSON.stringify(launchFile)},process.pid+'\\n');` + readFileSync(appFile, "utf8"));
  const opId = `sysop-retry-${fault}${resumeLanding ? "-landing" : ""}`;
  const markerFile = path.join(stateDir, "promoting.json");
  const marker = {
    version, operationId: opId, kind: resumeLanding ? "rollback" : "update",
    migrationApplied: resumeLanding, rollbackFrom: resumeLanding ? "0.0.2" : ""
  };
  writeFileSync(markerFile, JSON.stringify(marker));
  writeFileSync(path.join(stateDir, "desired-version"), version);
  writeFileSync(path.join(stateDir, "last-good-version"), "0.0.1");
  const resultFile = path.join(stateDir, `operation-result.${opId}.json`);
  const blocker = path.join(root, "block-writes");
  const attemptsFile = path.join(root, "failed-writes");
  writeFileSync(blocker, "");
  // Intercept only the selected destination; all other state writes use real mv.
  // Permission-based faults are not deterministic when CI happens to run as root.
  writeFileSync(path.join(binDir, "mv"), `#!/usr/bin/env bash
if [ "\${!#}" = "$CHORDV_TEST_FAULT_TARGET" ] && [ -f "$CHORDV_TEST_BLOCKER" ]; then
  printf 'failed\\n' >> "$CHORDV_TEST_ATTEMPTS"
  exit 1
fi
exec /bin/mv "$@"
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CHORDV_TEST_FAULT_TARGET: fault === "result" ? resultFile : path.join(stateDir, "last-good-version"),
    CHORDV_TEST_BLOCKER: blocker,
    CHORDV_TEST_ATTEMPTS: attemptsFile,
    CHORDV_SYSTEM_NODE_BIN: process.execPath,
    CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"),
    CHORDV_SYSTEM_STATE_DIR: stateDir,
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
    CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port),
    CHORDV_SUPERVISOR_MIGRATE: "false",
    CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "8",
    CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
  };
  const child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    // Six failures exceed the former five-attempt last-good budget. Result writes
    // must retry too, instead of clearing GEN_* and waiting forever for app exit.
    const failures = fault === "last-good" ? 6 : 2;
    await waitUntil(
      () => existsSync(attemptsFile) && readFileSync(attemptsFile, "utf8").trim().split("\n").length >= failures,
      30_000, () => `${fault} persistence did not keep retrying.\n${stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(markerFile, "utf8")), marker, "retry must retain the original promotion marker");
    assert.equal(existsSync(resultFile), false, "must not publish a result before persistence succeeds");
    const launches = readFileSync(launchFile, "utf8");
    assert.equal(launches.trim().split("\n").length, 1, "persistence retries must not restart the app");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health/ready`)).status, 200, "app must serve during retries");
    rmSync(blocker);
    const result = await waitForResult(resultFile, 15_000);
    assert.ok(result, `${fault} persistence did not recover without an app restart.\n${stderr}`);
    assert.equal(result.operationId, opId, "retry must finalize the original operation");
    assert.equal(result.status, resumeLanding ? "rolledback" : "success");
    assert.equal(result.version, version);
    assert.equal(result.migrationApplied, resumeLanding, "retry must retain migration context");
    await waitUntil(() => !existsSync(markerFile), 5_000, () => `finalized marker was not cleared.\n${stderr}`);
    assert.equal(readFileSync(path.join(stateDir, "last-good-version"), "utf8"), version);
    assert.equal(readFileSync(launchFile, "utf8"), launches, "recovery must use the same app process");
    process.kill(Number(launches.trim()), 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health/ready`)).status, 200);
  } finally {
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
    // The audit must preserve the ORIGINALLY ATTEMPTED candidate (0.0.2), not collapse
    // to the last-good fallback (0.0.1) it ended up sitting on.
    assert.equal(
      s.result.version,
      "0.0.2",
      `failed result must record the attempted candidate, not the fallback (got '${s.result.version}').\nsupervisor stderr:\n${s.stderr}`
    );
  }

  // Scenario C: an operator-requested (manual) rollback to a healthy target must
  // finalize as 'success' — NOT 'rolledback'. 'rolledback' is reserved for an
  // automatic post-failure rollback landing (rollbackFrom present); reporting a manual
  // rollback as auto-rolled-back would give a wrong audit status + misleading UI.
  {
    const s = await runManualRollbackScenario();
    assert.ok(s.result, `supervisor did not record a result within timeout.\nsupervisor stderr:\n${s.stderr}`);
    assert.equal(s.result.operationId, s.opId, "result must be keyed to the manual-rollback operation");
    assert.equal(
      s.result.status,
      "success",
      `a successful manual rollback must be 'success', not '${s.result.status}'.\nsupervisor stderr:\n${s.stderr}`
    );
    assert.equal(s.result.version, "0.0.1", "manual rollback must land on the requested target");
  }

  // Scenario D: the pre-migration snapshot fails, so migration NEVER runs. The
  // auto-rollback result must record migrationApplied=FALSE (not the marker's true),
  // or the audit/UI would wrongly claim the schema changed and mislead recovery.
  {
    const s = await runSnapshotFailureScenario();
    assert.ok(s.result, `supervisor did not record a result within timeout.\nsupervisor stderr:\n${s.stderr}`);
    assert.equal(s.result.operationId, s.opId, "result must be keyed to the operation");
    assert.equal(s.result.status, "rolledback", "a pre-migration snapshot failure must auto-roll-back");
    assert.equal(
      s.result.migrationApplied,
      false,
      `snapshot failure means migration never ran → migrationApplied must be false (got ${s.result.migrationApplied}).\nsupervisor stderr:\n${s.stderr}`
    );
  }

  // Scenario E: supervisor restarted after writing the automatic rollback marker.
  // The candidate is already gone; only rollbackFrom can identify the failed target.
  {
    const s = await runRollbackScenario("bad", true);
    assert.ok(s.result, `resumed rollback did not record a result.\n${s.stderr}`);
    assert.equal(s.result.operationId, s.opId);
    assert.equal(s.result.status, "failed", "an unhealthy resumed fallback must not claim rollback success");
    assert.equal(s.result.version, "0.0.2", "resumed failure must recover the original candidate from rollbackFrom");
    assert.equal(s.result.migrationApplied, true, "resumed failure must preserve migration context");
  }

  // Scenario F: recover transient result I/O failures in-place for both a forward
  // update and a resumed automatic rollback, preserving the original operation.
  await runFinalizationRetryScenario("result");
  await runFinalizationRetryScenario("result", true);

  // Scenario G: last-good persistence must recover even after the old retry budget.
  await runFinalizationRetryScenario("last-good");
}

void main().then(() => {
  console.log("system-update-supervisor.regression.ts passed");
});
