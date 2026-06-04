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
const minimumPeBytes = 1024 * 1024;
const minimumGeoDataBytes = 64 * 1024;
const baseConfigPath = path.join(desktopRoot, "src-tauri", "tauri.conf.json");
const tempConfigPath = path.join(desktopRoot, "src-tauri", `.tauri.${platform}.platform.conf.json`);
const baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf8"));
const platformConfig = withPlatformVersion(baseConfig, version);
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
  `${JSON.stringify({ ...platformConfig, bundle: bundleConfig }, null, 2)}\n`,
  "utf8"
);

if (platform === "macos" && !extraArgs.includes("--target") && !extraArgs.some((arg) => arg.startsWith("--target="))) {
  buildArgs.push("--target", "universal-apple-darwin");
}
if (platform === "windows" && !extraArgs.includes("--target") && !extraArgs.some((arg) => arg.startsWith("--target="))) {
  assertCommandAvailable("cargo-xwin", ["--version"], "cargo install cargo-xwin --locked");
  buildArgs.push("--runner", "cargo-xwin");
  buildArgs.push("--target", "x86_64-pc-windows-msvc");
}
buildArgs.push(...extraArgs);

cleanupBundleOutput(platform);

console.log(`执行打包命令：${pnpmCommand} ${buildArgs.join(" ")}`);

const buildStartedAt = Date.now();
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
  curateReleaseArtifacts(platform, version, projectRoot, buildStartedAt);
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

function withPlatformVersion(config, version) {
  const title = `ChordV ${formatWindowVersion(version)}`;
  return {
    ...config,
    version,
    app: {
      ...config.app,
      windows: (config.app?.windows ?? []).map((windowConfig, index) => ({
        ...windowConfig,
        title: index === 0 ? title : windowConfig.title
      }))
    }
  };
}

function formatWindowVersion(version) {
  const normalized = String(version ?? "").trim();
  if (!normalized) {
    return "v-";
  }
  return normalized.toLowerCase().startsWith("v") ? normalized : `v${normalized}`;
}

function buildBundledRuntimeResources(platform) {
  const common = ["bin/geoip.dat", "bin/geosite.dat"];
  if (platform === "macos") {
    return [...common, "bin/xray-aarch64-apple-darwin"];
  }
  return [...common, "bin/xray.exe"];
}

function curateReleaseArtifacts(platform, version, projectRoot, buildStartedAt) {
  const outputDir = path.join(projectRoot, "output", "release", platform === "macos" ? "macos" : "windows");
  fs.mkdirSync(outputDir, { recursive: true });
  cleanupCuratedArtifacts(outputDir, platform);

  if (platform === "macos") {
    const artifact = findLatestArtifact(path.join(desktopRoot, "src-tauri", "target"), (filePath) => {
      return filePath.includes(`${path.sep}bundle${path.sep}dmg${path.sep}`) && filePath.endsWith(".dmg");
    }, buildStartedAt);
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
  }, buildStartedAt);
  if (!artifact) {
    throw new Error("未找到 Windows Setup 安装器产物");
  }
  const targetPath = path.join(outputDir, buildWindowsArtifactNames(version).setup);
  fs.copyFileSync(artifact, targetPath);
  createWindowsFullUpdateZip(version, outputDir, buildStartedAt);
}

function cleanupCuratedArtifacts(outputDir, platform) {
  if (!fs.existsSync(outputDir)) {
    return;
  }
  const patterns =
    platform === "macos"
      ? [/^ChordV_.+\.dmg$/]
      : [/^ChordV_.+_x64\.exe$/, /^ChordV_.+_x64-setup\.exe$/, /^ChordV_.+_x64-full\.zip$/];
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (patterns.some((pattern) => pattern.test(entry.name))) {
      fs.rmSync(path.join(outputDir, entry.name), { force: true });
    }
  }
}

function createWindowsFullUpdateZip(version, outputDir, buildStartedAt) {
  const artifactNames = buildWindowsArtifactNames(version);
  const releaseDir = path.join(desktopRoot, "src-tauri", "target", "x86_64-pc-windows-msvc", "release");
  const sourceExe = findWindowsReleaseExecutable(releaseDir, buildStartedAt);
  if (!sourceExe) {
    throw new Error("未找到 Windows release 可执行文件，无法生成全量更新 ZIP。");
  }

  const stagingDir = path.join(outputDir, `.${artifactNames.fullZip}.staging`);
  const fullZipPath = path.join(outputDir, artifactNames.fullZip);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.rmSync(fullZipPath, { force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const sourceExeName = path.basename(sourceExe);
    fs.copyFileSync(sourceExe, path.join(stagingDir, sourceExeName));
    for (const aliasName of ["ChordV.exe", "chordv-desktop.exe"]) {
      if (aliasName !== sourceExeName) {
        fs.copyFileSync(sourceExe, path.join(stagingDir, aliasName));
      }
    }

    const sourceBinDir = path.join(desktopRoot, "src-tauri", "bin");
    const stagingBinDir = path.join(stagingDir, "bin");
    fs.mkdirSync(stagingBinDir, { recursive: true });
    for (const resource of buildBundledRuntimeResources("windows")) {
      const sourcePath = path.join(desktopRoot, "src-tauri", resource);
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`缺少 Windows 全量更新资源：${resource}`);
      }
      const sourceStat = fs.statSync(sourcePath);
      if (!sourceStat.isFile()) {
        throw new Error(`Windows full update resource is empty or invalid: ${resource}`);
      }
      validateWindowsFullUpdateResource(sourcePath, resource);
      const relativePath = path.relative(sourceBinDir, sourcePath);
      const targetPath = path.join(stagingBinDir, relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }

    createZipFromDirectory(stagingDir, fullZipPath);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function validateWindowsFullUpdateResource(sourcePath, resource) {
  const size = fs.statSync(sourcePath).size;
  if (resource === "bin/xray.exe") {
    if (size < minimumPeBytes) {
      throw new Error(`Windows full update resource is too small: ${resource}`);
    }
    const header = fs.readFileSync(sourcePath).subarray(0, 2).toString("ascii");
    if (header !== "MZ") {
      throw new Error(`Windows full update resource is not a PE executable: ${resource}`);
    }
    return;
  }
  if ((resource === "bin/geoip.dat" || resource === "bin/geosite.dat") && size < minimumGeoDataBytes) {
    throw new Error(`Windows full update resource is too small: ${resource}`);
  }
}

function findWindowsReleaseExecutable(releaseDir, buildStartedAt) {
  const preferred = ["ChordV.exe", "chordv-desktop.exe"].map((name) => path.join(releaseDir, name));
  for (const candidate of preferred) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).mtimeMs >= buildStartedAt) {
      return candidate;
    }
  }
  if (!fs.existsSync(releaseDir)) {
    return null;
  }
  const candidates = fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => path.join(releaseDir, entry.name))
    .filter((filePath) => fs.statSync(filePath).mtimeMs >= buildStartedAt)
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0] ?? null;
}

function createZipFromDirectory(sourceDir, targetZipPath) {
  if (process.platform === "win32") {
    runCommand("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$sourceDir = $env:CHORDV_ZIP_SOURCE; $targetZipPath = $env:CHORDV_ZIP_TARGET; if (-not $sourceDir -or -not $targetZipPath) { throw 'missing ZIP source or target path' }; Compress-Archive -Path (Join-Path $sourceDir '*') -DestinationPath $targetZipPath -Force"
    ], {
      env: {
        ...process.env,
        CHORDV_ZIP_SOURCE: sourceDir,
        CHORDV_ZIP_TARGET: targetZipPath
      }
    });
    return;
  }

  const zipResult = spawnSync("zip", ["-r", targetZipPath, "."], {
    cwd: sourceDir,
    stdio: "inherit"
  });
  if (zipResult.error) {
    throw zipResult.error;
  }
  if ((zipResult.status ?? 1) !== 0) {
    throw new Error("zip 执行失败，无法生成 Windows 全量更新 ZIP。");
  }
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
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: options.env ?? process.env
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} 执行失败`);
  }
  return result;
}

function assertCommandAvailable(command, args, installHint) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    encoding: "utf8",
    stdio: "ignore",
    shell: process.platform === "win32"
  });
  if (result.error || (result.status ?? 1) !== 0) {
    throw new Error(`${command} is required for this build. Install it with: ${installHint}`);
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

function findLatestArtifact(rootDir, predicate, minMtimeMs = 0) {
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
      const mtime = fs.statSync(fullPath).mtimeMs;
      if (!predicate(fullPath) || mtime < minMtimeMs) {
        continue;
      }
      if (!latest || mtime > latestMtime) {
        latest = fullPath;
        latestMtime = mtime;
      }
    }
  }

  return latest;
}
