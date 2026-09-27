import "reflect-metadata";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyUpdaterSignature } from "../src/modules/common/updater-signature";

async function main() {
  const config = JSON.parse(await readFile("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
  const versions = JSON.parse(await readFile("apps/desktop/config/platform-versions.json", "utf8"));
  // Same naming helper as the packager, so CI's CHORDV_BUILD_NUMBER (_buildN) is honoured.
  const { buildWindowsArtifactNames } = await import("../../desktop/scripts/platform-version.mjs");
  const installer = path.resolve(process.argv[2] ?? `output/release/windows/${buildWindowsArtifactNames(versions.windows).setup}`);
  await verifyUpdaterSignature(installer, (await readFile(`${installer}.sig`, "utf8")).trim(), config.plugins.updater.pubkey);
  console.log("Windows installer signature matches the public key embedded in the client");
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
