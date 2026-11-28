import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { checkedMinimumVersion, checkedVersion, checkedRepository, downloadLockedAsset, makeManifest, stageDesktop, stageServer, verifyAsset, versionOrder } from "./release-artifacts.mjs";
import { testCommit, writeServerBuild } from "./fixtures/server-build.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const checksum = value => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "chordv-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function writeAsset(directory, name, bytes = Buffer.from("test-only-artifact")) {
  await writeFile(join(directory, name), bytes);
  return { fileName: name, sha256: checksum(bytes), sizeBytes: bytes.length };
}

test("reject invalid version and public artifact repository", () => {
  assert.equal(checkedVersion("v2.0.0-beta.1"), "2.0.0-beta.1");
  for (const version of ["2.0", "01.0.0", "2.0.0-beta.01", "2.0.0-beta..1", "../../payload"]) assert.throws(() => checkedVersion(version));
  for (const repository of ["", "owner/../repo", "https://github.com/owner/repo", "owner/."]) assert.throws(() => checkedRepository(repository));
});

test("desktop staging refuses invented installers rather than blessing bytes by filename", async t => {
  const directory = await fixture(t), input = join(directory, "mygo"), output = join(directory, "assets");
  await mkdir(join(input, "darwin-arm64"), { recursive: true });
  await writeFile(join(input, "darwin-arm64/chordv-2.0.0-arm64.dmg"), "test-only-dmg-bytes");
  await assert.rejects(stageDesktop({ platform: "macos", architecture: "arm64", version: "2.0.0", input, output, build: 18 }), /macOS staging runner|verification failed/);
  await assert.rejects(access(output));
  assert.deepEqual(await readdir(directory), ["mygo"], "failed staging must remove its private snapshot");
  await mkdir(output);
  const existing = join(output, "installer-macos-arm64.json");
  await writeFile(existing, "unrelated existing descriptor");
  await assert.rejects(stageDesktop({ platform: "macos", architecture: "arm64", version: "2.0.0", input, output, build: 18 }), /macOS staging runner|verification failed/);
  assert.deepEqual(await readdir(output), ["installer-macos-arm64.json"]);
  assert.equal(await readFile(existing, "utf8"), "unrelated existing descriptor");
  assert.deepEqual((await readdir(directory)).sort(), ["assets", "mygo"]);
  await writeFile(join(input, "darwin-arm64/second.dmg"), "duplicate");
  await assert.rejects(stageDesktop({ platform: "macos", architecture: "arm64", version: "2.0.0", input, output }), /exactly one installer/);
});

test("server archive contains verified real Go binary, admin resources and explicit production instructions", async t => {
  const directory = await fixture(t), input = join(directory, "backend"), output = join(directory, "assets");
  const actual = await writeServerBuild(join(input, "linux-x64"));
  const attribute = "com.chordv.qa.buildhost";
  if (process.platform === "darwin") {
    const tagged = spawnSync("/usr/bin/xattr", ["-w", attribute, "fixture", join(input, "linux-x64/admin/index.html")]);
    assert.equal(tagged.status, 0);
  }
  const asset = await stageServer({ platform: "linux", architecture: "x64", version: "2.0.0", input, output, commit: testCommit });
  assert.deepEqual(asset.buildInfo, actual);
  await verifyAsset(output, asset);
  const listing = spawnSync("tar", ["-tzf", join(output, asset.fileName)], { encoding: "utf8" });
  assert.equal(listing.status, 0); assert.match(listing.stdout, /chordv-server/); assert.match(listing.stdout, /admin\/index.html/); assert.match(listing.stdout, /DEPLOYMENT\.txt/); assert.match(listing.stdout, /build-info\.json/);
  if (process.platform === "darwin") {
    assert.equal(gunzipSync(await readFile(join(output, asset.fileName))).includes(Buffer.from(attribute)), false, "archive contains build host attributes");
    assert.doesNotMatch(listing.stdout, /(?:^|\/)\._[^/\n]+/m);
  }
  assert.doesNotMatch(listing.stdout, /LOCAL-ONLY|node_modules|\.env|postgres-data/);
});

test("server staging preserves an existing archive and descriptor instead of replacing them", async t => {
  const directory = await fixture(t), input = join(directory, "backend"), output = join(directory, "assets");
  await writeServerBuild(join(input, "linux-x64"));
  const stage = () => stageServer({ platform: "linux", architecture: "x64", version: "2.0.0", input, output, commit: testCommit });
  const original = await stage();
  const descriptor = join(output, "server-linux-x64.json");
  const originalDescriptor = await readFile(descriptor);
  await writeFile(join(input, "linux-x64/admin/assets/fixture.css"), "/* different rebuild */");
  await assert.rejects(stage(), { code: "EEXIST" });
  await verifyAsset(output, original);
  assert.deepEqual(await readFile(descriptor), originalDescriptor);
  assert.deepEqual((await readdir(output)).sort(), [original.fileName, "server-linux-x64.json"].sort());
  assert.deepEqual((await readdir(directory)).sort(), ["assets", "backend"]);
});

test("server staging leaves no orphan archive if the descriptor slot is already occupied", async t => {
  const directory = await fixture(t), input = join(directory, "backend"), output = join(directory, "assets");
  await writeServerBuild(join(input, "linux-x64"));
  await mkdir(output);
  const descriptor = join(output, "server-linux-x64.json");
  await writeFile(descriptor, "unrelated descriptor");
  await assert.rejects(stageServer({ platform: "linux", architecture: "x64", version: "2.0.0", input, output, commit: testCommit }), { code: "EEXIST" });
  assert.equal(await readFile(descriptor, "utf8"), "unrelated descriptor");
  assert.deepEqual(await readdir(output), ["server-linux-x64.json"]);
  assert.deepEqual((await readdir(directory)).sort(), ["assets", "backend"]);
});

test("concurrent server staging of one target leaves exactly one matching archive and descriptor", async t => {
  const directory = await fixture(t), output = join(directory, "assets");
  const inputs = ["backend-a", "backend-b"].map(name => join(directory, name));
  for (const input of inputs) {
    await writeServerBuild(join(input, "linux-x64"));
    await writeFile(join(input, "linux-x64/admin/assets/fixture.css"), `/* independently staged from ${input} */`);
  }
  const results = await Promise.allSettled(inputs.map(input => stageServer({ platform: "linux", architecture: "x64", version: "2.0.0", input, output, commit: testCommit })));
  const winners = results.filter(result => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  const loser = results.find(result => result.status === "rejected");
  assert.equal(loser.reason.code, "EEXIST");
  const [winner] = winners;
  await verifyAsset(output, winner.value);
  assert.deepEqual(JSON.parse(await readFile(join(output, "server-linux-x64.json"), "utf8")), winner.value);
  assert.deepEqual((await readdir(output)).sort(), [winner.value.fileName, "server-linux-x64.json"].sort());
  assert.deepEqual((await readdir(directory)).sort(), ["assets", "backend-a", "backend-b"]);
});

test("runtime download verifies actual streaming bytes and removes broken partial files", async t => {
  const directory = await fixture(t), bytes = Buffer.from("test-only-verified-download");
  const asset = { fileName: "geoip-20261116.dat", sha256: checksum(bytes), sizeBytes: bytes.length, sourceUrl: "https://github.com/fixture/components/releases/download/v1/geoip.dat" };
  await downloadLockedAsset(asset, directory, async () => new Response(bytes));
  assert.equal(await readFile(join(directory, asset.fileName), "utf8"), bytes.toString());
  await rm(join(directory, asset.fileName));
  await assert.rejects(downloadLockedAsset(asset, directory, async () => new Response("corrupted")), /SHA256 or length mismatch/);
  assert.equal((await readdir(directory)).length, 0);
  await assert.rejects(downloadLockedAsset({ ...asset, sourceUrl: "https://evil.example/payload" }, directory), /fixed GitHub/);
});

test("server manifest contains only actual server assets and a valid detached Ed25519 signature", async t => {
  const directory = await fixture(t), input = join(directory, "backend"), output = join(directory, "assets");
  for (const architecture of ["x64", "arm64"]) {
    await writeServerBuild(join(input, `linux-${architecture}`), { architecture });
    await stageServer({ platform: "linux", architecture, version: "2.0.0", input, output, commit: testCommit });
  }
  const result = await makeManifest({ kind: "server", version: "2.0.0", build: 17, directory: output, privateKey: privatePem, commit: testCommit });
  assert.equal(result.manifest.tag, "server-v2.0.0"); assert.equal(result.manifest.servers.length, 2);
  assert.equal(result.manifest.sourceCommit, testCommit);
  assert.ok(result.manifest.servers.every(asset => asset.buildInfo.commit === testCommit && asset.buildInfo.version === result.manifest.version));
  assert.equal(result.manifest.installers, undefined);
  const body = await readFile(join(output, result.fileName)), signature = await readFile(join(output, `${result.fileName}.sig`), "utf8");
  assert.equal(verify(null, body, publicKey, Buffer.from(signature.trim(), "base64")), true);
  assert.match(await readFile(join(output, "SHA256SUMS"), "utf8"), /chordv-server_2\.0\.0_linux_arm64\.tar\.gz/);
  const descriptor = join(output, "server-linux-x64.json"), asset = JSON.parse(await readFile(descriptor, "utf8"));
  await writeFile(descriptor, JSON.stringify({ ...asset, buildInfo: { ...asset.buildInfo, commit: "b".repeat(40) } }));
  await assert.rejects(makeManifest({ kind: "server", version: "2.0.0", build: 18, directory: output, privateKey: privatePem, commit: testCommit }), /descriptor differs/);
  await writeFile(descriptor, JSON.stringify(asset));
  await assert.rejects(makeManifest({ kind: "server", version: "2.0.1", build: 18, directory: output, privateKey: privatePem, commit: testCommit }), /build-info.*mismatch/);
});

test("desktop manifest requires every platform and each locked Xray/GEO component", async t => {
  const directory = await fixture(t);
  const targets = ["macos:arm64", "macos:x64", "windows:x64", "windows:arm64"];
  const commit = testCommit;
  for (const target of targets) {
    const [platform, architecture] = target.split(":");
    const asset = { platform, architecture, buildInfo: { version: "2.0.0-beta.1", build: 17, mode: "release", platform, architecture, commit }, ...await writeAsset(directory, `ChordV_2.0.0_${platform}_${architecture}${platform === "macos" ? ".dmg" : "_setup.exe"}`) };
    await writeFile(join(directory, `installer-${platform}-${architecture}.json`), JSON.stringify(asset));
  }
  const locked = [];
  for (const component of ["xray", "geoip", "geosite"]) {
    locked.push({ component, version: "test-only-1", ...await writeAsset(directory, `${component}.dat`), sourceFormat: "direct", sourceUrl: `https://github.com/fixture/components/releases/download/v1/${component}.dat`, targets: targets.map(target => { const [platform, architecture] = target.split(":"); return { platform, architecture }; }) });
  }
  const lockPath = join(directory, "test-lock.json");
  await writeFile(lockPath, JSON.stringify({ schemaVersion: 1, assets: locked }));
  const result = await makeManifest({ kind: "desktop", version: "2.0.0-beta.1", build: 17, commit, directory, privateKey: privatePem, componentLockPath: lockPath });
  assert.equal(result.manifest.channel, "beta"); assert.equal(result.manifest.installers.length, 4); assert.equal(result.manifest.runtimeComponents.length, 12);
  assert.equal(result.manifest.sourceCommit, commit);
  const descriptor = join(directory, "installer-macos-arm64.json"), original = JSON.parse(await readFile(descriptor, "utf8"));
  for (const change of [{ mode: "local" }, { version: "2.0.0" }, { build: 18 }, { commit: "b".repeat(40) }, { architecture: "x64" }]) {
    await writeFile(descriptor, JSON.stringify({ ...original, buildInfo: { ...original.buildInfo, ...change } }));
    await assert.rejects(makeManifest({ kind: "desktop", version: "2.0.0-beta.1", build: 17, commit, directory, privateKey: privatePem, componentLockPath: lockPath }), /Desktop package .* mismatch/);
  }
  await writeFile(descriptor, JSON.stringify(original));
  await rm(join(directory, "installer-windows-arm64.json"));
  await assert.rejects(makeManifest({ kind: "desktop", version: "2.0.0", build: 18, directory, privateKey: privatePem, componentLockPath: lockPath }), /missing a required platform/);
});

test("publishing cannot create unsigned manifests, fake asset descriptors or traversal paths", async t => {
  const directory = await fixture(t);
  for (const architecture of ["x64", "arm64"]) {
    const asset = { platform: "linux", architecture, ...await writeAsset(directory, `${architecture}.tar.gz`) };
    await writeFile(join(directory, `server-linux-${architecture}.json`), JSON.stringify(asset));
  }
  await assert.rejects(makeManifest({ kind: "server", version: "2.0.0", build: 1, directory }), /SIGNING_KEY is required/);
  await writeFile(join(directory, "x64.tar.gz"), "tampered");
  await assert.rejects(makeManifest({ kind: "server", version: "2.0.0", build: 1, directory, privateKey: privatePem }), /integrity mismatch/);
  await assert.rejects(verifyAsset(directory, { fileName: "../secret", sha256: "a".repeat(64), sizeBytes: 1 }), /Invalid asset/);
  await assert.rejects(access(join(directory, "chordv-server-release.json")));
});

test("release contract: producer rejects a forward minimum version before touching assets", async t => {
  const directory = await fixture(t);
  for (const [version, minimumVersion] of [["2.0.0", "v2.0.1"], ["2.0.0-beta.2", "2.0.0-beta.10"], ["2.0.0-beta.1", "2.0.0"]]) {
    await assert.rejects(makeManifest({ kind: "server", version, minimumVersion, build: 17, directory, privateKey: privatePem, commit: testCommit }), /minimum version/i);
    assert.deepEqual(await readdir(directory), []);
  }
});

test("release contract: shared SemVer ordering preserves prerelease precedence and exact integer comparisons", () => {
  for (const [left, right] of [["1.0.0-alpha", "1.0.0-alpha.1"], ["1.0.0-beta.2", "1.0.0-beta.10"], ["1.0.0-rc.1", "1.0.0"], ["9007199254740992.0.0", "9007199254740993.0.0"], ["1.0.0-9007199254740992", "1.0.0-9007199254740993"]]) {
    assert.equal(versionOrder(left, right), -1);
    assert.equal(versionOrder(right, left), 1);
  }
  assert.equal(checkedMinimumVersion("v2.0.0+old", "2.0.0+new"), "2.0.0+old");
  assert.equal(versionOrder("2.0.0+old", "2.0.0+new"), 0);
});

test("release contract: producer signs the normalized minimum version consumed by desktop clients", async t => {
  const directory = await fixture(t), targets = ["macos:arm64", "macos:x64", "windows:x64", "windows:arm64"];
  for (const target of targets) {
    const [platform, architecture] = target.split(":");
    const asset = { platform, architecture, buildInfo: { version: "2.0.0", build: 17, mode: "release", platform, architecture, commit: testCommit }, ...await writeAsset(directory, `${platform}-${architecture}${platform === "windows" ? "_setup.exe" : ".dmg"}`) };
    await writeFile(join(directory, `installer-${platform}-${architecture}.json`), JSON.stringify(asset));
  }
  const assets = [];
  for (const component of ["xray", "geoip", "geosite"]) assets.push({
    component, version: "test-only-1", ...await writeAsset(directory, `${component}.dat`), sourceFormat: "direct",
    sourceUrl: `https://github.com/fixture/components/releases/download/v1/${component}.dat`,
    targets: targets.map(target => { const [platform, architecture] = target.split(":"); return { platform, architecture }; })
  });
  const componentLockPath = join(directory, "test-lock.json");
  await writeFile(componentLockPath, JSON.stringify({ schemaVersion: 1, assets }));
  await writeFile(join(directory, "stale-from-another-release.bin"), "must not enter the current checksums");
  const result = await makeManifest({ kind: "desktop", version: "2.0.0", minimumVersion: "v1.0.0", build: 17, directory, privateKey: privatePem, commit: testCommit, componentLockPath });
  assert.equal(result.manifest.minimumVersion, "1.0.0");
  const body = await readFile(join(directory, result.fileName)), signature = await readFile(join(directory, `${result.fileName}.sig`), "utf8");
  assert.equal(JSON.parse(body).minimumVersion, "1.0.0");
  assert.equal(verify(null, body, publicKey, Buffer.from(signature.trim(), "base64")), true);
  const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  assert.doesNotMatch(sums, /stale-from-another-release/);
  assert.equal(sums.trim().split("\n").length, 7);
});

test("schema2 producer explicitly signs canonical public repository while preserving actual archive source identity", async t => {
  const directory = await fixture(t), input = join(directory, "backend"), output = join(directory, "assets");
  for (const architecture of ["x64", "arm64"]) {
    await writeServerBuild(join(input, `linux-${architecture}`), { architecture });
    await stageServer({ platform: "linux", architecture, version: "2.0.0", input, output, commit: testCommit });
  }
  const options = { kind: "server", version: "2.0.0", build: 27, directory: output, privateKey: privatePem, commit: testCommit };
  const result = await makeManifest({ ...options, tagBindingMode: "signed-manifest-tree", repository: "Owner/Public-Artifacts" });
  assert.equal(result.manifest.schemaVersion, 2);
  assert.deepEqual(result.manifest.tagBinding, { mode: "signed-manifest-tree", repository: "owner/public-artifacts" });
  assert.ok(result.manifest.servers.every(asset => asset.buildInfo.commit === testCommit));
  const body = await readFile(join(output, result.fileName)), signature = await readFile(join(output, result.fileName + ".sig"), "utf8");
  assert.equal(verify(null, body, publicKey, Buffer.from(signature.trim(), "base64")), true);
  await assert.rejects(makeManifest({ ...options, tagBindingMode: "unknown" }), /binding mode/);
  assert.ok((await readFile(join(output, result.fileName))).equals(body));
  const legacy = await makeManifest(options); assert.equal(legacy.manifest.schemaVersion, 1); assert.equal(legacy.manifest.tagBinding, undefined);
});
