import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderInstallScript } from "../src/modules/agent/agent-install.controller";

// Execute only the prerequisite/runtime-selection segment inside disposable Linux
// containers. No downloads, service installation or host filesystem writes occur.
const root = mkdtempSync(path.join(tmpdir(), "chordv-install-runtime-"));
try {
  const script = renderInstallScript({ token: "chordv_register_test", apiBase: "https://example.com" });
  const end = script.indexOf('echo "==> 下载'); assert.ok(end > 0);
  writeFileSync(path.join(root, "probe.sh"), script.slice(0, end) + '\nprintf "SELECTED=%s\\n" "$NODE_BIN"\n');
  const setup = `
mkdir -p /root/.nvm /opt/test-node/bin
chmod 700 /root/.nvm
printf '#!/bin/sh\\necho v20.19.0\\n' > /root/.nvm/node
printf '#!/bin/sh\\necho v20.19.0\\n' > /opt/test-node/bin/node
printf '#!/bin/sh\\necho v18.0.0\\n' > /usr/bin/node
chmod 755 /root/.nvm/node /opt/test-node/bin/node /usr/bin/node
rm -f /usr/local/bin/node
`;
  for (const [name, commands, expected] of [
    ["root-nvm", 'ln -s /root/.nvm/node /usr/local/bin/node', false],
    ["system-node", 'ln -s /opt/test-node/bin/node /usr/local/bin/node', true],
    ["root-only-system-dir", 'chmod 700 /opt/test-node; ln -s /opt/test-node/bin/node /usr/local/bin/node', false]
  ] as const) {
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "bash", "-v", `${root}:/test:ro`, "chordv-api:latest", "-c", setup + commands + '\nPATH=/root/.nvm:$PATH bash /test/probe.sh'], { encoding: "utf8" });
    assert.equal(result.status, expected ? 0 : 1, `${name}: ${result.stderr}`);
    if (expected) assert.match(result.stdout, /SELECTED=\/opt\/test-node\/bin\/node/);
    else assert.doesNotMatch(result.stdout, /SELECTED=/);
  }
  console.log("agent install runtime selection passed (root nvm rejected, accessible system path selected, root-only path rejected)");
} finally { rmSync(root, { recursive: true, force: true }); }
