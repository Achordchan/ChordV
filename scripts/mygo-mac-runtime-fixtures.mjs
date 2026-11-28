import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { downloadLockedAsset } from "../.github/scripts/release-artifacts.mjs";

const [, , output, architecture = process.arch] = process.argv;
if (!output || process.argv.length > 4 || process.platform !== "darwin" || !["x64", "arm64"].includes(architecture)) {
  throw new Error("Usage on macOS: node scripts/mygo-mac-runtime-fixtures.mjs NEW_DIRECTORY [arm64|x64]");
}
const lock = JSON.parse(await readFile(new URL("../.github/runtime-components.lock.json", import.meta.url)));
if (lock.schemaVersion !== 1) throw new Error("Unsupported runtime lock");
const assets = lock.assets.filter(a => a.targets.some(t => t.platform === "macos" && t.architecture === architecture));
if (assets.map(a => a.component).sort().join(",") !== "geoip,geosite,xray") throw new Error("Incomplete or duplicate macOS runtime sources");
await mkdir(output, { mode: 0o700 });
const cache = join(output, "downloads");
for (const asset of assets) {
  await downloadLockedAsset(asset, cache);
  const file = join(cache, asset.fileName);
  if (asset.component === "xray") {
    if (asset.sourceFormat !== "zip_entry" || asset.archiveEntryName !== "xray") throw new Error("Unexpected Xray archive layout");
    const binary = execFileSync("/usr/bin/unzip", ["-p", file, "xray"], { maxBuffer: 128 * 1024 * 1024, timeout: 30_000 });
    const arm = architecture === "arm64";
    if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== (arm ? 0x0100000c : 0x01000007) || binary.readUInt32LE(12) !== 2) {
      throw new Error(`Expected a macOS ${architecture} Mach-O executable`);
    }
    await writeFile(join(output, arm ? "xray-aarch64-apple-darwin" : "xray-x86_64-apple-darwin"), binary, { flag: "wx", mode: 0o700 });
  } else {
    if (asset.sourceFormat !== "direct") throw new Error("Expected direct GEO asset");
    await copyFile(file, join(output, `${asset.component}.dat`));
  }
}
