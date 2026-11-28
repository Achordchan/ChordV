import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceCommit, verifyServerArchive, verifyServerBuild } from "./server-build-info.mjs";
import { assertDesktopIdentity, verifyDesktopInstaller } from "./desktop-build-info.mjs";
import { legacyTransitions, stageLegacyTransition } from "./legacy-transition.mjs";
import { assertBindingDeclaration, canonicalPublicRepository } from "./release-binding-schema.mjs";
import { assertConsumerBody, assertConsumerFields } from "./release-consumer-contract.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const targets = ["macos:arm64", "macos:x64", "windows:x64", "windows:arm64"];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function checkedVersion(value) {
  const version = String(value ?? "").replace(/^v/, "");
  const parsed = version.match(semver);
  if (!parsed || version.length > 64 || parsed[4]?.split(".").some(item => /^0\d+$/.test(item))) throw new Error("Invalid release version");
  return version;
}
export function versionOrder(left, right) {
  const parse = value => checkedVersion(value).split("+")[0].split("-"), a = parse(left), b = parse(right);
  const an = a[0].split(".").map(BigInt), bn = b[0].split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (an[i] !== bn[i]) return an[i] > bn[i] ? 1 : -1;
  const ap = a.slice(1).join("-"), bp = b.slice(1).join("-");
  if (!ap || !bp) return ap ? -1 : bp ? 1 : 0;
  const aa = ap.split("."), bb = bp.split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined) return -1;
    if (bb[i] === undefined) return 1;
    if (aa[i] === bb[i]) continue;
    const numericA = /^\d+$/.test(aa[i]), numericB = /^\d+$/.test(bb[i]);
    if (numericA && numericB) return BigInt(aa[i]) > BigInt(bb[i]) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return aa[i] > bb[i] ? 1 : -1;
  }
  return 0;
}
export function checkedMinimumVersion(value, version) {
  const minimumVersion = checkedVersion(value);
  if (versionOrder(minimumVersion, version) > 0) throw new Error("Release minimum version must not exceed the release version");
  return minimumVersion;
}
export function checkedRepository(value) {
  canonicalPublicRepository(value);
  return value;
}
function fileName(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value ?? "") || value.includes("..")) throw new Error("Invalid asset file name");
  return value;
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest("hex"), sizeBytes: (await stat(path)).size };
}
export async function verifyAsset(directory, asset) {
  fileName(asset.fileName);
  const actual = await digest(join(directory, asset.fileName));
  if (!actual.sizeBytes || actual.sizeBytes !== asset.sizeBytes || actual.sha256 !== asset.sha256) throw new Error(`Release asset integrity mismatch: ${asset.fileName}`);
  return asset;
}
export function packReleaseTarGzip(file, directory, entries, timeout = 60_000) {
  const args = ["-czf", file, "-C", directory, ...entries];
  // macOS bsdtar otherwise exports host-only xattrs and AppleDouble records.
  const macHost = process.platform === "darwin";
  if (macHost) args.unshift("--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags");
  const result = spawnSync(macHost ? "/usr/bin/tar" : "tar", args, { encoding: "utf8", timeout });
  if (result.error || result.status !== 0) throw new Error(`Release archive creation failed: ${result.error?.message || result.stderr}`);
}
export function uniqueReleaseAssets(assets) {
  const identities = new Map();
  for (const asset of assets) {
    fileName(asset.fileName);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256 ?? "") || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) throw new Error("Invalid release asset SHA256 or length");
    const previous = identities.get(asset.fileName);
    if (previous && (previous.sha256 !== asset.sha256 || previous.sizeBytes !== asset.sizeBytes)) throw new Error("Conflicting release asset descriptors");
    identities.set(asset.fileName, asset);
  }
  return [...identities.values()];
}
async function publishStagedAsset(snapshot, output, descriptor, asset) {
  const metadata = join(dirname(snapshot), descriptor);
  await writeFile(metadata, JSON.stringify(asset), { flag: "wx" });
  await mkdir(output, { recursive: true });
  const payload = join(output, asset.fileName);
  // Both final names are create-only. Roll back only the payload created by this invocation.
  await link(snapshot, payload);
  try {
    await link(metadata, join(output, descriptor));
  } catch (error) {
    await unlink(payload);
    throw error;
  }
  return asset;
}
export async function stageDesktop({ platform, architecture, version, input, output, build = Number(process.env.CHORDV_BUILD_NUMBER), commit = sourceCommit() }) {
  version = checkedVersion(version);
  if (!targets.includes(`${platform}:${architecture}`)) throw new Error("Unsupported desktop target");
  const system = platform === "macos" ? "darwin" : "windows", arch = architecture === "x64" ? "amd64" : "arm64";
  const directory = join(input, `${system}-${arch}`);
  const candidates = (await readdir(directory)).filter(name => platform === "macos" ? name.endsWith(".dmg") : /setup.*\.exe$/i.test(name));
  if (candidates.length !== 1) throw new Error(`Expected exactly one installer for ${platform}/${architecture}, got ${candidates.length}`);
  if (!Number.isSafeInteger(build) || build <= 0 || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Desktop staging requires the actual release build number and source commit");
  const installer = join(directory, candidates[0]);
  if (!(await lstat(installer)).isFile()) throw new Error("Desktop artifact must be a regular file, not a link");
  const name = `ChordV_${version}_${platform}_${architecture}${platform === "windows" ? "_setup.exe" : ".dmg"}`;
  const descriptor = `installer-${platform}-${architecture}.json`;
  const parent = dirname(resolve(output));
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".desktop-stage-"));
  try {
    const snapshot = join(temporary, name);
    await copyFile(installer, snapshot);
    const buildInfo = await verifyDesktopInstaller(snapshot, directory, { version, build, mode: "release", platform, architecture, commit });
    const asset = { platform, architecture, fileName: name, buildInfo, ...await digest(snapshot) };
    return await publishStagedAsset(snapshot, output, descriptor, asset);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function stageServer({ platform, architecture, version, input, output, commit = sourceCommit() }) {
  version = checkedVersion(version);
  if (platform !== "linux" || !["x64", "arm64"].includes(architecture)) throw new Error("Unsupported server target");
  const directory = join(input, `${platform}-${architecture}`);
  const expected = { version, commit, platform, architecture };
  await verifyServerBuild(directory, expected);
  await mkdir(output, { recursive: true });
  const name = `chordv-server_${version}_${platform}_${architecture}.tar.gz`;
  const temporary = await mkdtemp(join(dirname(resolve(output)), ".server-stage-"));
  try {
    const snapshot = join(temporary, name);
    packReleaseTarGzip(snapshot, directory, ["chordv-server", "admin", "agent-dist", "DEPLOYMENT.txt", "SERVER-CONFIG.md", "build-info.json"], 30_000);
    const buildInfo = await verifyServerArchive(snapshot, expected);
    const asset = { platform, architecture, fileName: name, buildInfo, ...await digest(snapshot) };
    return await publishStagedAsset(snapshot, output, `server-${platform}-${architecture}.json`, asset);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function downloadLockedAsset(asset, directory, fetchImpl = fetch) {
  fileName(asset.fileName);
  const origin = new URL(asset.sourceUrl);
  if (origin.protocol !== "https:" || origin.hostname !== "github.com" || !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(origin.pathname)
      || origin.username || origin.password || origin.search || origin.hash) throw new Error("Runtime source must be a fixed GitHub Release asset");
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) throw new Error("Runtime source lock requires SHA256 and length");
  await mkdir(directory, { recursive: true });
  const path = join(directory, asset.fileName), temporary = `${path}.part`;
  try { await verifyAsset(directory, asset); return; } catch { /* An absent/stale build cache is downloaded again. */ }
  const controller = new AbortController();
  let timer;
  const active = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error("Runtime download stalled")), 30_000); };
  try {
    active();
    const response = await fetchImpl(asset.sourceUrl, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Runtime download failed (${response.status})`);
    const hash = createHash("sha256"); let count = 0;
    const inspect = new Transform({ transform(chunk, _encoding, callback) {
      active(); count += chunk.length;
      if (count > asset.sizeBytes) return callback(new Error("Runtime download exceeds locked size"));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), inspect, createWriteStream(temporary, { flags: "w", mode: 0o600 }), { signal: controller.signal });
    if (count !== asset.sizeBytes || hash.digest("hex") !== asset.sha256) throw new Error("Runtime source SHA256 or length mismatch");
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  finally { clearTimeout(timer); }
}
export async function runtimeAssets(directory, lockPath = join(root, ".github/runtime-components.lock.json")) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.assets) || !lock.assets.length) throw new Error("Missing runtime source lock");
  const identities = new Set();
  for (const asset of lock.assets) {
    if (!["xray", "geoip", "geosite"].includes(asset.component) || !["direct", "zip_entry"].includes(asset.sourceFormat)
        || typeof asset.version !== "string" || !asset.version.trim() || !Array.isArray(asset.targets) || !asset.targets.length) throw new Error("Invalid runtime source lock entry");
    if (asset.sourceFormat === "zip_entry" && (typeof asset.archiveEntryName !== "string" || asset.archiveEntryName.includes("\\")
        || asset.archiveEntryName.includes(":") || asset.archiveEntryName.split("/").some(part => !part || part === "." || part === ".."))) throw new Error("Invalid runtime archive entry");
    for (const target of asset.targets) {
      const key = `${asset.component}:${target.platform}:${target.architecture}`;
      if (!targets.includes(`${target.platform}:${target.architecture}`) || identities.has(key)) throw new Error("Invalid or duplicate runtime component target");
      identities.add(key);
    }
  }
  for (const asset of lock.assets) await downloadLockedAsset(asset, directory);
  return lock.assets.flatMap(asset => asset.targets.map(target => ({
    ...target, component: asset.component, version: asset.version, fileName: asset.fileName,
    sha256: asset.sha256, sizeBytes: asset.sizeBytes, sourceFormat: asset.sourceFormat,
    ...(asset.archiveEntryName ? { archiveEntryName: asset.archiveEntryName } : {})
  })));
}
export async function makeManifest({ kind, version, build, directory, privateKey, minimumVersion = "0.0.0", forceUpgrade = false, changelog = [], componentLockPath, commit, tagBindingMode = "source-commit", repository }) {
  version = checkedVersion(version); minimumVersion = checkedMinimumVersion(minimumVersion, version);
  if (!Number.isSafeInteger(build) || build <= 0) throw new Error("Release build number must be a positive integer");
  if (kind !== "desktop" && kind !== "server") throw new Error("Invalid release kind");
  assertConsumerFields(kind, { version, minimumVersion, changelog });
  if (!privateKey?.trim()) throw new Error("CHORDV_RELEASE_SIGNING_KEY is required for publishing");
  if (!["source-commit", "signed-manifest-tree"].includes(tagBindingMode)) throw new Error("Invalid explicit release binding mode");
  const targetRepository = tagBindingMode === "signed-manifest-tree" ? canonicalPublicRepository(repository) : undefined;
  const signingKey = createPrivateKey(privateKey);
  if (signingKey.asymmetricKeyType !== "ed25519") throw new Error("Release signing key must be Ed25519");
  const channel = version.match(semver)[4] ? "beta" : "stable";
  const prefix = kind === "desktop" ? "installer-" : "server-";
  const descriptors = (await readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith(".json"));
  const assets = await Promise.all(descriptors.map(async name => verifyAsset(directory, JSON.parse(await readFile(join(directory, name), "utf8")))));
  const expected = kind === "desktop" ? targets : ["linux:x64", "linux:arm64"];
  const found = assets.map(item => `${item.platform}:${item.architecture}`);
  if (found.length !== expected.length || new Set(found).size !== expected.length || expected.some(target => !found.includes(target))) throw new Error("Release is missing a required platform installer/archive");
  const verifiedCommit = commit ?? sourceCommit();
  if (kind === "desktop") for (const asset of assets) {
    if (!asset.buildInfo) throw new Error("Desktop descriptor is missing its verified package build identity");
    assertDesktopIdentity(asset.buildInfo, { version, build, mode: "release", platform: asset.platform, architecture: asset.architecture, commit: verifiedCommit });
  }
  if (kind === "server") for (const asset of assets) {
    const actual = await verifyServerArchive(join(directory, asset.fileName), { version, commit: verifiedCommit, platform: asset.platform, architecture: asset.architecture });
    if (!asset.buildInfo || Object.keys(actual).some(key => asset.buildInfo[key] !== actual[key])) throw new Error("Server descriptor differs from actual archive build-info");
  }
  const transitions = kind === "desktop" ? await legacyTransitions(directory) : [];
  const components = kind === "desktop" ? await runtimeAssets(directory, componentLockPath) : null;
  if (components) for (const target of targets) for (const component of ["xray", "geoip", "geosite"]) {
    if (components.filter(item => `${item.platform}:${item.architecture}` === target && item.component === component).length !== 1) throw new Error(`Missing runtime component ${component}/${target}`);
  }
  const payloads = uniqueReleaseAssets([...assets, ...(components || [])]);
  const manifest = {
    schemaVersion: targetRepository ? 2 : 1, ...(targetRepository ? { tagBinding: { mode: "signed-manifest-tree", repository: targetRepository } } : {}), version, tag: `${kind === "desktop" ? "v" : "server-v"}${version}`, channel, build,
    minimumVersion, forceUpgrade, title: `ChordV${kind === "server" ? " Server" : ""} ${version}`,
    changelog, publishedAt: new Date().toISOString(),
    sourceCommit: verifiedCommit,
    ...(kind === "desktop" ? { installers: assets, runtimeComponents: components, ...(transitions.length ? { legacyTransitions: transitions } : {}) } : { servers: assets })
  };
  assertBindingDeclaration(manifest, repository);
  const name = kind === "desktop" ? "chordv-release.json" : "chordv-server-release.json";
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  assertConsumerBody(kind, body);
  if (targetRepository && body.length > 1024 * 1024) throw new Error("Metadata manifest exceeds protocol size limit");
  await writeFile(join(directory, name), body);
  await writeFile(join(directory, `${name}.sig`), `${sign(null, body, signingKey).toString("base64")}\n`);
  const checksums = payloads.map(asset => `${asset.sha256}  ${asset.fileName}`).sort();
  await writeFile(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  return { manifest, fileName: name };
}
async function main() {
  const [command, platform, architecture] = process.argv.slice(2);
  const version = checkedVersion(process.env.VERSION), output = resolve(process.env.RELEASE_ASSET_DIR || "release-assets");
  if (command === "stage-desktop") return stageDesktop({ platform, architecture, version, input: join(root, "output/mygo"), output });
  if (command === "stage-legacy") {
    const result = await stageLegacyTransition({ directory: output, platform, architecture });
    process.stdout.write(`${result.reason}\n`);
    return result;
  }
  if (command === "stage-server") return stageServer({ platform, architecture, version, input: join(root, "output/backend"), output });
  if (command === "manifest") return makeManifest({
    tagBindingMode: process.env.RELEASE_TAG_BINDING || "source-commit", repository: process.env.VITE_GITHUB_RELEASE_REPOSITORY,
    kind: process.env.RELEASE_KIND || "desktop", version, build: Number(process.env.CHORDV_BUILD_NUMBER), directory: output,
    minimumVersion: process.env.MINIMUM_VERSION || "0.0.0", forceUpgrade: process.env.FORCE_UPGRADE === "true",
    changelog: (process.env.CHANGELOG || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean), privateKey: process.env.CHORDV_RELEASE_SIGNING_KEY
  });
  throw new Error("Usage: release-artifacts.mjs stage-desktop|stage-server <platform> <x64|arm64>, or manifest");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
