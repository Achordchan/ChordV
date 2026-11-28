import { createHash } from "node:crypto";
import { assertManifestContract, verifyManifestSignature } from "./github-release-contract.mjs";
import { verifyTagBinding } from "./github-release-binding.mjs";

function releaseIdentity(release, manifest, draft, releaseId) {
  if (!release || !Number.isSafeInteger(release.id) || release.id <= 0 || release.draft !== draft
      || releaseId !== undefined && release.id !== releaseId
      || release.tag_name !== manifest.tag || release.prerelease !== (manifest.channel === "beta")
      || (draft ? release.published_at !== null : typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at)))) {
    throw new Error(draft ? "Completion requires the matching unpublished draft release ID" : "Recovery requires the matching, already published non-draft release");
  }
  return JSON.stringify([release.id, release.tag_name, release.draft, release.prerelease, release.published_at, release.updated_at ?? null, release.upload_url ?? null]);
}
async function listAssets(api, prefix, releaseId, expectedAssets, allowMissing) {
  const assets = [], names = new Set(), ids = new Set();
  for (let page = 1; page <= Math.ceil(expectedAssets.length / 100) + 1; page++) {
    const items = await api(`${prefix}/releases/${releaseId}/assets?per_page=100&page=${page}`);
    if (!Array.isArray(items) || items.length > 100) throw new Error("Invalid GitHub release asset list");
    for (const asset of items) {
      const locked = expectedAssets.find(value => value.fileName === asset.name);
      if (!locked || names.has(asset.name) || ids.has(asset.id) || !Number.isSafeInteger(asset.id) || asset.id <= 0
          || asset.state !== "uploaded" || asset.size !== locked.sizeBytes
          || normalizedAssetURL(asset.url) !== normalizedAssetURL(`https://api.github.com${prefix}/releases/assets/${asset.id}`)
          || asset.digest && asset.digest !== `sha256:${locked.sha256}`) throw new Error(`GitHub release asset list is duplicate, unexpected or differs from local locked assets: ${asset.name} (ID ${asset.id}, state ${asset.state})`);
      names.add(asset.name); ids.add(asset.id); assets.push(asset);
    }
    if (assets.length > expectedAssets.length) throw new Error("Extra GitHub release assets");
    if (items.length < 100) break;
  }
  if (!allowMissing && assets.length !== expectedAssets.length) throw new Error("GitHub release asset list is incomplete");
  return assets.sort((a, b) => a.name.localeCompare(b.name));
}
function normalizedAssetURL(value) {
  return typeof value === "string" ? value.replace(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)(?=\/)/, (_, owner, repository) => `https://api.github.com/repos/${owner.toLowerCase()}/${repository.toLowerCase()}`) : null;
}
function assetIdentity(assets) {
  return JSON.stringify(assets.map(asset => [asset.id, asset.name, asset.size, asset.state, asset.url, asset.digest ?? null, asset.created_at ?? null, asset.updated_at ?? null]));
}
async function inspectAsset(response, locked, capture, readTimeoutMs) {
  if (!response.body) throw new Error(`Missing GitHub asset stream: ${locked.fileName}`);
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) !== locked.sizeBytes)) {
    void response.body.cancel().catch(() => undefined); throw new Error(`Remote asset length differs: ${locked.fileName}`);
  }
  const reader = response.body.getReader(), hash = createHash("sha256"), chunks = [];
  let size = 0;
  try {
    for (;;) {
      let timer;
      const read = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Remote asset stream stalled: ${locked.fileName}`)), readTimeoutMs); })]).finally(() => clearTimeout(timer));
      if (read.done) break;
      const bytes = Buffer.from(read.value); size += bytes.length;
      if (size > locked.sizeBytes) throw new Error(`Remote asset exceeds locked length: ${locked.fileName}`);
      hash.update(bytes); if (capture) chunks.push(bytes);
    }
    if (size !== locked.sizeBytes || hash.digest("hex") !== locked.sha256) throw new Error(`Remote asset SHA256/length integrity mismatch: ${locked.fileName}`);
    return capture ? Buffer.concat(chunks) : null;
  } catch (error) { void reader.cancel(error).catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}
export async function auditRelease(api, context, { assetReadTimeoutMs = 30_000, draft = false, releaseId, allowMissing = false } = {}) {
  if (!Number.isSafeInteger(assetReadTimeoutMs) || assetReadTimeoutMs < 1 || assetReadTimeoutMs > 30_000) throw new Error("Invalid asset stream timeout");
  if (typeof draft !== "boolean" || typeof allowMissing !== "boolean" || allowMissing && !draft || draft && releaseId === undefined
      || releaseId !== undefined && (!Number.isSafeInteger(releaseId) || releaseId <= 0)) throw new Error("Invalid release audit scope");
  const { repository, manifest, expectedAssets, name, body, signature, kind, pinnedPublicKey } = context;
  const prefix = `/repos/${repository}`, releasePath = releaseId === undefined ? `${prefix}/releases/tags/${encodeURIComponent(manifest.tag)}` : `${prefix}/releases/${releaseId}`;
  const release = await api(releasePath, { expected: [200, 404] }), identity = releaseIdentity(release, manifest, draft, releaseId);
  await verifyTagBinding(api, context);
  const assets = await listAssets(api, prefix, release.id, expectedAssets, allowMissing), originalAssets = assetIdentity(assets), captured = new Map();
  for (const asset of assets) {
    const locked = expectedAssets.find(value => value.fileName === asset.name), capture = asset.name === name || asset.name === `${name}.sig`;
    const response = await api(`${prefix}/releases/assets/${asset.id}`, { download: true });
    const bytes = await inspectAsset(response, locked, capture, assetReadTimeoutMs);
    if (capture) captured.set(asset.name, bytes);
  }
  const remoteBody = captured.get(name), remoteSignature = captured.get(`${name}.sig`);
  if ((!allowMissing || remoteBody) && !remoteBody?.equals(body)
      || (!allowMissing || remoteSignature) && !remoteSignature?.equals(signature)) throw new Error("Remote manifest/signature original bytes differ from verified local files");
  if (remoteBody && remoteSignature) {
    verifyManifestSignature(remoteBody, remoteSignature.toString("utf8"), pinnedPublicKey);
    assertManifestContract(JSON.parse(remoteBody.toString("utf8")), kind, manifest.channel, repository);
  }
  if (identity !== releaseIdentity(await api(releasePath), manifest, draft, releaseId)
      || originalAssets !== assetIdentity(await listAssets(api, prefix, release.id, expectedAssets, allowMissing))) throw new Error("Release/assets changed during integrity audit");
  await verifyTagBinding(api, context);
  return { release, assets };
}
export function verifyPublishedRelease(api, context, options = {}) {
  return auditRelease(api, context, { assetReadTimeoutMs: options.assetReadTimeoutMs, draft: false });
}
