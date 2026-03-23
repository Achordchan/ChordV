import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  buildMacArtifactNames,
  buildWindowsArtifactNames,
  desktopRoot,
  normalizeDesktopPlatform,
  resolveDesktopPlatformVersion
} from "./platform-version.mjs";

const rawPlatform = process.argv[2];
if (!rawPlatform) {
  console.error("缺少平台参数，例如：macos、windows。");
  process.exit(1);
}

const platform = normalizeDesktopPlatform(rawPlatform);
if (platform !== "macos" && platform !== "windows") {
  console.error("当前脚本只负责桌面端 tauri 打包，请使用 macos 或 windows。");
  process.exit(1);
}

const version = resolveDesktopPlatformVersion(platform);
const extraArgs = process.argv.slice(3);
const projectRoot = path.resolve(desktopRoot, "..", "..");
const baseConfigPath = path.join(desktopRoot, "src-tauri", "tauri.conf.json");
const tempConfigPath = path.join(desktopRoot, "src-tauri", `.tauri.${platform}.platform.conf.json`);
const baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf8"));
const buildArgs = ["exec", "tauri", "build", "-c", path.relative(desktopRoot, tempConfigPath)];

fs.writeFileSync(
  tempConfigPath,
  `${JSON.stringify({ ...baseConfig, version }, null, 2)}\n`,
  "utf8"
);

if (platform === "macos" && !extraArgs.includes("--target") && !extraArgs.some((arg) => arg.startsWith("--target="))) {
  buildArgs.push("--target", "universal-apple-darwin");
}
if (platform === "windows" && !extraArgs.includes("--target") && !extraArgs.some((arg) => arg.startsWith("--target="))) {
  buildArgs.push("--runner", "cargo-xwin");
  buildArgs.push("--target", "x86_64-pc-windows-msvc");
}
buildArgs.push(...extraArgs);

cleanupBundleOutput(platform);

const result = spawnSync("pnpm", buildArgs, {
  cwd: desktopRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_APP_VERSION: version
  }
});

fs.rmSync(tempConfigPath, { force: true });
if ((result.status ?? 1) === 0) {
  curateReleaseArtifacts(platform, version, projectRoot);
}
process.exit(result.status ?? 1);

function curateReleaseArtifacts(platform, version, projectRoot) {
  const outputDir = path.join(projectRoot, "output", "release", platform === "macos" ? "macos" : "windows");
  fs.mkdirSync(outputDir, { recursive: true });
  removeStaleInstallerArtifacts(outputDir, platform);

  if (platform === "macos") {
    const artifact = findLatestArtifact(path.join(desktopRoot, "src-tauri", "target"), (filePath) => {
      return filePath.includes(`${path.sep}bundle${path.sep}dmg${path.sep}`) && filePath.endsWith(".dmg");
    });
    if (!artifact) {
      throw new Error("未找到 macOS DMG 产物");
    }
    const targetPath = path.join(outputDir, buildMacArtifactNames(version).dmg);
    fs.copyFileSync(artifact, targetPath);
    return;
  }

  const artifact = findLatestArtifact(path.join(desktopRoot, "src-tauri", "target"), (filePath) => {
    return filePath.includes(`${path.sep}bundle${path.sep}nsis${path.sep}`) && filePath.endsWith("-setup.exe");
  });
  if (!artifact) {
    throw new Error("未找到 Windows Setup 安装器产物");
  }
  const targetPath = path.join(outputDir, buildWindowsArtifactNames(version).setup);
  fs.copyFileSync(artifact, targetPath);
}

function removeStaleInstallerArtifacts(outputDir, platform) {
  const entries = fs.readdirSync(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === ".DS_Store") {
      fs.rmSync(path.join(outputDir, entry.name), { force: true });
      continue;
    }
    if (platform === "macos" && entry.name.endsWith(".dmg")) {
      fs.rmSync(path.join(outputDir, entry.name), { force: true });
      continue;
    }
    if (platform === "windows" && entry.name.endsWith(".exe")) {
      fs.rmSync(path.join(outputDir, entry.name), { force: true });
    }
  }
}

function cleanupBundleOutput(platform) {
  const targetRoot = path.join(desktopRoot, "src-tauri", "target");
  if (!fs.existsSync(targetRoot)) {
    return;
  }
  const cleanupPatterns =
    platform === "macos"
      ? [
          path.join(targetRoot, "release", "bundle"),
          path.join(targetRoot, "universal-apple-darwin", "release", "bundle")
        ]
      : [path.join(targetRoot, "x86_64-pc-windows-msvc", "release", "bundle")];

  for (const candidate of cleanupPatterns) {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

function findLatestArtifact(rootDir, predicate) {
  if (!fs.existsSync(rootDir)) {
    return null;
  }
  const queue = [rootDir];
  let latest = null;
  let latestMtime = 0;

  while (queue.length > 0) {
    const currentDir = queue.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!predicate(fullPath)) {
        continue;
      }
      const mtime = fs.statSync(fullPath).mtimeMs;
      if (!latest || mtime > latestMtime) {
        latest = fullPath;
        latestMtime = mtime;
      }
    }
  }

  return latest;
}
