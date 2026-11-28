import { prepareRelease } from "./github-release-contract.mjs";
import { github } from "./github-release-client.mjs";
import { promoteChannel } from "./github-release-channel.mjs";
import { verifyPublishedRelease } from "./github-release-audit.mjs";

export async function resumeChannel({ repository, token, directory, kind, pinnedPublicKey, fetchImpl = fetch, assetReadTimeoutMs = 30_000 }) {
  const context = await prepareRelease({ repository, token, directory, kind, pinnedPublicKey });
  const api = github({ repository, token, fetchImpl, channelOnly: true });
  const repo = await api(`/repos/${repository}`);
  if (repo.private !== false || !repo.default_branch || repo.archived !== false) throw new Error("Channel recovery requires an initialized, writable public GitHub repository");
  const { manifest, body, signature } = context;
  const changed = await promoteChannel(api, repository, manifest, body, signature, kind, pinnedPublicKey, {
    allowIdentical: true, beforeAttempt: () => verifyPublishedRelease(api, context, { assetReadTimeoutMs })
  });
  return { tag: manifest.tag, changed };
}
