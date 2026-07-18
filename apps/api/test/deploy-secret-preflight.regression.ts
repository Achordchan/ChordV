import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd(), "../..");
const installerPath = path.join(repoRoot, "scripts/install-panel-password-key.py");
const pythonCommand = process.platform === "win32" ? "python" : "python3";

function runInstaller(deployPath: string, key: string) {
  return spawnSync(pythonCommand, [installerPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DEPLOY_PATH: deployPath,
      CHORDV_PANEL_PASSWORD_MASTER_KEY: key
    }
  });
}

const firstDeployPath = mkdtempSync(path.join(tmpdir(), "chordv-deploy-key-"));
try {
  const envPath = path.join(firstDeployPath, ".env");
  const firstKey = "a".repeat(64);
  const replacementKey = "b".repeat(64);
  writeFileSync(
    envPath,
    'DATABASE_URL="postgresql://example"\nCHORDV_SECRET_ENCRYPTION_KEY=""\n',
    "utf8"
  );

  const initialInstall = runInstaller(firstDeployPath, firstKey);
  assert.equal(initialInstall.status, 0, initialInstall.stderr || initialInstall.stdout);
  const installedEnv = readFileSync(envPath, "utf8");
  assert.match(installedEnv, new RegExp(`^CHORDV_PANEL_PASSWORD_MASTER_KEY=${firstKey}$`, "m"));
  assert.doesNotMatch(installedEnv, /^CHORDV_SECRET_ENCRYPTION_KEY=/m);

  const preserveExisting = runInstaller(firstDeployPath, replacementKey);
  assert.equal(preserveExisting.status, 0, preserveExisting.stderr || preserveExisting.stdout);
  assert.match(preserveExisting.stdout, /preserving it/);
  assert.equal(readFileSync(envPath, "utf8"), installedEnv);
} finally {
  rmSync(firstDeployPath, { recursive: true, force: true });
}

const invalidDeployPath = mkdtempSync(path.join(tmpdir(), "chordv-invalid-deploy-key-"));
try {
  const envPath = path.join(invalidDeployPath, ".env");
  writeFileSync(envPath, "CHORDV_PANEL_PASSWORD_MASTER_KEY=invalid\n", "utf8");
  const invalidExisting = runInstaller(invalidDeployPath, "c".repeat(64));
  assert.notEqual(invalidExisting.status, 0);
  assert.match(invalidExisting.stderr, /Invalid panel password master key/);
  assert.equal(readFileSync(envPath, "utf8"), "CHORDV_PANEL_PASSWORD_MASTER_KEY=invalid\n");
} finally {
  rmSync(invalidDeployPath, { recursive: true, force: true });
}

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/deploy-baota.yml"), "utf8");
assert.match(
  workflow,
  /CHORDV_PANEL_PASSWORD_MASTER_KEY:\s*\$\{\{ secrets\.CHORDV_PANEL_PASSWORD_MASTER_KEY \}\}/
);

const deployScript = readFileSync(path.join(repoRoot, "scripts/deploy-baota.sh"), "utf8");
const preflightCall = deployScript.search(/\r?\nconfigure_remote_panel_password_master_key\r?\n/);
const buildStart = deployScript.search(/\r?\npnpm --filter @chordv\/shared build/);
assert.ok(preflightCall >= 0, "deployment secret preflight call is missing");
assert.ok(buildStart > preflightCall, "deployment secret preflight must run before builds and file sync");
assert.match(deployScript, /cat scripts\/install-panel-password-key\.py/);
assert.match(deployScript, /export CHORDV_PANEL_PASSWORD_MASTER_KEY DEPLOY_PATH; python3 -/);
assert.doesNotMatch(deployScript, /ensure_panel_password_master_key/);

console.log("deploy secret preflight regression tests passed");
