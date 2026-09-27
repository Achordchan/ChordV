import path from "node:path";
import { fileURLToPath } from "node:url";
import platformVersions from "../config/platform-versions.json" with { type: "json" };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const desktopRoot = path.resolve(scriptDir, "..");
export const desktopPlatformVersions = platformVersions;

export function normalizeDesktopPlatform(input) {
  if (!input) {
    return "macos";
  }

  const value = String(input).toLowerCase();
  if (value === "darwin" || value === "mac" || value === "macos" || value === "osx") {
    return "macos";
  }
  if (value === "win" || value === "windows" || value === "win32") {
    return "windows";
  }
  if (value === "android") {
    return "android";
  }
  if (value === "ios" || value === "iphone" || value === "ipad") {
    return "ios";
  }
  return "macos";
}

export function resolveDesktopPlatformVersion(platform) {
  const normalized = normalizeDesktopPlatform(platform);
  return desktopPlatformVersions[normalized] ?? desktopPlatformVersions.macos;
}

export function buildAndroidArtifactNames(version, release = false) {
  const suffix = release ? "release" : "debug";
  return {
    apk: `ChordV_${version}_android_${suffix}.apk`,
    aab: `ChordV_${version}_android_${suffix}.aab`
  };
}

// CI sets CHORDV_BUILD_NUMBER (the workflow run number). It never changes the
// version; it only tells successive installers of the same version apart.
export function resolveDesktopBuildNumber(raw = process.env.CHORDV_BUILD_NUMBER) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return null;
  }
  if (!/^[1-9]\d{0,8}$/.test(value)) {
    throw new Error(`CHORDV_BUILD_NUMBER 必须是正整数：${value}`);
  }
  return Number(value);
}

function buildSuffix(build) {
  return build ? `_build${build}` : "";
}

export function buildWindowsArtifactNames(version, build = resolveDesktopBuildNumber()) {
  const baseName = `ChordV_${version}${buildSuffix(build)}_x64`;
  return {
    exe: `${baseName}.exe`,
    setup: `${baseName}-setup.exe`,
    signature: `${baseName}-setup.exe.sig`
  };
}

export function buildMacArtifactNames(version, build = resolveDesktopBuildNumber()) {
  return {
    dmg: `ChordV_${version}${buildSuffix(build)}.dmg`
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const platform = process.argv[2];
  process.stdout.write(resolveDesktopPlatformVersion(platform));
}
