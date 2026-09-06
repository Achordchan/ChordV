import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

type ResultMarker = { operationId?: string; status?: string; version?: string; reason?: string; migrationApplied?: boolean };

function failingMigrationEnv(root: string, versions: string[]) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  // macOS has no timeout; deterministic stubs exit immediately, so no timer needed.
  writeFileSync(path.join(bin, "timeout"), '#!/usr/bin/env bash\nshift 3\nexec "$@"\n', { mode: 0o755 });
  for (const version of versions) {
    const dir = path.join(root, "releases", version, "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "prisma-migrate-with-baseline.mjs"),
      `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(path.join(root, "migrations"))},${JSON.stringify(version + "\n")});console.error('P3009 unfinished migration');process.exit(1);`);
  }
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    CHORDV_SYSTEM_NODE_BIN: process.execPath,
    CHORDV_SUPERVISOR_MIGRATE: "true",
    CHORDV_SYSTEM_UPDATE_SNAPSHOT: "false"
  };
}

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
async function runRollbackScenario(lastGoodKind: "good" | "bad", resumeLanding = false, migrateFails = false, hangsOnStop = false) {
  const port = await freePort();
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-"));
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  writeRelease(root, "0.0.1", lastGoodKind, port);
  // A resumed landing may already have discarded the original candidate.
  if (!resumeLanding) writeRelease(root, "0.0.2", "bad", port);
  if (hangsOnStop) writeFileSync(path.join(root, "releases", "0.0.2", APP_ENTRY),
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
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
    CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public-state"),
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
    CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port),
    CHORDV_SUPERVISOR_MIGRATE: "false",
    ...(migrateFails ? failingMigrationEnv(root, ["0.0.1", "0.0.2"]) : {}),
    // Keep the bad releases' health gate short so the (fast) crash path dominates and
    // the "last-good also fails" scenario doesn't sit out a long timeout per attempt.
    CHORDV_SYSTEM_FAILED_STOP_TIMEOUT_SECONDS: "1",
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
    if (migrateFails) {
      assert.equal(readFileSync(path.join(root, "migrations"), "utf8"), "0.0.2\n", "only the forward candidate may run migrate deploy; fallback must bypass P3009");
    }
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
async function runManualRollbackScenario(migrateFails = false) {
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
    CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public-state"),
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
    CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port),
    CHORDV_SUPERVISOR_MIGRATE: "false",
    ...(migrateFails ? failingMigrationEnv(root, ["0.0.1", "0.0.2"]) : {}),
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
    CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public-state"),
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
  delete env.CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL;

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
async function runFinalizationRetryScenario(fault: "result" | "last-good" | "remove" | "public", resumeLanding = false, crashAfterPublicFailure = false) {
  const port = await freePort();
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-retry-"));
  const stateDir = path.join(root, "state");
  const binDir = path.join(root, "bin");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir);
  const version = resumeLanding ? "0.0.1" : "0.0.2";
  const release = writeRelease(root, version, "good", port);
  if (fault === "public") writeRelease(root, "0.0.1", "good", port);
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
  writeFileSync(path.join(binDir, "rm"), `#!/usr/bin/env bash
if [ "\${!#}" = "$CHORDV_TEST_FAULT_TARGET" ] && [ -f "$CHORDV_TEST_BLOCKER" ]; then
  printf 'failed\\n' >> "$CHORDV_TEST_ATTEMPTS"
  exit 1
fi
exec /bin/rm "$@"
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CHORDV_TEST_FAULT_TARGET: fault === "public" ? path.join(root, "public-state", "last-good-version") : fault === "remove" ? markerFile : fault === "result" ? resultFile : path.join(stateDir, "last-good-version"),
    CHORDV_TEST_BLOCKER: blocker,
    CHORDV_TEST_ATTEMPTS: attemptsFile,
    CHORDV_SYSTEM_NODE_BIN: process.execPath,
    CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"),
    CHORDV_SYSTEM_STATE_DIR: stateDir,
    CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public-state"),
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
    CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port),
    CHORDV_SUPERVISOR_MIGRATE: "false",
    CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "8",
    CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
  };
  let child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
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
    assert.equal(existsSync(resultFile), fault === "remove", "result must be persisted before marker removal");
    const launches = readFileSync(launchFile, "utf8");
    assert.equal(launches.trim().split("\n").length, 1, "persistence retries must not restart the app");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health/ready`)).status, 200, "app must serve during retries");
    if (fault === "public") {
      assert.equal(readFileSync(path.join(stateDir, "last-good-version.previous"), "utf8"), "0.0.1");
    }
    rmSync(blocker);
    if (crashAfterPublicFailure) {
      process.kill(-child.pid!, "SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
      writeFileSync(appFile, "process.exit(1);");
      child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.on("data", chunk => { stderr += chunk; });
      const recovered = await waitForResult(resultFile, 15_000);
      assert.equal(recovered?.status, "rolledback", stderr);
      assert.equal(recovered.version, "0.0.1", "restart must retain actual previous good target");
      assert.equal(readFileSync(path.join(root, "public-state", "last-good-version"), "utf8"), "0.0.1");
      return;
    }
    const result = await waitForResult(resultFile, 15_000);
    assert.ok(result, `${fault} persistence did not recover without an app restart.\n${stderr}`);
    assert.equal(result.operationId, opId, "retry must finalize the original operation");
    assert.equal(result.status, resumeLanding ? "rolledback" : "success");
    assert.equal(result.version, version);
    assert.equal(result.migrationApplied, resumeLanding, "retry must retain migration context");
    await waitUntil(() => !existsSync(markerFile), 5_000, () => `finalized marker was not cleared.\n${stderr}`);
    assert.equal(readFileSync(path.join(stateDir, "last-good-version"), "utf8"), version);
    assert.equal(readFileSync(path.join(root, "public-state", "last-good-version"), "utf8"), version, "admin marker must publish only the approved version");
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

async function runTerminalFailureRetryScenario(resume: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-failed-"));
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  mkdirSync(state); mkdirSync(bin);
  const port = await freePort();
  const version = resume ? "0.0.1" : "0.0.2";
  const op = "sysop-terminal-failure";
  const release = writeRelease(root, version, "bad", port);
  const marker = path.join(state, "promoting.json");
  const resultFile = path.join(state, `operation-result.${op}.json`);
  const attempts = path.join(root, "attempts");
  const blocker = path.join(root, "block");
  writeFileSync(blocker, "");
  writeFileSync(path.join(state, "desired-version"), version);
  writeFileSync(path.join(state, "last-good-version"), version);
  writeFileSync(marker, JSON.stringify({ version, operationId: op, kind: resume ? "rollback" : "update", rollbackFrom: resume ? "0.0.2" : "", migrationApplied: true }));
  writeFileSync(path.join(bin, "mv"), `#!/usr/bin/env bash
if [ "\${!#}" = "$CHORDV_TEST_RESULT" ] && [ -f "$CHORDV_TEST_BLOCK" ]; then
  printf 'failed\\n' >> "$CHORDV_TEST_ATTEMPTS"
  exit 1
fi
exec /bin/mv "$@"
`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    CHORDV_TEST_RESULT: resultFile, CHORDV_TEST_BLOCK: blocker, CHORDV_TEST_ATTEMPTS: attempts,
    CHORDV_SYSTEM_NODE_BIN: process.execPath,
    CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"), CHORDV_SYSTEM_STATE_DIR: state,
    CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public-state"),
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"), CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port), CHORDV_SUPERVISOR_MIGRATE: "false", CHORDV_SYSTEM_UPDATE_SNAPSHOT: "false",
    CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "5", CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
  };
  let stderr = "";
  const start = () => {
    const child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    return child;
  };
  let child = start();
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { return; }
    await exited;
  };
  try {
    const count = () => existsSync(attempts) ? readFileSync(attempts, "utf8").trim().split("\n").length : 0;
    await waitUntil(() => count() >= 2, 15_000, () => `terminal failure did not retry.\n${stderr}`);
    const journal = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(journal.failureVersion, "0.0.2");
    assert.equal(journal.migrationApplied, true);
    assert.match(journal.failureReason, /健康检查/);
    // Fix the app while result writes remain blocked. It must not be relaunched
    // and finalize this already-failed operation as success/rolledback.
    writeRelease(root, version, "good", port);
    const launch = path.join(root, "recovered-launch");
    const appFile = path.join(release, APP_ENTRY);
    writeFileSync(appFile, `require('fs').writeFileSync(${JSON.stringify(launch)},'yes');` + readFileSync(appFile, "utf8"));
    if (resume) {
      await stop(); child = start();
    }
    const before = count();
    await waitUntil(() => count() > before, 10_000, () => `failure retry stopped.\n${stderr}`);
    assert.equal(existsSync(resultFile), false);
    assert.equal(existsSync(launch), false, "terminal failure must persist before relaunch/re-gate");
    rmSync(blocker);
    const result = await waitForResult(resultFile, 10_000);
    assert.deepEqual(result, { operationId: op, status: "failed", version: "0.0.2", reason: journal.failureReason, migrationApplied: true });
    // Terminal failures now deliberately require offline recovery, rather than an
    // ordinary restart that would erase snapshot/rollback migration safety gates.
    await waitUntil(() => child.exitCode !== null, 10_000, () => `failed promotion did not stop.\n${stderr}`);
    assert.equal(child.exitCode, 1);
    assert.equal(existsSync(launch), false, "persisting a failure must not authorize a normal relaunch");
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), journal, "terminal journal must remain a durable launch interlock");
    child = start();
    await waitUntil(() => child.exitCode !== null, 10_000, () => `restart did not stay blocked.\n${stderr}`);
    assert.equal(child.exitCode, 1);
    assert.equal(existsSync(launch), false, "repairing the app alone must not unblock the failed operation");
    assert.equal(JSON.parse(readFileSync(resultFile, "utf8")).status, "failed", "later recovery must not overwrite the terminal failure");
  } finally {
    await stop(); rmSync(root, { recursive: true, force: true });
  }
}

/** A failed required snapshot must never fall through to ordinary-start migrations. */
async function runBlockedSnapshotRecoveryScenario(lastGood: "missing" | "same" | "unusable") {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-blocked-"));
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  const backups = path.join(state, "backups");
  mkdirSync(state); mkdirSync(bin);
  const port = await freePort();
  const version = "0.0.2";
  const op = `sysop-snapshot-blocked-${lastGood}`;
  const recoveryOp = `${op}-recovery`;
  const release = writeRelease(root, version, "good", port);
  const marker = path.join(state, "promoting.json");
  const resultFile = path.join(state, `operation-result.${op}.json`);
  const migrations = path.join(root, "migrations");
  const launches = path.join(root, "launches");
  const dumpBlock = path.join(root, "dump-block");
  writeFileSync(dumpBlock, "");
  writeFileSync(path.join(state, "desired-version"), version);
  if (lastGood !== "missing") writeFileSync(path.join(state, "last-good-version"), lastGood === "same" ? version : "0.0.1");
  writeFileSync(marker, JSON.stringify({ version, operationId: op, kind: "update", migrationApplied: true }));
  const appFile = path.join(release, APP_ENTRY);
  writeFileSync(appFile, `require('fs').appendFileSync(${JSON.stringify(launches)},'launch\\n');` + readFileSync(appFile, "utf8"));
  mkdirSync(path.join(release, "scripts"));
  writeFileSync(path.join(release, "scripts/prisma-migrate-with-baseline.mjs"),
    `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(migrations)},'migrate\\n');` +
    `if(!fs.readdirSync(${JSON.stringify(backups)}).some(n=>n.startsWith(${JSON.stringify(`pre-migrate-${version}-${recoveryOp}-`)})&&n.endsWith('.sql.gz')))process.exit(1);`);
  writeFileSync(path.join(bin, "timeout"), '#!/usr/bin/env bash\nshift 3\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, "pg_dump"), '#!/usr/bin/env bash\n[ -f "$CHORDV_TEST_DUMP_BLOCK" ] && exit 1\nprintf "snapshot\\n"\n', { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    CHORDV_TEST_DUMP_BLOCK: dumpBlock, CHORDV_SYSTEM_NODE_BIN: process.execPath,
    CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"), CHORDV_SYSTEM_STATE_DIR: state,
    CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public-state"),
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"), CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port), CHORDV_SUPERVISOR_MIGRATE: "true", CHORDV_SYSTEM_UPDATE_SNAPSHOT: "true",
    CHORDV_SYSTEM_UPDATE_BACKUP_DIR: backups, CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql://stub/db",
    CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "5", CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
  };
  let stderr = "";
  const start = () => {
    const child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    return child;
  };
  let child = start();
  const assertBlocked = async () => {
    await waitUntil(() => child.exitCode !== null, 15_000, () => `snapshot failure did not block launch (${lastGood}).\n${stderr}`);
    assert.equal(child.exitCode, 1);
    assert.equal(existsSync(migrations), false, "migration stub must never run, including the next supervisor loop");
    assert.equal(existsSync(launches), false, "unvalidated candidate must not launch");
    assert.match(stderr, /promotion recovery blocked/);
  };
  try {
    await assertBlocked();
    const result = await waitForResult(resultFile, 1_000);
    assert.equal(result?.status, "failed");
    assert.equal(result.version, version);
    assert.equal(result.migrationApplied, false);
    assert.match(result.reason!, /快照失败/);
    const journal = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(journal.failureVersion, version);
    assert.equal(journal.migrationApplied, false, "false is an audit fact, not permission to skip the snapshot");
    // Same durable state on container restart, with snapshot still broken.
    child = start();
    await assertBlocked();
    // Fixing pg_dump is insufficient: this original operation is terminal.
    rmSync(dumpBlock);
    child = start();
    await assertBlocked();
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), journal);
    assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), result);
    // Explicit offline recovery from the logged instructions: NEW operation, with
    // its own required snapshot gate; only then remove the interlock and restart.
    writeFileSync(path.join(state, "pending.json"), JSON.stringify({ version, operationId: recoveryOp, kind: "update", migrationApplied: true }));
    rmSync(marker);
    child = start();
    const recovered = await waitForResult(path.join(state, `operation-result.${recoveryOp}.json`), 15_000);
    assert.equal(recovered?.status, "success", stderr);
    assert.equal(recovered.operationId, recoveryOp);
    assert.equal(readFileSync(migrations, "utf8"), "migrate\n", "exactly one migration, after the new operation's snapshot succeeded");
    assert.equal(readFileSync(launches, "utf8"), "launch\n");
    assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), result, "recovery must not change the original terminal audit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/** Invalid recovery state is a launch interlock, including when read/stat fails. */
async function testInvalidJournals() {
  const valid = { version: "0.0.2", operationId: "sysop_012345abcdef", kind: "update", migrationApplied: true };
  const invalid: Array<[string, string | "directory" | "dangling" | "read-error"]> = [
    ["malformed", '{"version":"0.0.2",oops}'],
    ["truncated", JSON.stringify(valid).slice(0, -1)],
    ["version-only", '{"version":"0.0.2"}'],
    ["null", "null"], ["array", JSON.stringify([valid])],
    ...["version", "operationId", "kind", "migrationApplied"].map(key => {
      const marker = { ...valid } as Record<string, unknown>; delete marker[key];
      return [`missing-${key}`, JSON.stringify(marker)] as [string, string];
    }),
    ...Object.entries({ version: 2, operationId: {}, kind: [], migrationApplied: "true" }).map(([key, value]) =>
      [`type-${key}`, JSON.stringify({ ...valid, [key]: value })] as [string, string]),
    ["null-boolean", JSON.stringify({ ...valid, migrationApplied: null })],
    ["number-boolean", JSON.stringify({ ...valid, migrationApplied: 1 })],
    ["string-false", JSON.stringify({ ...valid, migrationApplied: "false" })],
    ["unknown-kind", JSON.stringify({ ...valid, kind: "promote" })],
    ["unsafe-version", JSON.stringify({ ...valid, version: "../0.0.2" })],
    ["unsafe-operation", JSON.stringify({ ...valid, operationId: "../escape" })],
    ["newline-operation", JSON.stringify({ ...valid, operationId: "sysop_safe\n" })],
    ["invalid-rollback", JSON.stringify({ ...valid, rollbackFrom: "0.0.1" })],
    ["same-rollback", JSON.stringify({ ...valid, kind: "rollback", rollbackFrom: "0.0.2" })],
    ["null-rollback", JSON.stringify({ ...valid, rollbackFrom: null })],
    ["unsafe-rollback", JSON.stringify({ ...valid, kind: "rollback", rollbackFrom: "../0.0.1" })],
    ["wrong-failure", JSON.stringify({ ...valid, failureVersion: "0.0.1", failureReason: "failed" })],
    ["missing-reason", JSON.stringify({ ...valid, failureVersion: "0.0.2" })],
    ["reason-only", JSON.stringify({ ...valid, failureReason: "failed" })],
    ["invalid-reason", JSON.stringify({ ...valid, failureVersion: "0.0.2", failureReason: {} })],
    ["unsafe-reason", JSON.stringify({ ...valid, failureVersion: "0.0.2", failureReason: 'bad "reason"\n' })],
    ["directory", "directory"], ["dangling", "dangling"], ["read-error", "read-error"]
  ];
  for (const source of ["promoting", "pending"] as const) {
    const cases = [...invalid];
    if (source === "pending") {
      cases.push(["terminal-pending", JSON.stringify({ ...valid, failureVersion: "0.0.2", failureReason: "failed" })]);
      cases.push(["auto-rollback-pending", JSON.stringify({ ...valid, kind: "rollback", rollbackFrom: "0.0.1" })]);
    }
    for (const [name, contents] of cases) {
      const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-invalid-"));
      const state = path.join(root, "state"); mkdirSync(state);
      const port = await freePort();
      for (const version of ["0.0.1", "0.0.2"]) writeRelease(root, version, "good", port);
      const migrateEnv = failingMigrationEnv(root, ["0.0.1", "0.0.2"]);
      const launches = path.join(root, "launches");
      for (const version of ["0.0.1", "0.0.2"]) {
        writeFileSync(path.join(root, "releases", version, APP_ENTRY), `require('fs').writeFileSync(${JSON.stringify(launches)},'launched');process.exit(1);`);
      }
      writeFileSync(path.join(state, "desired-version"), "0.0.2");
      writeFileSync(path.join(state, "last-good-version"), "0.0.1");
      const current = path.join(root, "current"); symlinkSync(path.join(root, "releases", "0.0.1"), current);
      const marker = path.join(state, `${source}.json`);
      if (contents === "directory") mkdirSync(marker);
      else if (contents === "dangling") symlinkSync(path.join(root, "missing-journal"), marker);
      else writeFileSync(marker, contents === "read-error" ? JSON.stringify(valid) : contents);
      // A deterministic EIO on a regular file works even when CI runs as root.
      const fault = path.join(root, "read-fault.cjs");
      writeFileSync(fault, `const fs=require('node:fs'),read=fs.readFileSync;fs.readFileSync=function(file,...args){if(file===${JSON.stringify(marker)})throw Object.assign(new Error('read error'),{code:'EIO'});return read.call(this,file,...args);};`);
      const env = {
        ...process.env, ...migrateEnv,
        NODE_OPTIONS: contents === "read-error" ? `--require=${fault}` : "",
        CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"), CHORDV_SYSTEM_STATE_DIR: state,
        CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public-state"), CHORDV_SYSTEM_UPDATE_BACKUP_DIR: path.join(root, "backups"),
        CHORDV_SYSTEM_CURRENT_LINK: current, CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
        CHORDV_API_PORT: String(port), CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "2", CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
      };
      try {
        // Same damaged journal across a container restart must remain blocked.
        for (let restart = 0; restart < 2; restart++) {
          const child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
          let stderr = ""; child.stderr?.on("data", chunk => { stderr += String(chunk); });
          try {
            await waitUntil(() => child.exitCode !== null, 8_000, () => `${source}/${name} did not fail closed.\n${stderr}`);
            assert.equal(child.exitCode, 1, `${source}/${name}: ${stderr}`);
            assert.match(stderr, /invalid\/unreadable .* journal/);
            assert.equal(existsSync(path.join(root, "migrations")), false, "must not migrate on any restart");
            assert.equal(existsSync(launches), false, "must not launch/re-gate with invalid journal");
            assert.equal(readFileSync(path.join(state, "desired-version"), "utf8"), "0.0.2");
            assert.equal(path.basename(readlinkSync(current)), "0.0.1", "must not promote");
            for (const version of ["0.0.1", "0.0.2"]) assert.ok(existsSync(path.join(root, "releases", version)), "must not discard releases");
            assert.equal(readdirSync(state).some(file => file.startsWith("operation-result")), false, "must not invent a result from corrupt state");
            if (contents === "directory") assert.ok(lstatSync(marker).isDirectory());
            else if (contents === "dangling") assert.ok(lstatSync(marker).isSymbolicLink());
            else assert.equal(readFileSync(marker, "utf8"), contents === "read-error" ? JSON.stringify(valid) : contents, "must retain original journal bytes");
          } finally {
            try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
          }
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
}

async function testInvalidPendingAfterAppExit() {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-pending-exit-"));
  const state = path.join(root, "state"); mkdirSync(state);
  const port = await freePort();
  const release = writeRelease(root, "0.0.1", "good", port);
  writeRelease(root, "0.0.2", "good", port);
  writeFileSync(path.join(state, "desired-version"), "0.0.1");
  const exitTrigger = path.join(root, "exit-trigger");
  const app = path.join(release, APP_ENTRY);
  writeFileSync(app, readFileSync(app, "utf8") + `setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(exitTrigger)}))process.exit(0);},50);`);
  const migrateEnv = failingMigrationEnv(root, ["0.0.2"]);
  const marker = path.join(state, "pending.json");
  const contents = '{"version":"0.0.2","operationId":"sysop_exit","kind":"update"}';
  const env = {
    ...process.env, ...migrateEnv,
    CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"), CHORDV_SYSTEM_STATE_DIR: state,
    CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public-state"), CHORDV_SYSTEM_UPDATE_BACKUP_DIR: path.join(root, "backups"),
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"), CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"),
    CHORDV_API_PORT: String(port), CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "5", CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
  };
  let stderr = "";
  const start = () => {
    const child = spawn("bash", [entrypoint], { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    return child;
  };
  let child = start();
  try {
    await waitUntil(() => stderr.includes("0.0.1 healthy + stable"), 10_000, () => `initial app did not stabilize.\n${stderr}`);
    writeFileSync(marker, contents); writeFileSync(exitTrigger, "");
    for (let restart = 0; restart < 2; restart++) {
      if (restart) child = start();
      await waitUntil(() => child.exitCode !== null, 8_000, () => `invalid runtime pending marker did not stop supervisor.\n${stderr}`);
      assert.equal(child.exitCode, 1, stderr);
      assert.match(stderr, /invalid\/unreadable pending journal/);
      assert.equal(readFileSync(marker, "utf8"), contents);
      assert.equal(existsSync(path.join(root, "migrations")), false, "invalid runtime pending must never migrate, including restart");
      assert.equal(readFileSync(path.join(state, "desired-version"), "utf8"), "0.0.1");
      assert.equal(path.basename(readlinkSync(path.join(root, "current"))), "0.0.1");
      assert.ok(existsSync(path.join(root, "releases", "0.0.2")));
      assert.equal(existsSync(path.join(state, "promoting.json")), false);
    }
  } finally {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    rmSync(root, { recursive: true, force: true });
  }
}

function testJournalFieldExtraction() {
  const script = readFileSync(entrypoint, "utf8");
  const definitions = script.slice(0, script.indexOf('\nAPP_PID=""'));
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-journal-fields-"));
  const marker = path.join(root, "journal.json");
  try {
    for (const kind of ["update", "rollback", "restart"]) {
      // JSON escapes, formatting, and nested lookalike keys must not confuse the
      // validated top-level fields. Restart and manual rollback remain supported.
      writeFileSync(marker, JSON.stringify({
        version: "1.2.3-beta.1+build.7", operationId: "sysop_012345abcdef", kind, migrationApplied: false,
        ignored: { version: "9.9.9", operationId: "wrong", kind: "wrong", migrationApplied: true }
      }, null, 2).replace('"1.2.3', '"\\u0031.2.3'));
      const parsed = spawnSync("bash", ["-c", `${definitions}\nload_journal "$CHORDV_TEST_MARKER" pending\nprintf '%s|%s|%s|%s' "$JOURNAL_VERSION" "$JOURNAL_OP" "$JOURNAL_KIND" "$JOURNAL_MIG"`], {
        encoding: "utf8", env: { ...process.env, CHORDV_SYSTEM_NODE_BIN: process.execPath, CHORDV_TEST_MARKER: marker }
      });
      assert.equal(parsed.status, 0, parsed.stderr);
      assert.equal(parsed.stdout, `1.2.3-beta.1+build.7|sysop_012345abcdef|${kind}|false`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function testSnapshotDatabaseUrl() {
  const script = readFileSync(entrypoint, "utf8");
  const definitions = script.slice(0, script.indexOf('\nAPP_PID=""'));
  const root = mkdtempSync(path.join(tmpdir(), "chordv-sup-url-"));
  const raw = "postgresql://us%40er:p%3Ass%2F%25%3F%23@db.example:5432/chordv?schema=public&sslmode=require&connect_timeout=12&application_name=backup%20job&options=-c%20search_path%3Dpublic&connection_limit=4&pool_timeout=10&socket_timeout=9&pgbouncer=true&statement_cache_size=0&sslaccept=strict&sslidentity=client.p12&%73chema=other&sslrootcert=%2Fcerts%2Froot.pem";
  const expectedBody = "host=db.example\nport=5432\ndbname=chordv\nuser=us@er\npassword=p:ss/%?#\n" +
    "sslmode=require\nconnect_timeout=12\napplication_name=backup job\noptions=-c search_path=public\nsslrootcert=/certs/root.pem";
  const env = { ...process.env, CHORDV_SYSTEM_NODE_BIN: process.execPath, DATABASE_URL: raw, CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "" };
  const convert = (overrides: NodeJS.ProcessEnv = {}) => spawnSync("bash", ["-c", `${definitions}\nsnapshot_service_config`], { env: { ...env, ...overrides }, encoding: "utf8" });
  try {
    let result = convert();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expectedBody);
    assert.equal(result.stderr, "");
    const direct = "postgresql://a%40b:p%3Aq@direct/db?sslmode=verify-full";
    result = convert({ CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: direct });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "host=direct\ndbname=db\nuser=a@b\npassword=p:q\nsslmode=verify-full");
    // An omitted port must stay omitted so libpq applies PGPORT/default resolution.
    result = convert({ CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql://backup@db/chordv", PGPORT: "6543" });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^port=/m, "omitted URI port must not be pinned in the service file");
    // URIs relying on libpq defaults stay valid: unix-socket form (no host) and
    // database-name-defaults-to-user form (no dbname).
    result = convert({ CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql:///chordv" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "dbname=chordv");
    result = convert({ CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql://backup@db.example" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "host=db.example\nuser=backup");
    // libpq percent-decoding preserves a literal '+' (only %20 is a space).
    result = convert({ CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql://user:a+b@db.example:5432/chordv?application_name=backup+job" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^password=a\+b$/m, "literal + in credentials must survive");
    assert.match(result.stdout, /^application_name=backup\+job$/m, "literal + in options must survive");
    // ?service=name selects a libpq service section as the BASE configuration
    // instead of being written into the generated section (libpq rejects
    // nesting); the URL's own fields override the section.
    const operatorService = path.join(root, "operator-pg_service.conf");
    writeFileSync(operatorService, "# operator services\n[production]\nhost = prod.example\nport = 6543\ndbname = proddb\nsslmode = require\n[other]\nhost = other.example\n");
    result = convert({
      CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql:///?service=production&user=override&connect_timeout=9",
      PGSERVICEFILE: operatorService
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "host=prod.example\nport=6543\ndbname=proddb\nsslmode=require\nuser=override\nconnect_timeout=9");
    assert.doesNotMatch(result.stdout, /service=/, "service must not be nested inside the generated section");
    // An explicit ?servicefile= parameter points at the service file directly.
    result = convert({
      CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql:///?service=other&servicefile=" + operatorService,
      PGSERVICEFILE: path.join(root, "does-not-exist.conf")
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "host=other.example");
    // A missing service section or file fails closed.
    result = convert({ CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql:///?service=absent", PGSERVICEFILE: operatorService });
    assert.notEqual(result.status, 0, "missing service section must fail");
    result = convert({ DATABASE_URL: "postgresql://secret:password@host/db?%XX=bad" });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
    // Valid libpq options must not be gated by an allowlist — libpq itself
    // rejects invalid keywords when the dump connects.
    result = convert({ CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql://user:pw@host/db?target_session_attrs=read-write&keepalives_idle=30&client_encoding=UTF8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /target_session_attrs=read-write/);
    assert.match(result.stdout, /keepalives_idle=30/);
    assert.match(result.stdout, /client_encoding=UTF8/);
    // URL query parameters override the authority components (libpq URI semantics).
    result = convert({ CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql://user:pw@host:5432/db?host=override.example&port=6543" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^host=override\.example$/m);
    assert.match(result.stdout, /^port=6543$/m);
    // IPv6 authority hosts keep their URI brackets stripped for libpq.
    result = convert({ CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "postgresql://user:pw@[2001:db8::1]:5432/chordv" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^host=2001:db8::1$/m);
    assert.doesNotMatch(result.stdout, /\[/);
    // Exercise the real snapshot pipeline too: pg_dump's argv names ONLY the
    // service (never credentials — they live in a 0600 service file on
    // ephemeral storage, removed as soon as the dump ends), and errors
    // echoing argv never disclose credentials.
    writeFileSync(path.join(root, "timeout"), '#!/usr/bin/env bash\nshift 3\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(path.join(root, "pg_dump"), `#!/usr/bin/env bash
printf '%s' "$*" > "$CHORDV_TEST_CAPTURE"
printf '%s' "$#" > "$CHORDV_TEST_ARGC"
cp "$PGSERVICEFILE" "$CHORDV_TEST_SERVICE"
printf '%s' "$*" >&2
[ "$CHORDV_TEST_DUMP_FAIL" = "true" ] && exit 1
printf 'test snapshot\\n'
`, { mode: 0o755 });
    const credDir = path.join(root, "cred");
    mkdirSync(credDir, { recursive: true });
    for (const fail of [false, true]) {
      const capture = path.join(root, "capture");
      const argc = path.join(root, "argc");
      const service = path.join(root, "service");
      const dump = spawnSync("bash", ["-c", `${definitions}\nrun_snapshot 0.0.2 op-${fail}`], {
        encoding: "utf8", env: { ...env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
          CHORDV_SYSTEM_UPDATE_SNAPSHOT: "true", CHORDV_SYSTEM_UPDATE_BACKUP_DIR: path.join(root, "backups"),
          CHORDV_SYSTEM_UPDATE_SNAPSHOT_CRED_DIR: credDir,
          CHORDV_TEST_CAPTURE: capture, CHORDV_TEST_ARGC: argc, CHORDV_TEST_SERVICE: service,
          CHORDV_TEST_DUMP_FAIL: String(fail) }
      });
      assert.equal(dump.status, fail ? 1 : 0, dump.stderr);
      assert.equal(readFileSync(capture, "utf8"), "service=chordv-snapshot", "pg_dump argv must name only the service");
      assert.equal(readFileSync(argc, "utf8"), "1", "the service name must be pg_dump's single command-line argument");
      assert.equal(readFileSync(service, "utf8"), `[chordv-snapshot]\n${expectedBody}\n`, "credentials must travel in the 0600 service file");
      assert.equal(dump.stderr.includes("p:ss/%?#"), false, "pg_dump errors must not disclose credentials");
      const leftover = readdirSync(credDir).filter((name) => name.startsWith(".chordv-pgservice"));
      assert.equal(leftover.length, 0, "the service file must be removed when the dump ends (success or failure)");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function testStabilizationConfig() {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-stabilization-config-"));
  const state = path.join(root, "state");
  mkdirSync(state);
  const marker = path.join(state, "promoting.json");
  const journal = JSON.stringify({ version: "0.0.2", operationId: "sysop-stability", kind: "update", migrationApplied: true });
  writeFileSync(marker, journal);
  const env = { ...process.env, CHORDV_SYSTEM_STATE_DIR: state,
    CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"),
    CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
    CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public"), CHORDV_SYSTEM_NODE_BIN: process.execPath };
  try {
    for (const duration of ["abc", "0", "-1", "1.5", "01", " 10", "86401", "999999999999999999999"]) {
      const result = spawnSync("bash", [entrypoint], { encoding: "utf8", env: {
        ...env, CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: duration
      } });
      assert.equal(result.status, 1, duration);
      assert.match(result.stderr, /stabilization duration must be an integer/);
      assert.equal(readFileSync(marker, "utf8"), journal);
      assert.equal(existsSync(path.join(root, "releases")), false, "invalid config must stop before any release/state transition");
      assert.equal(existsSync(path.join(root, "current")), false);
    }
    const source = readFileSync(entrypoint, "utf8");
    const definitions = source.slice(0, source.indexOf('\nAPP_PID=""'));
    for (const duration of ["1", "10", "86400"]) {
      const result = spawnSync("bash", ["-c", `${definitions}\nvalidate_stabilization`], {
        encoding: "utf8", env: { ...env, CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: duration }
      });
      assert.equal(result.status, 0, result.stderr);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function testHealthElapsedDeadline() {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    // Accept TCP but never send HTTP headers: curl must consume the time budget.
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const source = readFileSync(entrypoint, "utf8");
  const definitions = source.slice(0, source.indexOf('\nAPP_PID=""'));
  const started = Date.now();
  const child = spawn("bash", ["-c", `${definitions}\nwait_healthy "$$"`], {
    env: { ...process.env, CHORDV_API_PORT: String(address.port), CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "2" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const code = await new Promise<number | null>(resolve => child.once("exit", resolve));
    const elapsed = Date.now() - started;
    assert.equal(code, 1, stderr);
    assert.match(stderr, /health gate timed out after 2s/);
    assert.ok(elapsed < 4500, `health deadline multiplied by probe latency: ${elapsed}ms`);
  } finally {
    child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
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
  await runFinalizationRetryScenario("remove");
  await runFinalizationRetryScenario("remove", true);
  await runFinalizationRetryScenario("public");
  await runFinalizationRetryScenario("public", false, true);

  const automatic = await runRollbackScenario("good", false, true);
  assert.equal(automatic.result?.status, "rolledback", automatic.stderr);
  assert.equal(automatic.result.migrationApplied, true);
  assert.equal(automatic.served, true, "fallback must pass readiness despite P3009");
  const unhealthy = await runRollbackScenario("bad", false, true);
  assert.equal(unhealthy.result?.status, "failed", "skipping migrate must not bypass fallback readiness");
  const manual = await runManualRollbackScenario(true);
  assert.equal(manual.result?.status, "success", manual.stderr);
  assert.equal(manual.result.version, "0.0.1");
  assert.equal(manual.stderr.includes("P3009"), false, "manual rollback must skip migrate deploy");
  const hung = await runRollbackScenario("good", false, false, true);
  assert.equal(hung.result?.status, "rolledback", hung.stderr);
  assert.equal(hung.served, true, "unresponsive candidate must not block healthy fallback");
  assert.match(hung.stderr, /failed candidate did not stop within 1s/);
  await runTerminalFailureRetryScenario(false);
  await runTerminalFailureRetryScenario(true);
  for (const lastGood of ["missing", "same", "unusable"] as const) await runBlockedSnapshotRecoveryScenario(lastGood);
  await testInvalidJournals();
  await testInvalidPendingAfterAppExit();
  testJournalFieldExtraction();
  testSnapshotDatabaseUrl();
  testStabilizationConfig();
  await testHealthElapsedDeadline();
}

void main().then(() => {
  console.log("system-update-supervisor.regression.ts passed");
});
