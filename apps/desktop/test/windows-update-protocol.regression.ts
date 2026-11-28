import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseReleaseManifest } from "../src/lib/githubReleaseManifest";
import { projectGitHubUpdate } from "../src/lib/githubReleaseProjection";
import { preferredArtifactType } from "../src/lib/updateState";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/github-release.json", import.meta.url), "utf8"));
const configuration = { repository: "fixture/chordv-releases", publicKey: "test-only-pinned-public-key" };
const input = { currentVersion: "1.1.12", currentBuild: 1, platform: "windows" as const, architecture: "x64" as const, channel: "stable" as const };

test("Windows只接受对应架构EXE和已校验GitHub资产元数据", () => {
  const manifest = parseReleaseManifest(JSON.stringify(fixture), "stable");
  const update = projectGitHubUpdate(manifest, configuration, input);
  assert.equal(preferredArtifactType("windows"), "setup.exe");
  assert.equal(update.artifact?.fileType, "setup.exe");
  assert.equal(update.artifact?.fileHash, fixture.installers[1].sha256);
  assert.equal(update.artifact?.fileSizeBytes, fixture.installers[1].sizeBytes);
  assert.equal(update.latestBuild, 42);
  assert.equal(update.deliveryMode, "desktop_installer_download");
  assert.match(update.artifact?.originDownloadUrl ?? "", /https:\/\/github\.com\/fixture\/chordv-releases\/releases\/download\/v2\.0\.0\//);
  assert.equal(update.artifact?.downloadCandidates?.at(-1), update.artifact?.originDownloadUrl);
  assert.throws(() => projectGitHubUpdate(manifest, configuration, { ...input, architecture: "arm64" }), /尚未提供/);
});

test("拒绝旧ZIP、无SHA256及不匹配平台安装包", () => {
  for (const item of [
    { ...fixture.installers[1], fileName: "legacy-full.zip" },
    { ...fixture.installers[1], sha256: null },
    { ...fixture.installers[1], sizeBytes: 0 },
    { ...fixture.installers[1], fileName: "macos.dmg" }
  ]) assert.throws(() => parseReleaseManifest(JSON.stringify({ ...fixture, installers: [item] })));
});

test("最低版本与强制更新来自GitHub，较高版本不被降级", () => {
  const manifest = parseReleaseManifest(JSON.stringify({ ...fixture, minimumVersion: "1.2.0", forceUpgrade: true }));
  const required = projectGitHubUpdate(manifest, configuration, input);
  assert.equal(required.hasUpdate, true); assert.equal(required.forceUpgrade, true);
  const newer = projectGitHubUpdate(manifest, configuration, { ...input, currentVersion: "2.1.0" });
  assert.equal(newer.hasUpdate, false); assert.equal(newer.forceUpgrade, false);
  const same = projectGitHubUpdate(manifest, configuration, { ...input, currentVersion: "2.0.0", currentBuild: 42 });
  assert.equal(same.hasUpdate, false); assert.equal(same.forceUpgrade, false);
  const nextBuild = projectGitHubUpdate(manifest, configuration, { ...input, currentVersion: "2.0.0", currentBuild: 41 });
  assert.equal(nextBuild.hasUpdate, true);
});

test("测试版即使误标最低版本或强制更新也不会锁住客户端", () => {
  const manifest = parseReleaseManifest(JSON.stringify({ ...fixture, version: "2.0.0-beta.1", tag: "v2.0.0-beta.1", channel: "beta", minimumVersion: "1.2.0", forceUpgrade: true }));
  const update = projectGitHubUpdate(manifest, configuration, { ...input, channel: "beta" });
  assert.equal(update.hasUpdate, true); assert.equal(update.forceUpgrade, false); assert.equal(update.minimumVersion, "0.0.0");
});
