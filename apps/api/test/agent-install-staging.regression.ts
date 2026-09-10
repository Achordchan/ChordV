import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeOrigin, renderInstallScript } from "../src/modules/agent/agent-install.controller";
import { normalizePanelInbound } from "../src/modules/agent/panel-inbound";

const spec = normalizePanelInbound({ mode: "validate_panel", panelVersion: "auto", listenPort: 443,
  serverHost: "node.example.com", realityPublicKey: Buffer.alloc(32, 1).toString("base64url"),
  shortId: "ab", serverNames: ["example.com"], flow: "xtls-rprx-vision" });
// Executable fixture is confined to the disposable installer container. Real
// protocol and Xray validation are covered separately, not simulated here.
const fixture = `#!/bin/bash
case "$1" in
  --version) echo 0.0.11 ;;
  --inspect-panel) [[ ! -f /scenario/preflight-fails ]] || exit 1
    printf 'XRAY_API_ADDRESS=127.0.0.1:62789\\nXRAY_INBOUND_TAG=inbound-443\\nCHORDV_PANEL_VERSION=3.7.0\\n' ;;
  --health) test -f /var/lib/chordv-node-agent/credentials.json ;;
  --verify-inbound) : ;;
  *) exit 1 ;;
esac
`;
const digest = createHash("sha256").update(fixture).digest("hex");
const input = { token: "chordv_register_test", apiBase: "https://control.example.com", nodeId: "test-node", usable: true,
  spec, release: { version: "0.0.11", commit: "a".repeat(40), sha256: { amd64: digest, arm64: digest } } };
const script = renderInstallScript(input);
assert.equal(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status, 0);
assert.equal(script.includes("@@"), false);
assert.equal(script.includes("NODE_BIN"), false);
assert.equal(script.includes("chordv-xray.service"), false);
assert.equal(script.includes("REGISTER_TOKEN='chordv_register_test'"), true);
assert.equal(script.includes("agent-download/go/$VERSION/$ARCH"), true);
for (const hostile of ["https://$(id).example.com", "https://user:pw@example.com", "https://a.example.com/$(id)", "http://a.example.com", "https://a.example.com\nexit 0"]) {
  assert.equal(normalizeOrigin(hostile), "");
  assert.throws(() => renderInstallScript({ ...input, apiBase: hostile }), /公网地址无效/);
}
assert.throws(() => renderInstallScript({ ...input, token: "$(id)" }), /注册令牌格式无效/);
assert.throws(() => renderInstallScript({ ...input, spec: { ...spec, inboundTag: "$(id)" } }), /tag/);
assert.equal(normalizeOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");

if (process.env.CHORDV_INSTALLER_E2E === "1") {
  const dir = mkdtempSync(path.join(tmpdir(), "chordv-go-installer-test-"));
  try {
    writeFileSync(path.join(dir, "agent"), fixture);
    writeFileSync(path.join(dir, "install.sh"), script);
    writeFileSync(path.join(dir, "expired.sh"), renderInstallScript({ ...input, usable: false }));
    writeFileSync(path.join(dir, "other.sh"), renderInstallScript({ ...input, nodeId: "another-node" }));
    writeFileSync(path.join(dir, "corrupt.sh"), renderInstallScript({ ...input, release: { ...input.release, sha256: { amd64: "0".repeat(64), arm64: "0".repeat(64) } } }));
    const harness = path.resolve(__dirname, "fixtures/go-install-host.sh");
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev", "-v", `${dir}:/payload:ro`,
      "-v", `${harness}:/test.sh:ro`, "node:20.19.0-bookworm", "bash", "/test.sh"], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    process.stdout.write(result.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log("Go installer rendering and origin safety passed");
