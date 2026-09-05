import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSystemUpdateRuntimeConfig } from "../src/modules/common/system-update.constants";

const root = path.resolve(__dirname, "../../..");
const deploy = "deploy/1panel/chordv";
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const compose = read(`${deploy}/docker-compose.yml`);
const api = compose.match(/^  api:\n([\s\S]*?)(?=^  admin:)/m)?.[1];
const admin = compose.match(/^  admin:\n([\s\S]*)/m)?.[1];
assert.ok(api && admin, "compose API/admin service scopes must be discoverable");
const binds = (service: string) => [...service.matchAll(/^      - (\.\/[^\s:]+):([^\s:]+)(:ro)?$/gm)]
  .map(([, source, target, readOnly]) => ({ source, target, readOnly: Boolean(readOnly) }));
const apiBinds = binds(api);
const adminBinds = binds(admin);
assert.deepEqual(adminBinds, [
  { source: "./api-releases", target: "/usr/share/nginx/releases", readOnly: true },
  { source: "./api-public-state", target: "/usr/share/nginx/public-state", readOnly: true }
], "admin must see only releases and the public marker, never old or new snapshots");
for (const [directory, target, envName] of [
  ["api-state", "/app/state", "CHORDV_SYSTEM_STATE_DIR"],
  ["api-public-state", "/app/public-state", "CHORDV_SYSTEM_PUBLIC_STATE_DIR"],
  ["api-backups", "/app/backups", "CHORDV_SYSTEM_UPDATE_BACKUP_DIR"]
]) {
  assert.ok(apiBinds.some((bind) => bind.source === `./${directory}` && bind.target === target && !bind.readOnly));
  // Literal environment mappings override env_file, including legacy backup paths.
  assert.match(api, new RegExp(`^      ${envName}: ${target}$`, "m"));
  assert.match(read(`${deploy}/Dockerfile.api`), new RegExp(`^ENV ${envName}=${target}$`, "m"));
  assert.ok(read(".gitignore").split("\n").includes(`${deploy}/${directory}/`));
  const ignored = spawnSync("git", ["check-ignore", "--no-index", `${deploy}/${directory}/private-sentinel`], {
    cwd: root, encoding: "utf8"
  });
  assert.equal(ignored.status, 0, `${directory} runtime files must actually be ignored by Git`);
  const tracked = spawnSync("git", ["ls-files", "--", `${deploy}/${directory}/`], { cwd: root, encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout.trim(), "", `${directory} must not already contain tracked private data`);
}
for (const left of apiBinds) for (const right of apiBinds) {
  if (left === right) continue;
  assert.notEqual(left.source, right.source, "private, public and backup bind sources must be distinct");
  assert.ok(!left.source.startsWith(`${right.source}/`), "a shared source cannot contain private mounts");
}
assert.match(admin, /^      CHORDV_ADMIN_STATE_DIR: \/usr\/share\/nginx\/public-state$/m);
assert.match(read(`${deploy}/Dockerfile.admin`), /^ENV CHORDV_ADMIN_STATE_DIR=\/usr\/share\/nginx\/public-state$/m);
assert.match(read(`${deploy}/admin-entrypoint.sh`), /CHORDV_ADMIN_STATE_DIR:-\/usr\/share\/nginx\/public-state/);
assert.doesNotMatch(admin, /^      - .*api-(?:state|backups)(?::|\/)/m);

const supervisor = read(`${deploy}/entrypoint.sh`);
assert.match(supervisor, /^BACKUP_DIR="\$\{CHORDV_SYSTEM_UPDATE_BACKUP_DIR:-\/app\/backups\}"$/m);
assert.match(supervisor, /^PUBLIC_STATE_DIR="\$\{CHORDV_SYSTEM_PUBLIC_STATE_DIR:-\/app\/public-state\}"$/m);
const originalBackup = process.env.CHORDV_SYSTEM_UPDATE_BACKUP_DIR;
try {
  delete process.env.CHORDV_SYSTEM_UPDATE_BACKUP_DIR;
  assert.equal(resolveSystemUpdateRuntimeConfig().backupDir, "/app/backups");
  process.env.CHORDV_SYSTEM_UPDATE_BACKUP_DIR = "   ";
  assert.equal(resolveSystemUpdateRuntimeConfig().backupDir, "/app/backups");
  process.env.CHORDV_SYSTEM_UPDATE_BACKUP_DIR = "/tmp/private-test-backups";
  assert.equal(resolveSystemUpdateRuntimeConfig().backupDir, "/tmp/private-test-backups");
} finally {
  if (originalBackup === undefined) delete process.env.CHORDV_SYSTEM_UPDATE_BACKUP_DIR;
  else process.env.CHORDV_SYSTEM_UPDATE_BACKUP_DIR = originalBackup;
}

// Exercise the real publication helper without starting services or writing /app.
const writeLastGood = supervisor.match(/^write_last_good\(\) \{\n[\s\S]*?^\}/m)?.[0];
assert.ok(writeLastGood);
const temp = mkdtempSync(path.join(tmpdir(), "chordv-deployment-contract-"));
try {
  const state = path.join(temp, "private-state");
  const publicState = path.join(temp, "public-state");
  mkdirSync(path.join(state, "backups"), { recursive: true });
  writeFileSync(path.join(state, "backups", "legacy.sql.gz"), "private snapshot sentinel");
  writeFileSync(path.join(state, "desired-version"), "9.9.9");
  const lastGood = path.join(state, "last-good-version");
  const publish = (privateFile = lastGood) => spawnSync("bash", ["-c", `set -u\n${writeLastGood}\nwrite_last_good 1.2.3`], {
    encoding: "utf8",
    env: { ...process.env, LAST_GOOD_FILE: privateFile, PUBLIC_STATE_DIR: publicState }
  });
  assert.equal(publish().status, 0);
  assert.equal(readFileSync(lastGood, "utf8"), "1.2.3");
  assert.deepEqual(readdirSync(publicState), ["last-good-version"], "only the approved marker is published");
  assert.equal(readFileSync(path.join(publicState, "last-good-version"), "utf8"), "1.2.3");
  assert.equal(readFileSync(path.join(state, "backups", "legacy.sql.gz"), "utf8"), "private snapshot sentinel");
  rmSync(publicState, { recursive: true });
  assert.notEqual(publish(path.join(temp, "missing-parent", "last-good-version")).status, 0);
  assert.equal(existsSync(publicState), false, "private commit failure must not publish a version");
  writeFileSync(publicState, "blocked mountpoint");
  assert.notEqual(publish().status, 0, "public mkdir failure must block finalization");
  rmSync(publicState);
  // mv without a directory guard would silently move the marker inside the target.
  mkdirSync(path.join(publicState, "last-good-version", "nonempty"), { recursive: true });
  const blockedRename = publish();
  assert.notEqual(blockedRename.status, 0, "public marker must not report success for a directory destination");

  // Package actual allowlisted build inputs in an isolated workspace. Runtime sentinel
  // directories and a private .env must not enter the bundle; never inspect live data.
  const fixture = path.join(temp, "package-fixture");
  mkdirSync(fixture);
  const packaging = read("scripts/prepare-1panel-chordv-bundle.mjs");
  const inventory = packaging.match(/const copyTargets = \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(inventory);
  const targets = [...inventory.matchAll(/^  "([^"]+)"/gm)].map((match) => match[1]);
  assert.ok(targets.includes(".env.example") && targets.includes("README.md"));
  for (const target of targets) {
    assert.notEqual(target, deploy, "do not recursively package deployment runtime data");
    assert.ok(!target.endsWith("/.env"));
    mkdirSync(path.dirname(path.join(fixture, target)), { recursive: true });
    cpSync(path.join(root, target), path.join(fixture, target), { recursive: true });
  }
  for (const name of ["api-state", "api-public-state", "api-backups", "postgres-data", "releases"]) {
    mkdirSync(path.join(fixture, deploy, name), { recursive: true });
    writeFileSync(path.join(fixture, deploy, name, "private-sentinel"), "must not ship");
  }
  writeFileSync(path.join(fixture, deploy, ".env"), "PRIVATE_SECRET=must-not-ship\n");
  const packaged = spawnSync(process.execPath, [path.join(root, "scripts/prepare-1panel-chordv-bundle.mjs")], {
    cwd: fixture, encoding: "utf8"
  });
  assert.equal(packaged.status, 0, packaged.stderr);
  const bundle = path.join(fixture, ".deploy/chordv-1panel-bundle");
  assert.equal(readFileSync(path.join(bundle, deploy, "docker-compose.yml"), "utf8"), compose);
  for (const name of [".env", "api-state", "api-public-state", "api-backups", "postgres-data", "releases"]) {
    assert.equal(existsSync(path.join(bundle, deploy, name)), false, `${name} must not ship`);
  }
  assert.equal(readFileSync(path.join(fixture, deploy, ".env"), "utf8"), "PRIVATE_SECRET=must-not-ship\n");
  assert.match(readFileSync(path.join(bundle, "DEPLOY_NOTE.txt"), "utf8"), /api-backups/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log("system-update-deployment.regression.ts passed");
