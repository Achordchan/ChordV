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
const pnpmCommand = "pnpm";

prepareBundledRuntimeResources(platform);
const bundledResources = buildBundledRuntimeResources(platform);
const macosGuideImagePath = path.join(desktopRoot, "public", "yindao.png");
const macosGuideImageConfigPath = "../public/yindao.png";
const macosGuideImageBundlePath = "yindao.png";
const bundleConfig = {
  ...baseConfig.bundle,
  resources: bundledResources
};

if (platform === "macos" && fs.existsSync(macosGuideImagePath)) {
  bundleConfig.resources = {
    ...Object.fromEntries(bundledResources.map((resource) => [resource, resource])),
    [macosGuideImageConfigPath]: macosGuideImageBundlePath
  };
  bundleConfig.macOS = {
    ...bundleConfig.macOS,
    dmg: {
      ...(bundleConfig.macOS?.dmg ?? {}),
      windowSize: { width: 760, height: 520 },
      appPosition: { x: 160, y: 190 },
      applicationFolderPosition: { x: 600, y: 190 }
    }
  };
}

fs.writeFileSync(
  tempConfigPath,
  `${JSON.stringify({ ...baseConfig, version, bundle: bundleConfig }, null, 2)}\n`,
  "utf8"
);

if (platform === "macos" && !extraArgs.includes("--target") && !extraArgs.some((arg) => arg.startsWith("--target="))) {
  buildArgs.push("--target", "aarch64-apple-darwin");
}
if (platform === "windows" && !extraArgs.includes("--target") && !extraArgs.some((arg) => arg.startsWith("--target="))) {
  buildArgs.push("--runner", "cargo-xwin");
  buildArgs.push("--target", "x86_64-pc-windows-msvc");
}
buildArgs.push(...extraArgs);

cleanupBundleOutput(platform);

console.log(`执行打包命令：${pnpmCommand} ${buildArgs.join(" ")}`);

const result = spawnSync(pnpmCommand, buildArgs, {
  cwd: desktopRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    VITE_APP_VERSION: version
  }
});

fs.rmSync(tempConfigPath, { force: true });
if (result.error) {
  console.error(`启动打包命令失败：${result.error.message}`);
  process.exit(1);
}
if ((result.status ?? 1) === 0) {
  curateReleaseArtifacts(platform, version, projectRoot);
}
process.exit(result.status ?? 1);

function prepareBundledRuntimeResources(platform) {
  const setupScript = path.join(desktopRoot, "scripts", "setup-xray.mjs");
  const targets = platform === "macos" ? ["darwin-arm64"] : ["win32-x64"];
  for (const target of targets) {
    const result = spawnSync("node", [setupScript], {
      cwd: desktopRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        CHORDV_XRAY_TARGET: target
      }
    });
    if ((result.status ?? 1) !== 0) {
      throw new Error(`准备内置运行时资源失败：${target}`);
    }
  }
}

function buildBundledRuntimeResources(platform) {
  const common = ["bin/geoip.dat", "bin/geosite.dat"];
  if (platform === "macos") {
    return [...common, "bin/xray-aarch64-apple-darwin"];
  }
  return [...common, "bin/xray.exe"];
}

function curateReleaseArtifacts(platform, version, projectRoot) {
  const outputDir = path.join(projectRoot, "output", "release", platform === "macos" ? "macos" : "windows");
  fs.mkdirSync(outputDir, { recursive: true });

  if (platform === "macos") {
    const artifact = findLatestArtifact(path.join(desktopRoot, "src-tauri", "target"), (filePath) => {
      return filePath.includes(`${path.sep}bundle${path.sep}dmg${path.sep}`) && filePath.endsWith(".dmg");
    });
    if (!artifact) {
      throw new Error("未找到 macOS DMG 产物");
    }
    const targetPath = path.join(outputDir, buildMacArtifactNames(version).dmg);
    fs.copyFileSync(artifact, targetPath);
    appendMacGuideImageToDmg(targetPath);
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

function appendMacGuideImageToDmg(dmgPath) {
  const sourcePath = path.join(desktopRoot, "public", "yindao.png");
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  const tempWritablePath = path.join(path.dirname(dmgPath), `.${path.basename(dmgPath, ".dmg")}.rw.dmg`);
  const finalTempPath = path.join(path.dirname(dmgPath), `.${path.basename(dmgPath, ".dmg")}.final.dmg`);
  fs.rmSync(tempWritablePath, { force: true });
  fs.rmSync(finalTempPath, { force: true });

  runCommand("hdiutil", ["convert", dmgPath, "-format", "UDRW", "-o", tempWritablePath]);
  const attach = runCommand("hdiutil", ["attach", tempWritablePath, "-readwrite", "-nobrowse", "-plist"], {
    capture: true
  });
  const mountPoint = readMountedDmgPath(attach.stdout);
  try {
    const guideImagePath = path.join(mountPoint, "01-使用引导.png");
    fs.copyFileSync(sourcePath, guideImagePath);
  } finally {
    runCommand("hdiutil", ["detach", mountPoint]);
  }
  runCommand("hdiutil", ["convert", tempWritablePath, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", finalTempPath]);
  fs.rmSync(dmgPath, { force: true });
  fs.renameSync(finalTempPath, dmgPath);
  fs.rmSync(tempWritablePath, { force: true });
}

function readMountedDmgPath(plistOutput) {
  const matches = [...plistOutput.matchAll(/<key>mount-point<\/key>\s*<string>(.*?)<\/string>/g)];
  const mountPoint = matches.at(-1)?.[1];
  if (!mountPoint) {
    throw new Error("无法读取 DMG 挂载路径");
  }
  return mountPoint
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} 执行失败`);
  }
  return result;
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
          path.join(targetRoot, "aarch64-apple-darwin", "release", "bundle")
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
