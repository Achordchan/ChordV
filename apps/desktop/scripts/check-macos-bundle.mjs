import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { buildMacArtifactNames, desktopRoot, resolveDesktopPlatformVersion } from "./platform-version.mjs";

const outputDir = path.resolve(desktopRoot, "..", "..", "output", "release", "macos");
const macosVersion = resolveDesktopPlatformVersion("macos");
const macosArtifactNames = buildMacArtifactNames(macosVersion);
const minimumArtifactBytes = 1024 * 1024;
const bundledRuntimePattern = /^xray(?:[-.].*)?$|^geo(?:ip|site)\.dat$/i;

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

// Runtime components come from the server plan; a DMG carrying them is a regression.
const appBundlePath = findAppBundle(path.join(desktopRoot, "src-tauri", "target"));
if (!appBundlePath) {
  missing.push("App bundle: src-tauri/target/*/release/bundle/macos/ChordV.app");
} else {
  for (const leaked of findFiles(path.join(appBundlePath, "Contents", "Resources"), bundledRuntimePattern)) {
    invalid.push(`Runtime component must not be bundled: ${path.relative(process.cwd(), leaked)}`);
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
console.log("- Runtime components: not bundled (delivered by server plan)");

function findAppBundle(targetDir) {
  if (!existsSync(targetDir)) {
    return null;
  }
  const candidates = readdirSync(targetDir)
    .map((triple) => path.join(targetDir, triple, "release", "bundle", "macos", "ChordV.app"))
    .filter((candidate) => existsSync(candidate));
  candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] ?? null;
}

function findFiles(directory, pattern) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findFiles(fullPath, pattern);
    }
    return pattern.test(entry.name) ? [fullPath] : [];
  });
}

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
