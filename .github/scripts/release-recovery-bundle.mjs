import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, rename, rm, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readReleaseArtifacts } from "./github-release-contract.mjs";
import { packReleaseTarGzip, verifyAsset } from "./release-artifacts.mjs";

export async function createRecoveryBundle({ output, ...options }) {
  const context = await readReleaseArtifacts(options);
  for (const file of context.files) if (!(await lstat(join(context.directory, file))).isFile()) throw new Error("Recovery bundle sources must be regular files, not links");
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, ".recovery-")), temporary = join(staging, "recovery.tar.gz.part");
  try {
    const payloads = join(staging, "payloads"); await mkdir(payloads);
    for (const asset of context.expectedAssets) {
      await copyFile(join(context.directory, asset.fileName), join(payloads, asset.fileName));
      await verifyAsset(payloads, asset);
    }
    packReleaseTarGzip(temporary, payloads, context.files);
    const manifestSHA256 = createHash("sha256").update(context.body).digest("hex");
    const path = join(output, `${context.kind}-${context.manifest.tag}-build${context.manifest.build}-${manifestSHA256.slice(0, 12)}-recovery.tar.gz`);
    const digest = createHash("sha256"); let sizeBytes = 0;
    for await (const chunk of createReadStream(temporary)) { sizeBytes += chunk.length; digest.update(chunk); }
    await rename(temporary, path);
    return { path, files: context.files, manifestSHA256, sizeBytes, sha256: digest.digest("hex") };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createRecoveryBundle({
    repository: process.env.CHORDV_RELEASE_REPOSITORY || process.env.VITE_GITHUB_RELEASE_REPOSITORY,
    pinnedPublicKey: String(process.env.VITE_GITHUB_RELEASE_PUBLIC_KEY || "").replaceAll("\\n", "\n"),
    kind: process.env.RELEASE_KIND || "desktop", directory: resolve(process.env.RELEASE_ASSET_DIR || "release-assets"),
    output: resolve(process.env.RECOVERY_BUNDLE_DIR || "release-recovery")
  }).then(async result => {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `bundle_path=${result.path}\n`);
    process.stdout.write(`Saved exact signed recovery bundle: ${result.path}\n`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
