import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildMacArtifactNames, desktopRoot, resolveDesktopPlatformVersion } from "./platform-version.mjs";

const outputDir = path.resolve(desktopRoot, "..", "..", "output", "release", "macos");
const macosVersion = resolveDesktopPlatformVersion("macos");
const macosArtifactNames = buildMacArtifactNames(macosVersion);
const minimumArtifactBytes = 1024 * 1024;
const minimumRuntimeBytes = 1024 * 1024;
const minimumGeoDataBytes = 64 * 1024;

const dmgPath = path.join(outputDir, macosArtifactNames.dmg);
const expectedArtifactNames = new Set([macosArtifactNames.dmg]);
const staleArtifacts = existsSync(outputDir)
  ? readdirSync(outputDir)
      .filter((name) => /^ChordV_.+\.dmg$/i.test(name))
      .filter((name) => !expectedArtifactNames.has(name))
      .map((name) => path.join(outputDir, name))
  : [];

const missing = [];
const invalid = [];

if (!existsSync(dmgPath)) {
  missing.push(`DMG: ${path.relative(process.cwd(), dmgPath)}`);
} else if (statSync(dmgPath).size < minimumArtifactBytes) {
  invalid.push(`DMG is suspiciously small: ${path.relative(process.cwd(), dmgPath)} (${formatSize(statSync(dmgPath).size)})`);
}

for (const resource of [
  ["bin/xray-aarch64-apple-darwin", minimumRuntimeBytes],
  ["bin/xray-x86_64-apple-darwin", minimumRuntimeBytes],
  ["bin/geoip.dat", minimumGeoDataBytes],
  ["bin/geosite.dat", minimumGeoDataBytes]
]) {
  const [relativePath, minimumBytes] = resource;
  const fullPath = path.join(desktopRoot, "src-tauri", ...relativePath.split("/"));
  if (!existsSync(fullPath)) {
    missing.push(`Bundled runtime resource: ${relativePath}`);
    continue;
  }
  if (statSync(fullPath).size < minimumBytes) {
    invalid.push(`Bundled runtime resource is invalid: ${relativePath} (${formatSize(statSync(fullPath).size)})`);
  }
}

if (missing.length > 0 || invalid.length > 0 || staleArtifacts.length > 0) {
  console.error(`macOS ${macosVersion} release artifacts are incomplete.`);
  for (const item of missing) {
    console.error(`- Missing ${item}`);
  }
  for (const item of invalid) {
    console.error(`- ${item}`);
  }
  for (const item of staleArtifacts) {
    console.error(`- Stale artifact must be removed: ${path.relative(process.cwd(), item)}`);
  }
  console.error("Run on macOS: corepack pnpm --filter @chordv/desktop tauri:build:platform macos");
  process.exit(1);
}

console.log(`macOS ${macosVersion} release artifacts:`);
console.log(`- DMG: ${path.relative(process.cwd(), dmgPath)} (${formatSize(statSync(dmgPath).size)})`);
console.log("- Bundled runtime resources: xray arm64, xray x64, geoip.dat, geosite.dat");

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
