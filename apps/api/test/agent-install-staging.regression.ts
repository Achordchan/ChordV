import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderInstallScript } from "../src/modules/agent/agent-install.controller";

const root = mkdtempSync(path.join(tmpdir(), "agent-install-staging-"));
try {
  const script = renderInstallScript({ token: "test-token", apiBase: "https://example.com" });
  const end = script.indexOf('install -d -m 0750 -o'); assert.ok(end > 0);
  writeFileSync(path.join(root, "stage.sh"), script.slice(0, end));
  writeFileSync(path.join(root, "health-check.sh"), readFileSync(path.resolve(__dirname, "../../node-agent/deploy/health-check.sh")));
  for (const name of ["valid", "next", "incomplete"]) {
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, "dist/src"), { recursive: true }); mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@chordv/node-agent", version: "1.0.0", type: "module" }));
    if (name !== "incomplete") writeFileSync(path.join(dir, "dist/src/main.js"), `console.log('${name}');\n`);
    assert.equal(spawnSync("tar", ["-czf", path.join(root, `${name}.tgz`), "-C", dir, "."]).status, 0);
  }
  writeFileSync(path.join(root, "corrupt.tgz"), "not an archive");
  writeFileSync(path.join(root, "curl"), `#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then output="$2"; shift 2; else shift; fi
done
if [[ "\${TEST_PARTIAL:-false}" == true ]]; then head -c 64 "$TEST_PAYLOAD" > "$output"; exit 18; fi
cp "$TEST_PAYLOAD" "$output"
`, { mode: 0o755 });
  const setup = `
mkdir -p /test-bin /opt/chordv-node-agent/dist/src /opt/chordv-node-agent/releases/old/dist/src
cp /test/curl /test-bin/curl
export PATH=/test-bin:$PATH
printf 'legacy' > /opt/chordv-node-agent/dist/src/main.js
printf 'old' > /opt/chordv-node-agent/releases/old/dist/src/main.js
ln -s /opt/chordv-node-agent/releases/old /opt/chordv-node-agent/current
`;
  for (const [name, payload, partial] of [["interrupted", "valid", true], ["corrupt", "corrupt", false], ["incomplete", "incomplete", false]] as const) {
    const run = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "bash", "-v", `${root}:/test:ro`, "chordv-api:latest", "-ec", setup + `
if TEST_PAYLOAD=/test/${payload}.tgz TEST_PARTIAL=${partial} bash /test/stage.sh; then exit 99; fi
[[ "$(readlink /opt/chordv-node-agent/current)" == /opt/chordv-node-agent/releases/old ]]
[[ "$(cat /opt/chordv-node-agent/current/dist/src/main.js)" == old ]]
[[ "$(cat /opt/chordv-node-agent/dist/src/main.js)" == legacy ]]
[[ -z "$(find /opt/chordv-node-agent/releases -maxdepth 1 -name '.staging.*' -print)" ]]
`], { encoding: "utf8" });
    assert.equal(run.status, 0, `${name}: ${run.stdout}\n${run.stderr}`);
  }
  // A host whose identity lives only in the env file must be refused before the
  // installer touches anything (no download, no release switch).
  const legacyIdentity = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "bash", "-v", `${root}:/test:ro`, "chordv-api:latest", "-ec", setup + `
mkdir -p /etc/chordv
printf 'CHORDV_AGENT_ID=agent-old\\nCHORDV_AGENT_TOKEN=chordv_agent_old\\n' > /etc/chordv/node-agent.env
if TEST_PAYLOAD=/test/valid.tgz bash /test/stage.sh 2>/tmp/guard.err; then exit 99; fi
grep -q "已存在以环境变量配置的 Agent 身份" /tmp/guard.err
[[ "$(readlink /opt/chordv-node-agent/current)" == /opt/chordv-node-agent/releases/old ]]
[[ -z "$(find /opt/chordv-node-agent/releases -maxdepth 1 -name '.staging.*' -print)" ]]
`], { encoding: "utf8" });
  assert.equal(legacyIdentity.status, 0, `legacy env identity: ${legacyIdentity.stdout}\n${legacyIdentity.stderr}`);

  const success = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "bash", "-v", `${root}:/test:ro`, "chordv-api:latest", "-ec", setup + `
TEST_PAYLOAD=/test/valid.tgz bash /test/stage.sh
first="$(readlink /opt/chordv-node-agent/current)"
grep -q valid "$first/dist/src/main.js"
TEST_PAYLOAD=/test/next.tgz bash /test/stage.sh
second="$(readlink /opt/chordv-node-agent/current)"
[[ "$first" != "$second" ]]
grep -q next "$second/dist/src/main.js"
mkdir -p /etc/chordv
printf 'CHORDV_AGENT_NODE_BIN=/usr/local/bin/node\\n' > /etc/chordv/node-agent.env
bash /test/health-check.sh | grep -qx next
# The health check sources this file as shell code and normally runs as root, so
# a non-root owner or a group/other-writable mode must abort instead of loading it.
chown 65534 /etc/chordv/node-agent.env
if bash /test/health-check.sh; then exit 98; fi
chown 0 /etc/chordv/node-agent.env
chmod 0660 /etc/chordv/node-agent.env
if bash /test/health-check.sh; then exit 97; fi
chmod 0640 /etc/chordv/node-agent.env
bash /test/health-check.sh | grep -qx next
# The probe opens the service's sqlite database, and SQLite creates the WAL
# sidecars when they are missing — as root those files would lock the
# unprivileged agent out of its own state. So a root-run health check must
# drop to the database's owner before executing the agent.
mkdir -p /var/lib/chordv-node-agent
: > /var/lib/chordv-node-agent/agent.db
chown -R 65534:65534 /var/lib/chordv-node-agent
printf 'CHORDV_AGENT_NODE_BIN=/usr/local/bin/node\nAGENT_DATABASE_PATH=/var/lib/chordv-node-agent/agent.db\n' > /etc/chordv/node-agent.env
printf 'console.log(process.getuid());\n' > "$second/dist/src/main.js"
[[ "$(bash /test/health-check.sh)" == 65534 ]]
printf 'console.log("next");\n' > "$second/dist/src/main.js"
printf 'CHORDV_AGENT_NODE_BIN=/usr/local/bin/node\n' > /etc/chordv/node-agent.env
rm -rf /var/lib/chordv-node-agent
bash /test/health-check.sh | grep -qx next
grep -q valid "$first/dist/src/main.js"
[[ "$(cat /opt/chordv-node-agent/dist/src/main.js)" == legacy ]]
[[ -z "$(find /opt/chordv-node-agent/releases -maxdepth 1 -name '.staging.*' -print)" ]]
`], { encoding: "utf8" });
  assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
  console.log("agent install staging passed (interrupted/corrupt/incomplete preserved, two atomic switches retained old releases, legacy env identity refused before download, health check rejects non-root/writable env file and drops to the state database owner)");
} finally { rmSync(root, { recursive: true, force: true }); }
