import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedMinimumVersion, checkedRepository, checkedVersion, uniqueReleaseAssets, verifyAsset, versionOrder } from "./release-artifacts.mjs";
import { assertDesktopIdentity } from "./desktop-build-info.mjs";
import { assertLegacyTransitionReleaseEnabled } from "./legacy-transition.mjs";
import { assertBindingDeclaration } from "./release-binding-schema.mjs";
import { assertConsumerBody, assertConsumerFields } from "./release-consumer-contract.mjs";
import { releasePublicKey } from "./release-public-key.mjs";

export function verifyManifestSignature(body, signature, key) {
  const pinned = releasePublicKey(key);
  if (!verify(null, body, pinned, Buffer.from(signature.trim(), "base64"))) throw new Error("Release manifest signature verification failed");
}
export function assertChannelPromotion(current, next) {
  if (!Number.isSafeInteger(next.build) || next.build <= 0 || (current && (!Number.isSafeInteger(current.build) || current.build <= 0))) throw new Error("Invalid release build number");
  if (current && (versionOrder(next.version, current.version) < 0
      || (versionOrder(next.version, current.version) === 0 && next.build <= current.build))) {
    throw new Error("Refusing to move the release channel backwards or replace an immutable build");
  }
}
export function assertManifestContract(manifest, kind, channel, repository) {
  if (!manifest) throw new Error("Invalid release manifest schema");
  assertBindingDeclaration(manifest, repository);
  const version = checkedVersion(manifest.version), minimum = checkedMinimumVersion(manifest.minimumVersion, version);
  if (version !== manifest.version || minimum !== manifest.minimumVersion) throw new Error("Release version and minimum version must be canonical SemVer");
  assertConsumerFields(kind, manifest);
  const expectedTag = `${kind === "server" ? "server-v" : "v"}${version}`;
  if (manifest.tag !== expectedTag || !["stable", "beta"].includes(manifest.channel)
      || (channel && channel !== manifest.channel) || (manifest.channel === "beta") !== /-/.test(version.split("+")[0])
      || !Array.isArray(kind === "server" ? manifest.servers : manifest.installers)) throw new Error("Release tag/channel/kind mismatch");
  assertChannelPromotion(null, manifest);
}
export async function prepareRelease(options) {
  if (!options.token?.trim()) throw new Error("Publishing requires a repository-scoped token and pinned Ed25519 public key");
  return readReleaseArtifacts(options);
}
export async function readReleaseArtifacts({ repository, directory, kind, pinnedPublicKey }) {
  checkedRepository(repository);
  if (kind !== "desktop" && kind !== "server") throw new Error("Invalid release kind");
  if (!pinnedPublicKey?.trim()) throw new Error("Publishing requires a pinned Ed25519 public key");
  const name = kind === "server" ? "chordv-server-release.json" : "chordv-release.json";
  const body = await readFile(join(directory, name)), signature = await readFile(join(directory, `${name}.sig`));
  assertConsumerBody(kind, body);
  verifyManifestSignature(body, signature.toString("utf8"), pinnedPublicKey);
  const manifest = JSON.parse(body.toString("utf8"));
  assertManifestContract(manifest, kind, undefined, repository);
  if (manifest.schemaVersion === 2 && body.length > 1024 * 1024) throw new Error("Metadata manifest exceeds protocol size limit");
  const selected = kind === "server" ? manifest.servers : [...manifest.installers, ...manifest.runtimeComponents];
  if (kind === "desktop") {
    const required = ["macos:x64", "macos:arm64", "windows:x64", "windows:arm64"];
    if (!/^[a-f0-9]{40,64}$/.test(manifest.sourceCommit ?? "") || !Array.isArray(manifest.installers) || manifest.installers.length !== required.length
        || required.some(target => manifest.installers.filter(asset => `${asset.platform}:${asset.architecture}` === target).length !== 1)) throw new Error("Desktop manifest must bind all platform installers to the verified package source identity");
    for (const asset of manifest.installers) {
      if (!asset.buildInfo) throw new Error("Desktop installer is missing verified package build identity");
      assertDesktopIdentity(asset.buildInfo, { version: manifest.version, build: manifest.build, mode: "release", platform: asset.platform, architecture: asset.architecture, commit: manifest.sourceCommit });
    }
  }
  if (kind === "server" && (!/^[a-f0-9]{40,64}$/.test(manifest.sourceCommit ?? "") || !Array.isArray(selected)
      || selected.length !== 2 || !["x64", "arm64"].every(architecture => selected.some(asset => asset.platform === "linux" && asset.architecture === architecture))
      || new Set(selected.map(asset => asset.fileName)).size !== selected.length
      || selected.some(asset => asset.buildInfo?.version !== manifest.version || asset.buildInfo?.commit !== manifest.sourceCommit
        || asset.buildInfo?.platform !== asset.platform || asset.buildInfo?.architecture !== asset.architecture))) {
    throw new Error("Server manifest must bind both real platform archives to the same source version and commit");
  }
  const unique = uniqueReleaseAssets(selected);
  for (const asset of unique) await verifyAsset(directory, asset);
  if (kind === "desktop" && manifest.legacyTransitions !== undefined) {
    if (!Array.isArray(manifest.legacyTransitions) || manifest.legacyTransitions.length > 1) throw new Error("Invalid legacy transition manifest");
    if (manifest.legacyTransitions.length) assertLegacyTransitionReleaseEnabled();
  }
  const files = [...unique.map(item => item.fileName), name, `${name}.sig`, "SHA256SUMS"];
  if (new Set(files).size !== files.length) throw new Error("Release asset names collide with reserved manifest files");
  const checksums = await readFile(join(directory, "SHA256SUMS"));
  const lines = checksums.toString("utf8").replace(/\n$/, "").split("\n"), seen = new Set();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/), asset = match && unique.find(value => value.fileName === match[2]);
    if (!asset || seen.has(asset.fileName) || asset.sha256 !== match[1]) throw new Error("SHA256SUMS has an unknown, duplicate or mismatched checksum entry");
    seen.add(asset.fileName);
  }
  if (seen.size !== unique.length) throw new Error("SHA256SUMS is missing a signed payload checksum");
  const expectedAssets = unique.map(asset => ({ fileName: asset.fileName, sha256: asset.sha256, sizeBytes: asset.sizeBytes }));
  for (const [fileName, bytes] of [[name, body], [`${name}.sig`, signature], ["SHA256SUMS", checksums]]) {
    if (!bytes.length) throw new Error(`Empty release asset: ${fileName}`);
    expectedAssets.push({ fileName, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length });
  }
  return { repository, directory, kind, pinnedPublicKey, name, body, signature, manifest, unique, files, expectedAssets };
}
