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

export function buildWindowsArtifactNames(version) {
  const baseName = `ChordV_${version}_x64`;
  return {
    exe: `${baseName}.exe`,
    setup: `${baseName}-setup.exe`,
    fullZip: `${baseName}-full.zip`
  };
}

export function buildMacArtifactNames(version) {
  return {
    dmg: `ChordV_${version}.dmg`
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const platform = process.argv[2];
  process.stdout.write(resolveDesktopPlatformVersion(platform));
}
