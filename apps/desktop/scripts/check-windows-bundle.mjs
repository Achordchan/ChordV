import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildWindowsArtifactNames, desktopRoot, resolveDesktopPlatformVersion } from "./platform-version.mjs";

const outputDir = path.resolve(desktopRoot, "..", "..", "output", "release", "windows");
const windowsVersion = resolveDesktopPlatformVersion("windows");
const windowsArtifactNames = buildWindowsArtifactNames(windowsVersion);
const minimumArtifactBytes = 1024 * 1024;
const minimumPeBytes = 1024 * 1024;
const minimumGeoDataBytes = 64 * 1024;
const windowsArtifacts = [
  {
    label: "Setup installer",
    path: path.join(outputDir, windowsArtifactNames.setup)
  },
  {
    label: "Full update ZIP",
    path: path.join(outputDir, windowsArtifactNames.fullZip)
  }
];

const missingArtifacts = windowsArtifacts.filter((item) => !existsSync(item.path));
const smallArtifacts = windowsArtifacts.filter((item) => existsSync(item.path) && statSync(item.path).size < minimumArtifactBytes);
const foundArtifacts = windowsArtifacts.filter((item) => existsSync(item.path));
const expectedArtifactNames = new Set([windowsArtifactNames.setup, windowsArtifactNames.fullZip]);
const staleArtifacts = existsSync(outputDir)
  ? readdirSync(outputDir)
      .filter((name) => /^ChordV_.+_x64(?:-setup|-full)?\.(?:exe|zip)$/i.test(name))
      .filter((name) => !expectedArtifactNames.has(name))
      .map((name) => path.join(outputDir, name))
  : [];

if (missingArtifacts.length > 0 || smallArtifacts.length > 0 || staleArtifacts.length > 0) {
  console.error(`Windows ${windowsVersion} release artifacts are incomplete.`);
  for (const item of missingArtifacts) {
    console.error(`- Missing ${item.label}: ${path.relative(process.cwd(), item.path)}`);
  }
  for (const item of smallArtifacts) {
    console.error(`- Suspiciously small ${item.label}: ${path.relative(process.cwd(), item.path)} (${formatSize(statSync(item.path).size)})`);
  }
  for (const item of staleArtifacts) {
    console.error(`- Stale artifact must be removed: ${path.relative(process.cwd(), item)}`);
  }
  console.error("Run: corepack pnpm --filter @chordv/desktop tauri:build:platform windows");
  process.exit(1);
}

validateFullUpdateZip(path.join(outputDir, windowsArtifactNames.fullZip), windowsVersion);
validateExecutableProductVersion(path.join(outputDir, windowsArtifactNames.setup), windowsVersion, "Setup installer");

console.log(`Windows ${windowsVersion} release artifacts:`);
for (const item of foundArtifacts) {
  const size = statSync(item.path).size;
  console.log(`- ${item.label}: ${path.relative(process.cwd(), item.path)} (${formatSize(size)})`);
}

function validateFullUpdateZip(zipPath, version) {
  const extractDir = mkdtempSync(path.join(tmpdir(), "chordv-full-zip-"));
  try {
    runPowerShell([
      "Expand-Archive",
      "-LiteralPath",
      quotePowerShell(zipPath),
      "-DestinationPath",
      quotePowerShell(extractDir),
      "-Force"
    ].join(" "));
    const required = ["bin/xray.exe", "bin/geoip.dat", "bin/geosite.dat"];
    for (const relativePath of required) {
      const fullPath = path.join(extractDir, ...relativePath.split("/"));
      if (!existsSync(fullPath)) {
        throw new Error(`Full update ZIP is missing ${relativePath}`);
      }
      if (relativePath === "bin/xray.exe") {
        validateWindowsPeFile(fullPath, relativePath);
      } else if (statSync(fullPath).size < minimumGeoDataBytes) {
        throw new Error(`Full update ZIP contains invalid ${relativePath}`);
      }
    }
    const mainExe = path.join(extractDir, "ChordV.exe");
    if (!existsSync(mainExe)) {
      throw new Error("Full update ZIP is missing root ChordV.exe");
    }
    if (existsSync(path.join(extractDir, "chordv-desktop.exe"))) {
      throw new Error("Full update ZIP must not include legacy chordv-desktop.exe alias");
    }
    validateExecutableProductVersion(mainExe, version, "Full update ZIP executable");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function validateWindowsPeFile(exePath, label) {
  const stat = statSync(exePath);
  if (stat.size < minimumPeBytes) {
    throw new Error(`${label} is too small to be a valid Windows executable`);
  }
  const header = runPowerShell(
    `$bytes = [System.IO.File]::ReadAllBytes(${quotePowerShell(exePath)}); if ($bytes.Length -lt 2) { '' } else { [System.Text.Encoding]::ASCII.GetString($bytes, 0, 2) }`,
    { capture: true }
  ).stdout.trim();
  if (header !== "MZ") {
    throw new Error(`${label} is not a Windows PE file`);
  }
}

function validateExecutableProductVersion(exePath, version, label) {
  if (!existsSync(exePath)) {
    throw new Error(`${label} is missing: ${exePath}`);
  }
  validateWindowsPeFile(exePath, label);
  const versionResult = runPowerShell(
    `[Diagnostics.FileVersionInfo]::GetVersionInfo(${quotePowerShell(exePath)}).ProductVersion`,
    { capture: true }
  );
  const productVersion = versionResult.stdout.trim();
  if (!productVersion) {
    throw new Error(`${label} ProductVersion is empty`);
  }
  if (productVersion !== version && !productVersion.startsWith(`${version}.`)) {
    throw new Error(`${label} ProductVersion ${productVersion} does not match ${version}`);
  }
}

function runPowerShell(command, options = {}) {
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "pipe"
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || `PowerShell command failed: ${command}`);
  }
  return result;
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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
