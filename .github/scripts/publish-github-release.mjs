import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareRelease } from "./github-release-contract.mjs";
import { ensureTagProjection } from "./github-release-binding.mjs";
import { github } from "./github-release-client.mjs";
import { channelSnapshot, promoteChannel } from "./github-release-channel.mjs";
import { resumeChannel } from "./resume-github-release-channel.mjs";
import { completeDraft } from "./complete-github-release-draft.mjs";
import { auditRelease, verifyPublishedRelease } from "./github-release-audit.mjs";
import { uploadReleaseAsset, draftRecoveryError } from "./github-release-upload.mjs";
export { assertChannelPromotion, verifyManifestSignature } from "./github-release-contract.mjs";
export { resumeChannel };
export { completeDraft };

async function assertNewRelease(api, prefix, tag) {
  const existing = await api(`${prefix}/releases/tags/${encodeURIComponent(tag)}`, { expected: [200, 404] });
  const message = ids => `This GitHub Release already exists; immutable assets will not be overwritten. Matching release IDs: ${ids.join(", ")}. Use complete-draft ${ids.length === 1 ? ids[0] : "<explicit-release-id>"} for the intended original draft, or resume-channel if already published, with the original signed recovery bundle.`;
  if (existing && (!Number.isSafeInteger(existing.id) || existing.id <= 0)) throw new Error("Invalid existing GitHub release ID");
  if (existing && existing.draft !== true) throw new Error(message([existing.id]));
  const matches = new Set(existing ? [existing.id] : []);
  for (let page = 1; page <= 100; page++) {
    const releases = await api(`${prefix}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases) || releases.length > 100) throw new Error("Invalid GitHub release inventory");
    for (const release of releases) if (release.tag_name === tag) {
      if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error("Invalid matching release ID in inventory");
      matches.add(release.id);
    }
    if (releases.length < 100) {
      if (matches.size) throw new Error(message([...matches].sort((a, b) => a - b)));
      return;
    }
  }
  throw new Error("GitHub release inventory exceeded 100 pages; refusing creation without a complete draft inventory");
}

export async function publishRelease({ repository, token, directory, kind, pinnedPublicKey, fetchImpl = fetch, assetReadTimeoutMs = 30_000 }) {
  const context = await prepareRelease({ repository, token, directory, kind, pinnedPublicKey });
  const { body, signature, manifest, files } = context;
  const api = github({ repository, token, fetchImpl }), prefix = `/repos/${repository}`;
  const repo = await api(prefix);
  if (repo.private !== false || !repo.default_branch || repo.archived !== false) throw new Error("Release artifacts require an initialized, writable public GitHub repository");
  await channelSnapshot(api, prefix, manifest, kind, pinnedPublicKey);
  await assertNewRelease(api, prefix, manifest.tag);
  const tagCommit = await ensureTagProjection(api, context);
  let release;
  try { release = await api(`${prefix}/releases`, {
    method: "POST", expected: [201], body: {
      tag_name: manifest.tag, target_commitish: tagCommit, name: manifest.title,
      body: manifest.changelog.map(line => `- ${line}`).join("\n"), draft: true, prerelease: manifest.channel === "beta"
    }
  }); } catch (error) {
    throw new Error(`${error.message}\nIf draft creation succeeded before its response was lost, locate its explicit ID with the authenticated releases list and use complete-draft with the original signed recovery bundle; do not blindly create another release.`, { cause: error });
  }
  try {
    for (const file of files) await uploadReleaseAsset(api, context, release, file);
    await auditRelease(api, context, { releaseId: release.id, draft: true, assetReadTimeoutMs });
    await channelSnapshot(api, prefix, manifest, kind, pinnedPublicKey);
    await api(`${prefix}/releases/${release.id}`, { method: "PATCH", body: { draft: false, make_latest: kind === "desktop" && manifest.channel === "stable" ? "true" : "false" } });
    await promoteChannel(api, repository, manifest, body, signature, kind, pinnedPublicKey, {
      beforeAttempt: () => verifyPublishedRelease(api, context, { assetReadTimeoutMs })
    });
  } catch (error) { throw draftRecoveryError(error, release.id); }
  return manifest.tag;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.argv[2] || "publish";
  const operation = action === "publish" ? publishRelease : action === "resume-channel" ? resumeChannel : action === "complete-draft" ? completeDraft : null;
  if (!operation || (action === "complete-draft" ? process.argv.length !== 4 || !/^[1-9]\d*$/.test(process.argv[3]) : process.argv.length > 3)) throw new Error("Usage: publish-github-release.mjs [publish|resume-channel|complete-draft <release-id>]");
  operation({
    ...(action === "complete-draft" ? { releaseId: Number(process.argv[3]) } : {}),
    repository: process.env.CHORDV_RELEASE_REPOSITORY, token: process.env.CHORDV_RELEASE_TOKEN,
    directory: resolve(process.env.RELEASE_ASSET_DIR || "release-assets"), kind: process.env.RELEASE_KIND || "desktop",
    pinnedPublicKey: String(process.env.VITE_GITHUB_RELEASE_PUBLIC_KEY || "").replaceAll("\\n", "\n")
  }).then(result => process.stdout.write(action === "publish" ? `Published ${result} to GitHub; no deployment was performed.\n` : action === "complete-draft" ? `Completed draft and audited channel: ${result.tag}; existing assets were not overwritten.\n` : `Channel ${result.changed ? "resumed" : "already identical"}: ${result.tag}; release and assets were not modified.\n`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
