import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyUpdaterSignature } from "../src/modules/common/updater-signature";
import { ReleaseCenterService } from "../src/modules/common/release-center.service";
import { WINDOWS_UPDATER_PUBLIC_KEY } from "@chordv/shared";

async function main() {
  const fixture = JSON.parse(await readFile(path.join(__dirname, "fixtures/tauri-signature.json"), "utf8"));
  const config = JSON.parse(await readFile(path.join(__dirname, "../../desktop/src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(config.plugins.updater.pubkey, WINDOWS_UPDATER_PUBLIC_KEY, "backend and client must pin the same release key");
  assert.equal(config.plugins.updater.windows.installMode, "passive");
  const dir = await mkdtemp(path.join(tmpdir(), "chordv-sig-test-"));
  try {
    const file = path.join(dir, "payload");
    await writeFile(file, fixture.payload);
    await verifyUpdaterSignature(file, fixture.signature, fixture.publicKey);
    await assert.rejects(verifyUpdaterSignature(file, fixture.signature), /密钥/);
    await writeFile(file, fixture.payload + "modified");
    await assert.rejects(verifyUpdaterSignature(file, fixture.signature, fixture.publicKey), /校验失败/);
    await writeFile(file, fixture.payload);
    const badComment = Buffer.from(Buffer.from(fixture.signature, "base64").toString().replace("trusted comment: timestamp", "trusted comment: changedtimestamp")).toString("base64");
    await assert.rejects(verifyUpdaterSignature(file, badComment, fixture.publicKey));
    await assert.rejects(verifyUpdaterSignature(file, null, fixture.publicKey), /缺少/);
  } finally { await rm(dir, { recursive: true, force: true }); }

  const artifact: any = { id: "installer", type: "setup_exe", source: "uploaded", deliveryMode: "desktop_installer_download", downloadUrl: "https://updates.example/1.1.9.exe", fileName: "ChordV-setup.exe", fileHash: "a".repeat(64), fileSizeBytes: 100n, updaterSignature: fixture.signature, createdAt: new Date(), updatedAt: new Date(), isPrimary: true };
  const service: any = Object.create(ReleaseCenterService.prototype);
  service.findPublishedReleaseCandidates = async () => [{ version: "1.1.9", minimumVersion: "1.1.8", forceUpgrade: true, changelog: [], publishedAt: new Date(), artifacts: [artifact] }];
  service.pickClientUsableArtifact = async (_rows: any, platform: string, type: string) => {
    assert.equal(platform, "windows"); assert.equal(type, "setup.exe"); return artifact;
  };
  for (const artifactType of ["zip", "setup.exe"] as const) {
    const result = await service.checkClientUpdate({ currentVersion: "1.1.7", platform: "windows", channel: "stable", artifactType });
    assert.equal(result.hasUpdate, true); assert.equal(result.forceUpgrade, true);
    assert.equal(result.deliveryMode, artifactType === "zip" ? "external_download" : "desktop_installer_download");
    assert.equal(result.recommendedArtifact.type, artifactType === "zip" ? "external" : "setup.exe");
    assert.equal(artifact.type, "setup_exe", "legacy response must not mutate stored artifact");
  }
  service.pickClientUsableArtifact = async () => null;
  const missing = await service.checkClientUpdate({ currentVersion: "1.1.7", platform: "windows", channel: "stable", artifactType: "zip" });
  assert.equal(missing.hasUpdate, false); assert.equal(missing.downloadUrl, null);
  console.log("Windows updater: official CLI signature interoperability, tamper rejection, key consistency and legacy installer bridge passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
