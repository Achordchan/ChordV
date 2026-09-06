import "reflect-metadata";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SystemUpdateService } from "../src/modules/common/system-update.service";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function signedChannel() {
  const state = mkdtempSync(path.join(tmpdir(), "chordv-channel-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const service = new SystemUpdateService({} as never, {} as never) as any;
  service.config.stateDir = state;
  service.config.manifestPublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  service.resolveMirrorPrefix = async () => "https://mirror.example/";
  const floor = path.join(state, "manifest-floor-version");
  function feed(channel: unknown, version = "999.0.0", tamper = false) {
    let text = JSON.stringify({ version, channel, artifact: { url: "https://example.com/package.tar.gz", sha256: "a".repeat(64), sizeBytes: 100 } });
    const signature = sign(null, Buffer.from(text), privateKey).toString("base64");
    if (tamper) text = text.replace('"prerelease"', '"stable"');
    service.fetchManifestText = async (url: string) => url.endsWith(".sig") ? signature : text;
  }
  try {
    for (const channel of ["prerelease", "beta", undefined, null, { stable: true }]) {
      feed(channel);
      await assert.rejects(service.fetchManifestRelease("https://example.com/latest.json"), /稳定发布渠道/);
      assert.equal(existsSync(floor), false, "valid signature on non-stable data cannot poison first floor");
    }
    feed("stable", "2.0.0");
    assert.equal((await service.fetchManifestRelease("https://example.com/latest.json")).version, "2.0.0");
    feed("prerelease");
    await assert.rejects(service.fetchManifestRelease("https://example.com/latest.json"), /稳定发布渠道/);
    assert.equal(readFileSync(floor, "utf8"), "2.0.0");
    feed("prerelease", "999.0.0", true);
    await assert.rejects(service.fetchManifestRelease("https://example.com/latest.json"), /签名校验失败/);
    assert.equal(readFileSync(floor, "utf8"), "2.0.0");
  } finally { rmSync(state, { recursive: true, force: true }); }
}

async function stagingKeepsHistory() {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-stage-history-"));
  const versions = ["1.0.0", "1.0.1", "1.0.2", "1.0.3"];
  try {
    for (const version of versions) mkdirSync(path.join(root, version));
    const service = new SystemUpdateService({} as never, {} as never) as any;
    service.config.releasesDir = root;
    const release = { version: "1.0.3", downloadUrl: "https://example.com/package.tar.gz", sha256: "a".repeat(64) };
    service.checkUpdate = async () => ({ hasUpdate: true, warning: null, cached: false, release });
    service.markRunning = async () => undefined;
    service.downloadAndExtractRelease = async () => path.join(root, "1.0.3");
    service.detectPendingMigrations = async () => [];
    let staged = false;
    service.scheduleProcessExit = () => { staged = true; };
    await service.runUpdateInBackground("sysop-policy", "1.0.2", { assertHeld: async () => undefined, release: async () => undefined }, "1.0.3");
    assert.equal(staged, true);
    assert.deepEqual(readdirSync(root).sort(), versions, "staging must retain every rollback version");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function supervisorRetention(healthy: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-final-history-"));
  const releases = path.join(root, "releases"), state = path.join(root, "state");
  mkdirSync(releases); mkdirSync(state);
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); assert.ok(address && typeof address === "object");
  const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const entry = "apps/api/dist/apps/api/src/main.js";
  for (const version of ["1.0.0", "1.0.1", "1.0.2", "1.0.3"]) {
    const dir = path.join(releases, version);
    mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
    mkdirSync(path.join(dir, "apps/admin/dist"), { recursive: true });
    writeFileSync(path.join(dir, "apps/admin/dist/index.html"), "test bundle");
    writeFileSync(path.join(dir, entry), version === "1.0.3" && !healthy ? "process.exit(1);" :
      "require('http').createServer((q,r)=>r.end('ready')).listen(Number(process.env.CHORDV_API_PORT),'127.0.0.1');");
    const utils = path.join(dir, "apps/api/dist/apps/api/src/modules/common/release-center.utils.js");
    mkdirSync(path.dirname(utils), { recursive: true });
    writeFileSync(utils, `require(${JSON.stringify(require.resolve("tsx/cjs"))});module.exports=require(${JSON.stringify(path.resolve(__dirname, "../src/modules/common/release-center.utils.ts"))});`);
  }
  writeFileSync(path.join(state, "last-good-version"), "1.0.2");
  writeFileSync(path.join(state, "pending.json"), JSON.stringify({ version: "1.0.3", operationId: "sysop-retention", kind: "update", migrationApplied: false }));
  const child = spawn("bash", [path.resolve(__dirname, "../../../deploy/1panel/chordv/entrypoint.sh")], {
    detached: true, stdio: ["ignore", "ignore", "pipe"], env: {
      ...process.env, TSX_TSCONFIG_PATH: path.resolve(__dirname, "../tsconfig.json"),
      CHORDV_SYSTEM_NODE_BIN: process.execPath, CHORDV_SYSTEM_RELEASES_DIR: releases, CHORDV_SYSTEM_STATE_DIR: state,
      CHORDV_SYSTEM_PUBLIC_STATE_DIR: path.join(root, "public"), CHORDV_SYSTEM_CURRENT_LINK: path.join(root, "current"),
      CHORDV_API_PORT: String(port), CHORDV_SUPERVISOR_MIGRATE: "false", CHORDV_SYSTEM_UPDATE_KEEP_RELEASES: "3",
      CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS: "1", CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS: "8"
    }
  });
  let logs = ""; child.stderr.on("data", chunk => { logs += chunk; });
  try {
    const deadline = Date.now() + 20_000;
    while (!logs.includes("healthy + stable (last-good)")) { assert.ok(Date.now() < deadline, logs); await sleep(50); }
    assert.deepEqual(readdirSync(releases).sort(), healthy ? ["1.0.1", "1.0.2", "1.0.3"] : ["1.0.0", "1.0.1", "1.0.2"]);
    const result = JSON.parse(readFileSync(path.join(state, "operation-result.sysop-retention.json"), "utf8"));
    assert.equal(result.status, healthy ? "success" : "rolledback");
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already stopped */ }
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  await signedChannel(); await stagingKeepsHistory(); await supervisorRetention(false); await supervisorRetention(true);
  console.log("system-update-release-policy.regression.ts passed (signed channel, staging retention, failed/successful promotion)");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
