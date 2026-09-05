import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync, rmSync, utimesSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
const root = mkdtempSync(path.join(tmpdir(), "chordv-snapshot-security-"));
const script = readFileSync(path.resolve(__dirname, "../../../deploy/1panel/chordv/entrypoint.sh"), "utf8");
const definitions = script.slice(0, script.indexOf('\nAPP_PID=""'));
const backup = path.join(root, "backups"), calls = path.join(root, "calls");
mkdirSync(backup, { mode: 0o755 });
const mode = (file: string) => statSync(file).mode & 0o777;
writeFileSync(path.join(root, "timeout"), '#!/usr/bin/env bash\nshift 3\nexec "$@"\n', { mode: 0o755 });
writeFileSync(path.join(root, "pg_dump"), `#!/usr/bin/env node
const fs=require('fs'),assert=require('assert/strict'),p=require('path');
const dir=process.env.CHORDV_SYSTEM_UPDATE_BACKUP_DIR;
assert.equal(fs.statSync(dir).mode & 511,448);
const partial=fs.readdirSync(dir).find(n=>n.includes('.partial.'));
assert.ok(partial);assert.equal(fs.statSync(p.join(dir,partial)).mode & 511,384);
fs.appendFileSync(process.env.CHORDV_TEST_CALLS,'dump\\n');process.stdout.write('snapshot fixture\\n');
`, { mode: 0o755 });
function run(op: string, keep = "1", extra: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", `umask 000\n${definitions}\nrun_snapshot 0.0.2 ${op}`], {
    encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`,
      DATABASE_URL: "postgresql://fixture:fixture@unused/db", CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL: "",
      CHORDV_SYSTEM_NODE_BIN: process.execPath, CHORDV_SYSTEM_UPDATE_SNAPSHOT: "true",
      CHORDV_SYSTEM_UPDATE_BACKUP_DIR: backup, CHORDV_TEST_CALLS: calls,
      CHORDV_SYSTEM_UPDATE_SNAPSHOT_KEEP: keep, ...extra }
  });
}
try {
  for (const keep of ["0", "-1", "abc", "1.5", "01", "1000000"]) {
    const invalid = run("invalid", keep);
    assert.notEqual(invalid.status, 0, keep);
    assert.equal(existsSync(calls), false, "invalid retention cannot reach pg_dump");
  }
  let result = run("first");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mode(backup), 0o700);
  const first = path.join(backup, readdirSync(backup)[0]);
  assert.equal(mode(first), 0o600);
  // Upgrade a legacy directory/snapshot on the operation-reuse path as well.
  chmodSync(backup, 0o755); chmodSync(first, 0o644);
  result = run("first");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mode(backup), 0o700); assert.equal(mode(first), 0o600);
  assert.equal(readFileSync(calls, "utf8"), "dump\n", "same operation reuses secured snapshot");
  utimesSync(first, new Date(0), new Date(0));
  result = run("second");
  assert.equal(result.status, 0, result.stderr);
  const kept = readdirSync(backup);
  assert.equal(kept.length, 1); assert.ok(kept[0].includes("-second-"));
  assert.equal(mode(path.join(backup, kept[0])), 0o600);
  const before = readFileSync(calls, "utf8");
  writeFileSync(path.join(root, "chmod"), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  result = run("permission-failed");
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(calls, "utf8"), before, "permission failure cannot dump/migrate");
  assert.deepEqual(readdirSync(backup), kept);
  console.log("system-update-snapshot-security.regression.ts passed");
} finally { rmSync(root, { recursive: true, force: true }); }
