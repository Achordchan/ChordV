import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const tauriRoot = path.join(desktopRoot, "src-tauri");
const binDir = path.join(tauriRoot, "bin");
const outputDir = path.resolve(desktopRoot, "..", "..", "output", "release", "windows");

const requiredResources = [
  path.join(binDir, "xray-x86_64-pc-windows-msvc.exe"),
  path.join(binDir, "geoip.dat"),
  path.join(binDir, "geosite.dat")
];

const missingResources = requiredResources.filter((item) => !existsSync(item));
if (missingResources.length > 0) {
  console.error("Windows 资源缺失：");
  for (const item of missingResources) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

const windowsArtifacts = [
  path.join(outputDir, "ChordV.exe"),
  path.join(outputDir, "ChordV_0.1.0_x64-setup.exe")
];

const foundArtifacts = windowsArtifacts.filter((item) => existsSync(item));

console.log("Windows 资源检查通过：");
for (const item of requiredResources) {
  console.log(`- ${path.relative(process.cwd(), item)}`);
}

if (foundArtifacts.length === 0) {
  console.warn("未发现 Windows 打包产物，当前只验证了资源目录。");
  console.warn(`建议打包后再次执行：node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`);
  process.exit(0);
}

console.log("Windows 打包产物：");
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
