import platformVersions from "../../config/platform-versions.json";
import { detectRuntimePlatform, type RuntimeStatus } from "./runtime";

type DesktopPlatformVersionKey = "macos" | "windows" | "android" | "ios";

const versions = platformVersions as Record<DesktopPlatformVersionKey, string>;

function normalizePlatformKey(input: string): DesktopPlatformVersionKey {
  const value = input.toLowerCase();
  if (value === "windows") {
    return "windows";
  }
  if (value === "android") {
    return "android";
  }
  if (value === "ios") {
    return "ios";
  }
  return "macos";
}

export function resolveDesktopPlatformVersion(platformTarget: RuntimeStatus["platformTarget"]) {
  if (platformTarget === "web") {
    const detected = detectRuntimePlatform();
    return versions[normalizePlatformKey(detected === "web" ? "macos" : detected)] ?? versions.macos;
  }

  return versions[normalizePlatformKey(platformTarget)] ?? versions.macos;
}
