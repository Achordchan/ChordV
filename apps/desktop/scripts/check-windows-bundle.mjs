import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWindowsArtifactNames, resolveDesktopPlatformVersion } from "./platform-version.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const outputDir = path.resolve(desktopRoot, "..", "..", "output", "release", "windows");

const windowsVersion = resolveDesktopPlatformVersion("windows");
const windowsArtifactNames = buildWindowsArtifactNames(windowsVersion);
const windowsArtifacts = [
  path.join(outputDir, windowsArtifactNames.setup)
];

const foundArtifacts = windowsArtifacts.filter((item) => existsSync(item));

if (foundArtifacts.length === 0) {
  console.warn("未发现 Windows 安装器产物。");
  console.warn(`建议打包后再次执行：node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`);
  process.exit(0);
}

console.log("Windows 安装器产物：");
for (const item of foundArtifacts) {
  const size = statSync(item).size;
  console.log(`- ${path.relative(process.cwd(), item)} (${formatSize(size)})`);
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
