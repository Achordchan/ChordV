import { createReadStream } from "node:fs";
import { join } from "node:path";

export async function uploadReleaseAsset(api, context, release, file) {
  const locked = context.expectedAssets.find(asset => asset.fileName === file);
  if (!locked || !Number.isSafeInteger(locked.sizeBytes) || locked.sizeBytes <= 0 || !Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.upload_url !== "string") throw new Error("Invalid release upload identity or locked size");
  const url = new URL(release.upload_url.replace(/\{.*$/, ""));
  const path = `/repos/${context.repository}/releases/${release.id}/assets`;
  if (url.origin !== "https://uploads.github.com" || url.username || url.password || url.search || url.hash
      || url.pathname.toLowerCase() !== path.toLowerCase()) throw new Error("Invalid GitHub upload endpoint repository/release ID");
  url.searchParams.set("name", file);
  const stream = createReadStream(join(context.directory, file));
  try {
    const uploaded = await api(url.href, { method: "POST", upload: true, uploadSize: locked.sizeBytes, expected: [201], body: stream });
    if (uploaded.name !== file || uploaded.size !== locked.sizeBytes || uploaded.digest && uploaded.digest !== `sha256:${locked.sha256}`) throw new Error(`GitHub uploaded asset verification failed: ${file}`);
  } finally { stream.destroy(); }
}

export function draftRecoveryError(error, releaseId) {
  return new Error(`${error.message}\nUse the original signed recovery bundle: complete-draft ${releaseId} if still draft, or resume-channel if already published. Never regenerate the manifest or overwrite assets.`, { cause: error });
}
