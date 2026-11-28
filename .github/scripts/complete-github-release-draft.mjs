import { prepareRelease } from "./github-release-contract.mjs";
import { github } from "./github-release-client.mjs";
import { auditRelease } from "./github-release-audit.mjs";
import { channelSnapshot } from "./github-release-channel.mjs";
import { uploadReleaseAsset, draftRecoveryError } from "./github-release-upload.mjs";
import { resumeChannel } from "./resume-github-release-channel.mjs";

export async function completeDraft({ releaseId, assetReadTimeoutMs = 30_000, fetchImpl = fetch, ...options }) {
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) throw new Error("Completion requires an explicit positive release ID");
  const context = await prepareRelease(options), { repository, manifest, kind, pinnedPublicKey } = context;
  const prefix = `/repos/${repository}`, api = github({ repository, token: options.token, fetchImpl, draftOnly: { releaseId, files: [] } });
  const repo = await api(prefix);
  if (repo.private !== false || !repo.default_branch || repo.archived !== false) throw new Error("Draft completion requires an initialized, writable public GitHub repository");
  const audit = { releaseId, draft: true, assetReadTimeoutMs };
  const { release, assets } = await auditRelease(api, context, { ...audit, allowMissing: true });
  await channelSnapshot(api, prefix, manifest, kind, pinnedPublicKey);
  const missing = context.files.filter(file => !assets.some(asset => asset.name === file));
  const writer = github({ repository, token: options.token, fetchImpl, draftOnly: { releaseId, files: missing } });
  try {
    for (const file of missing) await uploadReleaseAsset(writer, context, release, file);
    await auditRelease(api, context, audit);
    await channelSnapshot(api, prefix, manifest, kind, pinnedPublicKey);
    await writer(`${prefix}/releases/${releaseId}`, { method: "PATCH", body: { draft: false, make_latest: kind === "desktop" && manifest.channel === "stable" ? "true" : "false" } });
    return await resumeChannel({ ...options, fetchImpl, assetReadTimeoutMs });
  } catch (error) { throw draftRecoveryError(error, releaseId); }
}
