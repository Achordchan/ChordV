import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename, chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const tauriRoot = path.join(desktopRoot, "src-tauri");
const binDir = path.join(tauriRoot, "bin");

const targetMap = {
  "darwin-arm64": {
    platform: "macos",
    architecture: "arm64",
    binaryOutputName: "xray-aarch64-apple-darwin",
    executable: true
  },
  "darwin-x64": {
    platform: "macos",
    architecture: "x64",
    binaryOutputName: "xray-x86_64-apple-darwin",
    executable: true
  },
  "win32-x64": {
    platform: "windows",
    architecture: "x64",
    binaryOutputName: "xray.exe",
    executable: false
  },
  "android-arm64": {
    platform: "android",
    architecture: "arm64",
    binaryOutputName: "xray-aarch64-linux-android",
    executable: true
  }
};

const targetOverride = process.env.CHORDV_XRAY_TARGET?.trim();
const key = targetOverride || `${process.platform}-${process.arch}`;
const target = targetMap[key];

if (!target) {
  console.error(`当前平台不支持自动准备 xray 资源：${key}`);
  process.exit(1);
}

if (target.platform === "android") {
  console.error("当前脚本暂不负责 Android 运行时资源。");
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
cleanupLegacyBundledBinaryNames(target);

const apiBaseUrl = resolveApiBaseUrl();
const tempRoot = path.join(tmpdir(), `chordv-runtime-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });

try {
  const plan = await fetchRuntimeComponentsPlan(target.platform, target.architecture);
  const components = indexPlanComponents(plan.components);
  const requiredKinds = ["xray", "geoip", "geosite"];

  for (const kind of requiredKinds) {
    const component = components.get(kind);
    if (!component) {
      throw new Error(`后台运行时计划缺少组件：${kind}`);
    }
    const outputPath =
      kind === "xray"
        ? path.join(binDir, target.binaryOutputName)
        : path.join(binDir, `${kind}.dat`);

    if (isOutputReady(outputPath, component)) {
      console.log(`${kind} 资源已匹配后台计划：${outputPath}`);
      continue;
    }

    const tempDownloadPath = path.join(tempRoot, `${kind}-${Date.now()}.download`);
    console.log(`下载 ${kind}：${component.resolvedUrl}`);
    await downloadFile(component.resolvedUrl, tempDownloadPath);
    await verifyDownloadedFile(tempDownloadPath, component, kind);

    rmSync(outputPath, { force: true });
    await rename(tempDownloadPath, outputPath);
    if (kind === "xray" && target.executable) {
      await chmod(outputPath, 0o755);
    }
    console.log(`${kind} 已安装：${outputPath}`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function resolveApiBaseUrl() {
  const configured =
    process.env.CHORDV_API_BASE_URL?.trim() ||
    process.env.VITE_API_BASE_URL?.trim() ||
    process.env.CHORDV_PUBLIC_BASE_URL?.trim() ||
    "https://v.baymaxgroup.com";
  return configured.replace(/\/+$/, "");
}

async function fetchRuntimeComponentsPlan(platform, architecture) {
  const url = `${apiBaseUrl}/api/client/runtime-components/plan?platform=${encodeURIComponent(platform)}&architecture=${encodeURIComponent(architecture)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`获取运行时计划失败：HTTP ${response.status}`);
  }
  return response.json();
}

function indexPlanComponents(components) {
  const map = new Map();
  for (const component of components ?? []) {
    map.set(component.kind, component);
  }
  return map;
}

function isOutputReady(outputPath, component) {
  if (!existsSync(outputPath)) {
    return false;
  }
  if (!component.expectedHash && !component.fileSizeBytes) {
    return true;
  }
  const fileStat = statSync(outputPath);
  if (component.fileSizeBytes && BigInt(fileStat.size) !== BigInt(component.fileSizeBytes)) {
    return false;
  }
  if (component.expectedHash) {
    return computeSha256(outputPath) === component.expectedHash.toLowerCase();
  }
  return true;
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(outputPath, buffer);
}

async function verifyDownloadedFile(filePath, component, kind) {
  const fileStat = statSync(filePath);
  if (component.fileSizeBytes && BigInt(fileStat.size) !== BigInt(component.fileSizeBytes)) {
    await safeUnlink(filePath);
    throw new Error(`${kind} 文件大小与后台计划不一致`);
  }
  if (component.expectedHash) {
    const actual = computeSha256(filePath);
    if (actual !== component.expectedHash.toLowerCase()) {
      await safeUnlink(filePath);
      throw new Error(`${kind} 文件哈希与后台计划不一致`);
    }
  }
}

function computeSha256(filePath) {
  const hash = createHash("sha256");
  return hash.update(readFileSync(filePath)).digest("hex");
}

async function safeUnlink(filePath) {
  try {
    await unlink(filePath);
  } catch {}
}

function cleanupLegacyBundledBinaryNames(currentTarget) {
  const legacyNames = currentTarget.platform === "windows" ? ["xray-x86_64-pc-windows-msvc.exe"] : [];
  for (const name of legacyNames) {
    const filePath = path.join(binDir, name);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }
}
