import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, rename, chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const tauriRoot = path.join(desktopRoot, "src-tauri");
const binDir = path.join(tauriRoot, "bin");
const planTimeoutMs = 30_000;
const downloadTimeoutMs = 180_000;
const minimumXrayBytes = 1024 * 1024;
const minimumGeoDataBytes = 64 * 1024;

const targetMap = {
  "darwin-arm64": {
    platform: "macos",
    architecture: "arm64",
    binaryOutputName: "xray-aarch64-apple-darwin",
    executable: true,
    defaultArchiveEntryNames: ["xray", "xray-macos-arm64-v8a"]
  },
  "darwin-x64": {
    platform: "macos",
    architecture: "x64",
    binaryOutputName: "xray-x86_64-apple-darwin",
    executable: true,
    defaultArchiveEntryNames: ["xray", "xray-macos-64"]
  },
  "win32-x64": {
    platform: "windows",
    architecture: "x64",
    binaryOutputName: "xray.exe",
    executable: false,
    defaultArchiveEntryNames: ["xray.exe"]
  },
  "android-arm64": {
    platform: "android",
    architecture: "arm64",
    binaryOutputName: "xray-aarch64-linux-android",
    executable: true,
    defaultArchiveEntryNames: ["xray", "libxray.so"]
  }
};

const targetOverride = process.env.CHORDV_XRAY_TARGET?.trim();
const key = targetOverride || `${process.platform}-${process.arch}`;
const target = targetMap[key];

if (!target) {
  console.error(`Unsupported platform for setup-xray: ${key}`);
  process.exit(1);
}

if (target.platform === "android") {
  console.error("This script does not prepare Android runtime assets.");
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
      throw new Error(`Runtime plan missing component: ${kind}`);
    }

    const outputPath =
      kind === "xray"
        ? path.join(binDir, target.binaryOutputName)
        : path.join(binDir, `${kind}.dat`);

    if (isOutputReady(outputPath, component, kind)) {
      console.log(`${kind} already ready: ${outputPath}`);
      continue;
    }

    const candidates = collectDownloadCandidates(component);
    let lastError = null;
    let installed = false;

    for (const candidate of candidates) {
      const tempDownloadPath = path.join(tempRoot, `${kind}-${Date.now()}.download`);
      try {
        console.log(`Downloading ${kind}: ${candidate}`);
        await downloadFile(candidate, tempDownloadPath);
        await materializeComponentFile({
          kind,
          component,
          downloadPath: tempDownloadPath,
          outputPath
        });
        if (kind === "xray" && target.executable) {
          await chmod(outputPath, 0o755);
        }
        console.log(`${kind} installed: ${outputPath}`);
        installed = true;
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `${kind} candidate failed: ${candidate} -> ${error instanceof Error ? error.message : String(error)}`
        );
        await safeUnlink(tempDownloadPath);
      }
    }

    if (!installed) {
      throw lastError instanceof Error ? lastError : new Error(`${kind} download failed`);
    }
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
    signal: AbortSignal.timeout(planTimeoutMs),
    headers: {
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch runtime plan: HTTP ${response.status}`);
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

function collectDownloadCandidates(component) {
  const urls = [];
  const push = (value) => {
    const normalized = String(value ?? "").trim();
    if (!normalized || urls.includes(normalized)) {
      return;
    }
    urls.push(normalized);
  };

  for (const candidate of component.candidates ?? []) {
    push(candidate?.url);
  }
  push(component.resolvedUrl);
  push(component.originUrl);
  return urls;
}

function isOutputReady(outputPath, component, kind) {
  if (!existsSync(outputPath)) {
    return false;
  }
  try {
    validateInstalledComponent(outputPath, kind);
  } catch {
    return false;
  }
  if (!component.fileSizeBytes) {
    return true;
  }
  const fileStat = statSync(outputPath);
  if (component.fileSizeBytes && BigInt(fileStat.size) !== BigInt(component.fileSizeBytes)) {
    // Remote plan size often points to zip, not the extracted binary.
    return looksLikeZipDownload(component);
  }
  return true;
}

function looksLikeZipDownload(component) {
  if (String(component.archiveEntryName ?? "").trim()) {
    return true;
  }
  const names = [component.fileName, component.originUrl, component.resolvedUrl].map((value) =>
    String(value ?? "").toLowerCase()
  );
  return names.some((value) => value.includes(".zip"));
}

async function materializeComponentFile({ kind, component, downloadPath, outputPath }) {
  const isZip = isZipFile(downloadPath) || looksLikeZipDownload(component);
  if (!isZip) {
    await verifyDownloadedFile(downloadPath, component, kind);
    validateInstalledComponent(downloadPath, kind);
    rmSync(outputPath, { force: true });
    await moveFile(downloadPath, outputPath);
    return;
  }

  const entryHints = [
    String(component.archiveEntryName ?? "").trim(),
    kind === "xray" ? target.binaryOutputName : `${kind}.dat`,
    ...(kind === "xray" ? target.defaultArchiveEntryNames : []),
    kind === "geoip" ? "geoip.dat" : "",
    kind === "geosite" ? "geosite.dat" : ""
  ].filter(Boolean);

  const extractedPath = path.join(path.dirname(downloadPath), `${kind}-extracted-${Date.now()}`);
  await extractPreferredZipEntry(downloadPath, extractedPath, entryHints);
  validateInstalledComponent(extractedPath, kind);
  rmSync(outputPath, { force: true });
  await moveFile(extractedPath, outputPath);
  await safeUnlink(downloadPath);
}

function isZipFile(filePath) {
  try {
    const header = readFileSync(filePath).subarray(0, 4);
    return (
      header[0] === 0x50 &&
      header[1] === 0x4b &&
      (header[2] === 0x03 || header[2] === 0x05 || header[2] === 0x07)
    );
  } catch {
    return false;
  }
}

async function extractPreferredZipEntry(zipPath, outputPath, entryHints) {
  const extractRoot = path.join(path.dirname(outputPath), `zip-extract-${Date.now()}`);
  mkdirSync(extractRoot, { recursive: true });
  // PowerShell Expand-Archive only accepts .zip extension.
  const normalizedZipPath = zipPath.toLowerCase().endsWith(".zip")
    ? zipPath
    : `${zipPath}.zip`;
  try {
    if (normalizedZipPath !== zipPath) {
      await copyFile(zipPath, normalizedZipPath);
    }
    extractZipArchive(normalizedZipPath, extractRoot);
    const candidates = listFilesRecursive(extractRoot);
    if (candidates.length === 0) {
      throw new Error("zip archive has no files");
    }

    const normalizedHints = entryHints.map((value) => value.replace(/\\/g, "/").toLowerCase());
    let matched =
      candidates.find((filePath) => {
        const relative = path.relative(extractRoot, filePath).replace(/\\/g, "/").toLowerCase();
        const base = path.basename(filePath).toLowerCase();
        return normalizedHints.some(
          (hint) => relative === hint || relative.endsWith(`/${hint}`) || base === hint
        );
      }) ?? null;

    if (!matched) {
      matched =
        candidates.find((filePath) => {
          const base = path.basename(filePath).toLowerCase();
          return base === "xray.exe" || base === "xray" || base === "geoip.dat" || base === "geosite.dat";
        }) ?? null;
    }

    if (!matched) {
      throw new Error(`zip entry not found: ${entryHints.join(", ")}`);
    }

    rmSync(outputPath, { force: true });
    await copyFile(matched, outputPath);
  } finally {
    if (normalizedZipPath !== zipPath) {
      rmSync(normalizedZipPath, { force: true });
    }
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

function extractZipArchive(zipPath, extractRoot) {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath ${quotePowerShell(zipPath)} -DestinationPath ${quotePowerShell(extractRoot)} -Force`
      ],
      { encoding: "utf8" }
    );
    if ((result.status ?? 1) !== 0) {
      throw new Error(result.stderr?.trim() || result.stdout?.trim() || "Expand-Archive failed");
    }
    return;
  }

  const result = spawnSync("unzip", ["-o", zipPath, "-d", extractRoot], { encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "unzip failed");
  }
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function listFilesRecursive(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

async function downloadFile(url, outputPath) {
  // Prefer curl in CI; Node fetch can hang on some mirror paths.
  if (await tryDownloadWithCurl(url, outputPath)) {
    return;
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(downloadTimeoutMs),
    redirect: "follow"
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 64) {
    throw new Error(`download too small: ${buffer.length} bytes`);
  }
  writeFileSync(outputPath, buffer);
}

async function tryDownloadWithCurl(url, outputPath) {
  const curlBin = process.platform === "win32" ? "curl.exe" : "curl";
  const result = spawnSync(
    curlBin,
    [
      "-fsSL",
      "--connect-timeout",
      "20",
      "--max-time",
      String(Math.ceil(downloadTimeoutMs / 1000)),
      "-o",
      outputPath,
      url
    ],
    { encoding: "utf8" }
  );
  if ((result.status ?? 1) !== 0) {
    await safeUnlink(outputPath);
    return false;
  }
  if (!existsSync(outputPath) || statSync(outputPath).size < 64) {
    await safeUnlink(outputPath);
    return false;
  }
  return true;
}

async function verifyDownloadedFile(filePath, component, kind) {
  const fileStat = statSync(filePath);
  if (
    component.fileSizeBytes &&
    BigInt(fileStat.size) !== BigInt(component.fileSizeBytes) &&
    !looksLikeZipDownload(component)
  ) {
    await safeUnlink(filePath);
    throw new Error(`${kind} size does not match runtime plan`);
  }
}

function validateInstalledComponent(filePath, kind) {
  const size = statSync(filePath).size;
  if (kind === "xray") {
    if (size < minimumXrayBytes) {
      throw new Error(`xray too small: ${size}`);
    }
    if (target.platform === "windows") {
      const header = readFileSync(filePath).subarray(0, 2).toString("ascii");
      if (header !== "MZ") {
        throw new Error("xray is not a valid Windows PE executable");
      }
    } else {
      const header = readFileSync(filePath).subarray(0, 4);
      const isElf = header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
      const isMachO =
        (header[0] === 0xcf && header[1] === 0xfa && header[2] === 0xed && header[3] === 0xfe) ||
        (header[0] === 0xce && header[1] === 0xfa && header[2] === 0xed && header[3] === 0xfe) ||
        (header[0] === 0xca && header[1] === 0xfe && header[2] === 0xba && header[3] === 0xbe) ||
        (header[0] === 0xfe && header[1] === 0xed && header[2] === 0xfa && header[3] === 0xce) ||
        (header[0] === 0xfe && header[1] === 0xed && header[2] === 0xfa && header[3] === 0xcf);
      if (!isElf && !isMachO) {
        throw new Error("xray is not a valid executable");
      }
    }
    return;
  }

  if (size < minimumGeoDataBytes) {
    throw new Error(`${kind} too small: ${size}`);
  }
}

async function safeUnlink(filePath) {
  try {
    await unlink(filePath);
  } catch {}
}

async function moveFile(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EXDEV") {
      await copyFile(source, destination);
      await unlink(source);
      return;
    }
    throw error;
  }
}

function cleanupLegacyBundledBinaryNames(currentTarget) {
  const legacyNames =
    currentTarget.platform === "windows"
      ? ["xray-x86_64-pc-windows-msvc.exe"]
      : ["xray", "xray-aarch64-apple-darwin.bak", "xray-x86_64-apple-darwin.bak"];
  for (const name of legacyNames) {
    const filePath = path.join(binDir, name);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }
}