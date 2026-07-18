import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = path.join(packageRoot, "src", "update-limits.data.json");
const distDir = path.join(packageRoot, "dist");
const limits = JSON.parse(readFileSync(sourcePath, "utf8"));
const maxDesktopUpdateDownloadBytes = limits.maxDesktopUpdateDownloadBytes;

if (!Number.isSafeInteger(maxDesktopUpdateDownloadBytes) || maxDesktopUpdateDownloadBytes <= 0) {
  throw new Error("maxDesktopUpdateDownloadBytes must be a positive safe integer");
}

mkdirSync(distDir, { recursive: true });

writeFileSync(
  path.join(distDir, "update-limits.cjs"),
  [
    '"use strict";',
    "",
    `const MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES = ${maxDesktopUpdateDownloadBytes};`,
    "",
    "module.exports = Object.freeze({ MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES });",
    ""
  ].join("\n"),
  "utf8"
);

writeFileSync(
  path.join(distDir, "update-limits.mjs"),
  [
    `export const MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES = ${maxDesktopUpdateDownloadBytes};`,
    "",
    "const updateLimits = Object.freeze({ MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES });",
    "export default updateLimits;",
    ""
  ].join("\n"),
  "utf8"
);