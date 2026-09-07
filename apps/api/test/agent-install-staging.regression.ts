import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderInstallScript, renderXrayInstall } from "../src/modules/agent/agent-install.controller";

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
url=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then output="$2"; shift 2;
  else [[ "$1" == http* ]] && url="$1"; shift; fi
done
# The Xray section fetches the artifact and its digest from the same origin, so
# the stub has to answer both.
if [[ "$url" == *.sha256 ]]; then cp "\${TEST_SHA:-/dev/null}" "$output"; exit 0; fi
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

  // The Xray section runs as root on a fresh host: verify what it actually
  // creates, not just what the rendered text says.
  writeFileSync(path.join(root, "xray.sh"), `#!/bin/bash
set -euo pipefail
API_BASE='https://example.com/api'
ARCH=linux-x64
SERVICE_USER=chordv-agent
NODE_BIN=/usr/local/bin/node
STAGING_DIR="$(mktemp -d)"
ARCHIVE=/tmp/agent.tgz
CURRENT_LINK=/opt/chordv-node-agent/current
${renderXrayInstall()}
`);
  const xrayInstall = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "bash", "-v", `${root}:/test:ro`, "chordv-api:latest", "-ec", `
mkdir -p /test-bin /release/deploy /release/dist/src
cp /test/curl /test-bin/curl
export PATH=/test-bin:$PATH
id chordv-agent >/dev/null 2>&1 || useradd --system chordv-agent
printf '{"log":{}}' > /release/deploy/xray-base.json
printf '{"api":{}}' > /release/deploy/xray-api.fragment.json
printf 'console.log("helper");' > /release/dist/src/xray-apply.js
# The section installs root-executed files from the ARCHIVE root downloaded,
# never through the release tree the service user extracts.
tar -czf /tmp/agent.tgz -C /release ./deploy/xray-base.json ./deploy/xray-api.fragment.json ./dist/src/xray-apply.js
mkdir -p /opt/chordv-node-agent && ln -sfn /release /opt/chordv-node-agent/current
mkdir -p /payload && printf '#!/bin/sh\necho stub-xray\n' > /payload/xray && chmod 0755 /payload/xray
tar -czf /tmp/xray.tgz -C /payload xray
sha256sum /tmp/xray.tgz | cut -d' ' -f1 > /tmp/xray.sha256

# An Xray unit this installer did not write must not be replaced: doing so
# would point an operator's own service at a config directory with no
# user-facing inbound and restart it.
mkdir -p /etc/systemd/system
printf '[Unit]\\nDescription=Someone else Xray\\n' > /etc/systemd/system/xray.service
TEST_PAYLOAD=/tmp/xray.tgz TEST_SHA=/tmp/xray.sha256 bash /test/xray.sh 2>/tmp/takeover.err && exit 96
grep -q '不是由本安装脚本管理的 Xray 服务' /tmp/takeover.err
grep -q 'Someone else Xray' /etc/systemd/system/xray.service
[[ ! -e /usr/local/bin/xray ]]
rm -f /etc/systemd/system/xray.service

# A vendor unit lives under /usr/lib; writing ours into /etc would override it
# without ever touching the file the guard used to check.
mkdir -p /usr/lib/systemd/system
printf '[Unit]\\nDescription=Vendor Xray\\n' > /usr/lib/systemd/system/xray.service
TEST_PAYLOAD=/tmp/xray.tgz TEST_SHA=/tmp/xray.sha256 bash /test/xray.sh 2>/tmp/vendor.err && exit 95
grep -q '/usr/lib/systemd/system/xray.service' /tmp/vendor.err
[[ ! -e /etc/systemd/system/xray.service ]]
rm -f /usr/lib/systemd/system/xray.service

# A drop-in is someone's deliberate customization of that service too.
mkdir -p /etc/systemd/system/xray.service.d
TEST_PAYLOAD=/tmp/xray.tgz TEST_SHA=/tmp/xray.sha256 bash /test/xray.sh 2>/tmp/dropin.err && exit 94
grep -q 'xray.service.d' /tmp/dropin.err
rmdir /etc/systemd/system/xray.service.d

# A digest that does not match must abort before anything is installed.
TEST_PAYLOAD=/tmp/xray.tgz TEST_SHA=/dev/null bash /test/xray.sh 2>/tmp/xray.err && exit 99
# Fail for the RIGHT reason: the digest check, not a missing tool upstream of it.
grep -qi 'sha256sum' /tmp/xray.err
[[ ! -e /usr/local/bin/xray ]]
[[ ! -e /etc/chordv/xray/conf.d/00-base.json ]]

TEST_PAYLOAD=/tmp/xray.tgz TEST_SHA=/tmp/xray.sha256 bash /test/xray.sh
[[ "$(stat -c '%U:%G:%a' /etc/chordv/xray/conf.d/00-base.json)" == root:root:644 ]]
[[ "$(stat -c '%U:%G:%a' /etc/chordv/xray/conf.d/10-api.json)" == root:root:644 ]]
[[ ! -e /etc/chordv/xray/conf.d/50-inbound.json ]]
[[ "$(stat -c '%U:%G:%a' /usr/local/lib/chordv/xray-apply.js)" == root:root:755 ]]
[[ "$(stat -c '%U:%a' /var/lib/chordv-node-agent/xray)" == chordv-agent:700 ]]
# Root's results must land outside anything the agent can write or replace.
[[ "$(stat -c '%U:%G:%a' /var/lib/chordv-xray)" == root:root:755 ]]
[[ "$(stat -c '%a' /usr/local/bin/xray)" == 755 ]]
grep -q 'ReadOnlyPaths=/etc/chordv/xray' /etc/systemd/system/xray.service
grep -q 'PathChanged=/var/lib/chordv-node-agent/xray/pending.json' /etc/systemd/system/chordv-xray-apply.path
grep -q '/usr/local/lib/chordv/xray-apply.js' /etc/systemd/system/chordv-xray-apply.service
grep -q 'chordv-managed: xray' /etc/systemd/system/xray.service
# What root runs must come from the archive, not from the release tree: replace
# the release copy with a marker and confirm it never reaches the helper path.
printf 'ATTACKER' > /release/dist/src/xray-apply.js
TEST_PAYLOAD=/tmp/xray.tgz TEST_SHA=/tmp/xray.sha256 bash /test/xray.sh
! grep -q ATTACKER /usr/local/lib/chordv/xray-apply.js
# Re-running the installer over its OWN unit is a normal upgrade — but it must
# not overwrite a metering fragment the operator has tuned.
printf '{"api":{"tag":"api"},"operator":true}' > /etc/chordv/xray/conf.d/10-api.json
TEST_PAYLOAD=/tmp/xray.tgz TEST_SHA=/tmp/xray.sha256 bash /test/xray.sh 2>/tmp/upgrade.err
grep -q operator /etc/chordv/xray/conf.d/10-api.json
grep -q '保留了本机已有' /tmp/upgrade.err
`], { encoding: "utf8" });
  assert.equal(xrayInstall.status, 0, `xray install: ${xrayInstall.stdout}\n${xrayInstall.stderr}`);
  console.log("agent install staging passed (interrupted/corrupt/incomplete preserved, two atomic switches retained old releases, legacy env identity refused before download, health check rejects non-root/writable env file and drops to the state database owner, xray install verifies its digest, refuses to take over a foreign xray unit, keeps config root-owned)");
} finally { rmSync(root, { recursive: true, force: true }); }
