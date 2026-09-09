import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderInstallScript } from "../src/modules/agent/agent-install.controller";

// Run the real bootstrap in disposable Linux containers. The download fixture
// verifies installation/rollback without changing the host or fetching binaries.
const root = mkdtempSync(path.join(tmpdir(), "chordv-install-runtime-"));
try {
  const script = renderInstallScript({ token: "test-token", apiBase: "https://example.com" });
  const end = script.indexOf('echo "==> 下载'); assert.ok(end > 0);
  writeFileSync(path.join(root, "probe.sh"), script.slice(0, end) + '\nprintf "SELECTED=%s\\n" "$NODE_BIN"\n');
  const setup = `
mkdir -p /root/.nvm /opt/test-node/bin /payload/bin /test-bin
chmod 700 /root/.nvm
printf '#!/bin/sh\\necho v20.19.0\\n' > /root/.nvm/node
printf '#!/bin/sh\\necho v20.19.0\\n' > /opt/test-node/bin/node
printf '#!/bin/sh\\necho v18.0.0\\n' > /usr/bin/node
printf '#!/bin/sh\\necho v20.19.0\\n' > /payload/bin/node
chmod 755 /root/.nvm/node /opt/test-node/bin/node /usr/bin/node /payload/bin/node
tar -czf /payload/node.tar.gz -C /payload ./bin/node
sha256sum /payload/node.tar.gz | cut -d' ' -f1 > /payload/node.sha256
cat > /test-bin/curl <<'SH'
#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then output="$2"; shift 2; else [[ "$1" == https:* ]] && url="$1"; shift; fi
done
case "$url" in
  *.sha256) cp /payload/node.sha256 "$output" ;;
  */agent-download/node/linux-*) cp /payload/node.tar.gz "$output" ;;
  *) exit 2 ;;
esac
SH
chmod 755 /test-bin/curl
export PATH=/test-bin:$PATH
rm -f /usr/local/bin/node
`;
  for (const [name, commands, selected] of [
    ["missing-node", "", "/opt/chordv-node-runtime/v20.19.0/bin/node"],
    ["root-nvm", 'ln -s /root/.nvm/node /usr/local/bin/node', "/opt/chordv-node-runtime/v20.19.0/bin/node"],
    ["system-node", 'ln -s /opt/test-node/bin/node /usr/local/bin/node', "/opt/test-node/bin/node"],
    ["new-minor", "printf '#!/bin/sh\\necho v20.20.0\\n' > /opt/test-node/bin/node; ln -s /opt/test-node/bin/node /usr/local/bin/node", "/opt/chordv-node-runtime/v20.19.0/bin/node"],
    ["root-only-system-dir", 'chmod 700 /opt/test-node; ln -s /opt/test-node/bin/node /usr/local/bin/node', "/opt/chordv-node-runtime/v20.19.0/bin/node"]
  ] as const) {
    const run = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "bash", "-v", `${root}:/test:ro`, "chordv-api:latest", "-ec", setup + commands + `
bash /test/probe.sh > /tmp/result
cat /tmp/result
[[ "$(/usr/bin/node --version)" == v18.0.0 ]]
if [[ -e /opt/chordv-node-runtime/v20.19.0/bin/node ]]; then
  [[ "$(stat -c '%U:%G:%a' /opt/chordv-node-runtime/v20.19.0/bin/node)" == root:root:755 ]]
  bash /test/probe.sh | grep -q 'SELECTED=/opt/chordv-node-runtime/v20.19.0/bin/node'
fi
`], { encoding: "utf8" });
    assert.equal(run.status, 0, `${name}: ${run.stdout}\n${run.stderr}`);
    assert.ok(run.stdout.includes(`SELECTED=${selected}`), name);
  }
  const bad = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "bash", "-v", `${root}:/test:ro`, "chordv-api:latest", "-ec", setup + `
printf '%064d' 0 > /payload/node.sha256
if bash /test/probe.sh; then exit 99; fi
[[ ! -e /opt/chordv-node-runtime/v20.19.0 ]]
[[ -z "$(find /opt/chordv-node-runtime -name '.stage.*' -print)" ]]
[[ "$(/usr/bin/node --version)" == v18.0.0 ]]
`], { encoding: "utf8" });
  assert.equal(bad.status, 0, bad.stdout + bad.stderr);
  console.log("agent runtime bootstrap passed (automatic install, repeat install, existing Node preserved, bad digest rejected)");
} finally { rmSync(root, { recursive: true, force: true }); }
