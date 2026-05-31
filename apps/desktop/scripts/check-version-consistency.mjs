import fs from "node:fs";
import path from "node:path";
import { desktopPlatformVersions, desktopRoot } from "./platform-version.mjs";

const projectRoot = path.resolve(desktopRoot, "..", "..");
const expectedVersion = normalizeExpectedVersion(process.argv[2]);

const checks = [
  ["root package.json", readJson(path.join(projectRoot, "package.json")).version],
  ["desktop package.json", readJson(path.join(desktopRoot, "package.json")).version],
  ["tauri.conf.json", readJson(path.join(desktopRoot, "src-tauri", "tauri.conf.json")).version],
  ["platform-versions.json macos", desktopPlatformVersions.macos],
  ["platform-versions.json windows", desktopPlatformVersions.windows]
];

const mismatches = checks.filter(([, actual]) => actual !== expectedVersion);
if (mismatches.length > 0) {
  console.error(`Desktop release version mismatch. Expected ${expectedVersion}.`);
  for (const [label, actual] of mismatches) {
    console.error(`- ${label}: ${actual ?? "(missing)"}`);
  }
  process.exit(1);
}

console.log(`Desktop release version consistency verified: ${expectedVersion}`);

function normalizeExpectedVersion(raw) {
  const value = (raw ?? process.env.GITHUB_REF_NAME ?? "").trim().replace(/^v(?=\d)/i, "");
  if (!value) {
    throw new Error("Expected version is required.");
  }
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
