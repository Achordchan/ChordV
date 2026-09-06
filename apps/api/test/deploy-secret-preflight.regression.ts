import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd(), "../..");
const installerPath = path.join(repoRoot, "scripts/install-panel-password-key.py");
const agentPepperInstallerPath = path.join(repoRoot, "scripts/install-agent-token-pepper.py");
const pythonCommand = process.platform === "win32" ? "python" : "python3";

function runInstaller(deployPath: string) {
  return spawnSync(pythonCommand, [installerPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DEPLOY_PATH: deployPath }
  });
}

function runAgentPepperInstaller(deployPath: string) {
  return spawnSync(pythonCommand, [agentPepperInstallerPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DEPLOY_PATH: deployPath }
  });
}

const firstDeployPath = mkdtempSync(path.join(tmpdir(), "chordv-deploy-key-"));
try {
  const envPath = path.join(firstDeployPath, ".env");
  writeFileSync(
    envPath,
    'DATABASE_URL="postgresql://example"\nCHORDV_SECRET_ENCRYPTION_KEY=""\n',
    "utf8"
  );

  const initialInstall = runInstaller(firstDeployPath);
  assert.equal(initialInstall.status, 0, initialInstall.stderr || initialInstall.stdout);
  const installedEnv = readFileSync(envPath, "utf8");
  const installedKey = installedEnv.match(/^CHORDV_PANEL_PASSWORD_MASTER_KEY=([0-9a-f]{64})$/m)?.[1];
  assert.ok(installedKey, "installer did not write a 32-byte hexadecimal key");
  assert.doesNotMatch(installedEnv, /^CHORDV_SECRET_ENCRYPTION_KEY=/m);

  const preserveExisting = runInstaller(firstDeployPath);
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
  const invalidExisting = runInstaller(invalidDeployPath);
  assert.notEqual(invalidExisting.status, 0);
  assert.match(invalidExisting.stderr, /Invalid panel password master key/);
  assert.equal(readFileSync(envPath, "utf8"), "CHORDV_PANEL_PASSWORD_MASTER_KEY=invalid\n");
} finally {
  rmSync(invalidDeployPath, { recursive: true, force: true });
}

const agentPepperDeployPath = mkdtempSync(path.join(tmpdir(), "chordv-agent-pepper-"));
try {
  const startScriptPath = path.join(agentPepperDeployPath, "start.sh");
  writeFileSync(startScriptPath, "#!/usr/bin/env bash\nexport CHORDV_JWT_SECRET=existing\nnode api.js\n", "utf8");

  const initialInstall = runAgentPepperInstaller(agentPepperDeployPath);
  assert.equal(initialInstall.status, 0, initialInstall.stderr || initialInstall.stdout);
  const installedScript = readFileSync(startScriptPath, "utf8");
  const installedPepper = installedScript.match(/^export CHORDV_AGENT_TOKEN_PEPPER=([0-9a-f]{64})$/m)?.[1];
  assert.ok(installedPepper, "Agent pepper installer did not write a 32-byte hexadecimal value");

  const preserveExisting = runAgentPepperInstaller(agentPepperDeployPath);
  assert.equal(preserveExisting.status, 0, preserveExisting.stderr || preserveExisting.stdout);
  assert.match(preserveExisting.stdout, /preserving it/);
  assert.equal(readFileSync(startScriptPath, "utf8"), installedScript);
} finally {
  rmSync(agentPepperDeployPath, { recursive: true, force: true });
}

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/deploy-baota.yml"), "utf8");
assert.doesNotMatch(workflow, /secrets\.CHORDV_PANEL_PASSWORD_MASTER_KEY/);

const deployScript = readFileSync(path.join(repoRoot, "scripts/deploy-baota.sh"), "utf8");
const preflightCall = deployScript.search(/\r?\nconfigure_remote_panel_password_master_key\r?\n/);
const agentPepperPreflightCall = deployScript.search(/\r?\nconfigure_remote_agent_token_pepper\r?\n/);
const buildStart = deployScript.search(/\r?\npnpm --filter @chordv\/shared build/);
assert.ok(preflightCall >= 0, "deployment secret preflight call is missing");
assert.ok(agentPepperPreflightCall > preflightCall, "Agent token pepper preflight must run after panel key preflight");
assert.ok(buildStart > preflightCall, "deployment secret preflight must run before builds and file sync");
assert.ok(buildStart > agentPepperPreflightCall, "Agent token pepper preflight must run before builds and file sync");
assert.match(deployScript, /cat scripts\/install-panel-password-key\.py/);
assert.match(deployScript, /cat scripts\/install-agent-token-pepper\.py/);
assert.match(deployScript, /scripts\/prisma-migrate-with-baseline\.mjs/);
assert.match(deployScript, /export DEPLOY_PATH; python3 -/);
assert.doesNotMatch(deployScript, /ensure_panel_password_master_key/);
assert.doesNotMatch(deployScript, /export PATH="\/usr\/local\/bin/);
assert.doesNotMatch(deployScript, /CHORDV_PANEL_PASSWORD_MASTER_KEY=.*secrets/);

console.log("deploy secret preflight regression tests passed");
