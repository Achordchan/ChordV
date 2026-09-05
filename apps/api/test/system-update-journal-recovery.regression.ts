import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entrypoint = path.resolve(__dirname, "../../../deploy/1panel/chordv/entrypoint.sh");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, logs: () => string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, logs());
    await sleep(50);
  }
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-journal-recovery-"));
  const state = path.join(root, "state"), bin = path.join(root, "bin");
  mkdirSync(state); mkdirSync(bin);
  const fault = path.join(root, "fault"), launches = path.join(root, "launches");
  // Intercept only atomic state renames; all other shell behavior is real.
  writeFileSync(path.join(bin, "mv"), `#!/usr/bin/env bash
for target in "$@"; do
  if [[ -f "$CHORDV_TEST_FAULT" && "$(cat "$CHORDV_TEST_FAULT")" != sync && ( ( "$target" == */promoting.json && "$(cat "$CHORDV_TEST_FAULT")" != result ) || "$target" == */operation-result.*.json ) ]]; then
    echo "injected state write failure" >&2; exit 1
  fi
done
exec /bin/mv "$@"
`, { mode: 0o755 });
  writeFileSync(path.join(bin, "sync"), `#!/usr/bin/env bash
if [[ -f "$CHORDV_TEST_FAULT" && "$(cat "$CHORDV_TEST_FAULT")" == sync ]]; then exit 1; fi
exec /bin/sync
`, { mode: 0o755 });
  // No HTTP socket needed: these tests cover journal handoff before health gating.
  writeFileSync(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  function release(version: string) {
    const dir = path.join(root, "releases", version);
    mkdirSync(path.join(dir, "apps/api/dist/apps/api/src"), { recursive: true });
    mkdirSync(path.join(dir, "apps/admin/dist"), { recursive: true });
    writeFileSync(path.join(dir, "apps/admin/dist/index.html"), "test bundle");
    writeFileSync(path.join(dir, "apps/api/dist/apps/api/src/main.js"), `const fs=require('fs');
fs.appendFileSync(${JSON.stringify(launches)},${JSON.stringify(version + "\n")});
setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(root, "exit-app"))})){fs.unlinkSync(${JSON.stringify(path.join(root, "exit-app"))});process.exit(0)}},20);`);
  }
  const children: ChildProcess[] = [];
  function start() {
    const child = spawn("bash", [entrypoint], { detached: true, stdio: ["ignore", "ignore", "pipe"], env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CHORDV_TEST_FAULT: fault,
      CHORDV_SYSTEM_NODE_BIN: process.execPath,
      CHORDV_SYSTEM_RELEASES_DIR: path.join(root, "releases"), CHORDV_SYSTEM_STATE_DIR: state,
      CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public"), CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
      CHORDV_SYSTEM_SEED_DIR: path.join(root, "seed"), CHORDV_SUPERVISOR_MIGRATE: "false",
      CHORDV_SYSTEM_UPDATE_SNAPSHOT: "false", CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1"
    } });
    children.push(child);
    let log = "";
    child.stderr!.on("data", chunk => { log += chunk; });
    return { child, logs: () => log };
  }
  async function stop(child: ChildProcess) {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* process already stopped */ }
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
  }
  return { root, state, fault, launches, release, start, stop, async cleanup() {
    for (const child of children) await stop(child);
    rmSync(root, { recursive: true, force: true });
  } };
}

async function pendingRetry(afterExit: boolean) {
  const f = fixture();
  try {
    f.release("0.0.1"); f.release("0.0.2");
    writeFileSync(path.join(f.state, "desired-version"), "0.0.1");
    const marker = path.join(f.state, "pending.json");
    const bytes = JSON.stringify({ version: "0.0.2", operationId: "sysop-handoff", kind: "update", migrationApplied: false });
    let run = f.start();
    if (afterExit) {
      await until(() => run.logs().includes("healthy + stable"), run.logs);
    } else {
      await f.stop(run.child);
    }
    writeFileSync(f.fault, "block promoting and result persistence");
    writeFileSync(marker, bytes);
    if (afterExit) writeFileSync(path.join(f.root, "exit-app"), "exit");
    else run = f.start();
    await until(() => run.logs().includes("retaining pending journal"), run.logs);
    assert.equal(readFileSync(marker, "utf8"), bytes);
    assert.equal(existsSync(path.join(f.state, "operation-result.sysop-handoff.json")), false);
    const before = existsSync(f.launches) ? readFileSync(f.launches, "utf8") : "";
    assert.ok(!before.includes("0.0.2"), "cannot launch candidate before durable handoff");
    await f.stop(run.child);
    run = f.start();
    await until(() => run.logs().includes("retaining pending journal"), run.logs);
    assert.equal(readFileSync(marker, "utf8"), bytes, "host restart retains sole recovery journal");
    assert.equal(existsSync(f.launches) ? readFileSync(f.launches, "utf8") : "", before);
    rmSync(f.fault);
    const result = path.join(f.state, "operation-result.sysop-handoff.json");
    await until(() => existsSync(result), run.logs);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).status, "success");
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(f.launches, "utf8").split("\n").filter(x => x === "0.0.2").length, 1);
  } finally { await f.cleanup(); }
}

async function missingRelease(migrated: boolean, rollback: boolean) {
  const f = fixture();
  try {
    f.release("0.0.1");
    writeFileSync(path.join(f.state, "desired-version"), "0.0.1");
    const marker = path.join(f.state, "promoting.json");
    writeFileSync(marker, JSON.stringify({ version: "0.0.2", operationId: "sysop-missing",
      kind: rollback ? "rollback" : "update", migrationApplied: migrated,
      ...(rollback ? { rollbackFrom: "0.0.3" } : {}) }));
    writeFileSync(f.fault, migrated ? "result" : "state unavailable");
    let run = f.start();
    await until(() => run.logs().includes(migrated ? "could not persist failure result" : "cannot persist terminal failure decision"), run.logs);
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).migrationApplied, migrated);
    await f.stop(run.child);
    rmSync(f.fault);
    run = f.start();
    await until(() => run.child.exitCode !== null, run.logs);
    const result = path.join(f.state, "operation-result.sysop-missing.json");
    const outcome = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.version, rollback ? "0.0.3" : "0.0.2");
    assert.equal(outcome.migrationApplied, migrated);
    assert.equal(existsSync(f.launches), false, "do not silently launch old code against potentially changed schema");
    assert.ok(existsSync(marker), "retain terminal recovery interlock");
    // A later restored directory must not turn the terminal failure into success.
    f.release("0.0.2");
    const retry = f.start();
    await until(() => retry.child.exitCode !== null, retry.logs);
    assert.equal(readFileSync(result, "utf8"), JSON.stringify(outcome) + "\n");
    assert.equal(existsSync(f.launches), false);
  } finally { await f.cleanup(); }
}

async function interruptedHandoff(conflict: boolean) {
  const f = fixture();
  try {
    f.release("0.0.2");
    const journal = { version: "0.0.2", operationId: "sysop-transfer", kind: "update", migrationApplied: false };
    writeFileSync(path.join(f.state, "promoting.json"), JSON.stringify(journal));
    const pending = path.join(f.state, "pending.json");
    writeFileSync(pending, JSON.stringify({ ...journal, operationId: conflict ? "sysop-other" : journal.operationId }));
    const run = f.start();
    if (conflict) {
      await until(() => run.child.exitCode !== null, run.logs);
      assert.match(run.logs(), /conflicting pending\/promoting/);
      assert.equal(existsSync(f.launches), false);
      assert.equal(existsSync(pending), true);
      assert.equal(existsSync(path.join(f.state, "promoting.json")), true);
    } else {
      await until(() => run.logs().includes("healthy + stable"), run.logs);
      assert.equal(existsSync(pending), false);
      const outcome = path.join(f.state, "operation-result.sysop-transfer.json");
      const bytes = readFileSync(outcome, "utf8");
      writeFileSync(path.join(f.root, "exit-app"), "exit");
      await until(() => run.logs().includes("no pending marker; restarting"), run.logs);
      assert.equal(readFileSync(outcome, "utf8"), bytes, "ordinary restart must not replay finalized operation");
    }
  } finally { await f.cleanup(); }
}

async function restartKeepsVersion() {
  const f = fixture();
  try {
    f.release("0.0.1"); f.release("0.0.2");
    writeFileSync(path.join(f.root, "releases/0.0.2/apps/api/dist/apps/api/src/main.js"), "process.exit(1);");
    writeFileSync(path.join(f.state, "last-good-version"), "0.0.2");
    writeFileSync(path.join(f.state, "last-good-version.previous"), "0.0.1");
    writeFileSync(path.join(f.state, "desired-version"), "0.0.2");
    writeFileSync(path.join(f.state, "pending.json"), JSON.stringify({ version: "0.0.2", operationId: "sysop-restart", kind: "restart", migrationApplied: false }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = f.start();
      await until(() => run.child.exitCode !== null, run.logs);
      const result = JSON.parse(readFileSync(path.join(f.state, "operation-result.sysop-restart.json"), "utf8"));
      assert.equal(result.status, "failed"); assert.equal(result.version, "0.0.2");
      assert.match(result.reason, /重启失败，未切换版本/);
      assert.equal(readFileSync(path.join(f.state, "desired-version"), "utf8"), "0.0.2");
      assert.equal(existsSync(f.launches), false, "restart failure must not launch the healthy predecessor");
      assert.ok(existsSync(path.join(f.state, "promoting.json")), "retain restart recovery interlock");
    }
  } finally { await f.cleanup(); }
}

async function journalSyncFailure() {
  const f = fixture();
  try {
    f.release("0.0.1"); f.release("0.0.2");
    const pending = path.join(f.state, "pending.json");
    const bytes = JSON.stringify({ version: "0.0.2", operationId: "sysop-sync", kind: "update", migrationApplied: false });
    writeFileSync(pending, bytes); writeFileSync(f.fault, "sync");
    let run = f.start();
    await until(() => run.logs().includes("retaining pending journal"), run.logs);
    assert.equal(readFileSync(pending, "utf8"), bytes);
    assert.ok(existsSync(path.join(f.state, "promoting.json")), "rename can be visible before failed sync");
    assert.equal(existsSync(f.launches), false);
    await f.stop(run.child);
    run = f.start();
    await until(() => run.child.exitCode !== null, run.logs);
    assert.match(run.logs(), /cannot synchronize resumed promotion journal/);
    assert.equal(readFileSync(pending, "utf8"), bytes);
    assert.equal(existsSync(f.launches), false);
    rmSync(f.fault);
    run = f.start();
    await until(() => existsSync(path.join(f.state, "operation-result.sysop-sync.json")), run.logs);
    assert.equal(JSON.parse(readFileSync(path.join(f.state, "operation-result.sysop-sync.json"), "utf8")).status, "success");
    assert.equal(existsSync(pending), false);
  } finally { await f.cleanup(); }
}

async function main() {
  await pendingRetry(false);
  await pendingRetry(true);
  for (const migrated of [false, true]) for (const rollback of [false, true]) await missingRelease(migrated, rollback);
  await interruptedHandoff(false);
  await interruptedHandoff(true);
  await restartKeepsVersion();
  await journalSyncFailure();
  console.log("system-update-journal-recovery.regression.ts passed (10 recovery scenarios)");
}
void main();
