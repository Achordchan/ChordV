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
const platformConfig = withPlatformVersion(baseConfig, version);
const buildArgs = ["pnpm", "exec", "tauri", "build", "-c", path.relative(desktopRoot, tempConfigPath)];
const pnpmCommand = "corepack";

prepareBundledRuntimeResources(platform);
const bundledResources = buildBundledRuntimeResources(platform);
const macosGuideImagePath = path.join(desktopRoot, "public", "yindao.png");
const macosGuideImageConfigPath = "../public/yindao.png";
const macosGuideImageBundlePath = "yindao.png";
const bundleConfig = {
  ...baseConfig.bundle,
  resources: bundledResources,
  ...(platform === "windows" ? { targets: ["nsis"], createUpdaterArtifacts: true } : {})
};
if (platform === "windows" && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
  throw new Error("Windows 发布必须配置 TAURI_SIGNING_PRIVATE_KEY，禁止生成无签名更新包。");
}

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
  const targets = platform === "macos" ? ["darwin-arm64", "darwin-x64"] : ["win32-x64"];
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
    return [...common, "bin/xray-aarch64-apple-darwin", "bin/xray-x86_64-apple-darwin"];
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
  const signaturePath = `${artifact}.sig`;
  if (!fs.existsSync(signaturePath)) throw new Error("Windows 构建缺少 .sig 更新签名");
  fs.copyFileSync(signaturePath, `${targetPath}.sig`);
}

function cleanupCuratedArtifacts(outputDir, platform) {
  if (!fs.existsSync(outputDir)) {
    return;
  }
  const patterns =
    platform === "macos"
      ? [/^ChordV_.+\.dmg$/]
      : [/^ChordV_.+_x64\.exe$/, /^ChordV_.+_x64-setup\.exe$/, /^ChordV_.+_x64-full\.zip$/, /^ChordV_.+_x64-setup\.exe\.sig$/];
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (patterns.some((pattern) => pattern.test(entry.name))) {
      fs.rmSync(path.join(outputDir, entry.name), { force: true });
    }
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
