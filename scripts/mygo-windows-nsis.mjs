import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const MYGO_NSIS_VERSION = "v0.9.1";
export const MYGO_NSIS_SOURCE_SHA256 = "1a666c780024f42d80b5659e251e519aa21a7727bfdff809c019add37b4b1adb";
const pages = ["DIRECTORY", "INSTFILES", "FINISH", "UNPAGE_CONFIRM", "UNPAGE_INSTFILES"];
const originalPages = '!include "MUI2.nsh"\n' + pages.map((page) => `!insertmacro MUI_${page.startsWith("UNPAGE") ? page : `PAGE_${page}`}\n`).join("");
const transformedPages = '!include "MUI2.nsh"\n!define CHORDV_MYGO_PASSIVE_PAGES 1\n'
  + '!define MUI_PAGE_CUSTOMFUNCTION_PRE ChordVDirectoryPre\n!insertmacro MUI_PAGE_DIRECTORY\n'
  + '!insertmacro MUI_PAGE_INSTFILES\n'
  + '!define MUI_PAGE_CUSTOMFUNCTION_PRE ChordVFinishPre\n!insertmacro MUI_PAGE_FINISH\n'
  + '!insertmacro MUI_UNPAGE_CONFIRM\n!insertmacro MUI_UNPAGE_INSTFILES\n';

function nsisQuote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("NSIS include 路径含控制字符");
  return `"${value.replaceAll("$", "$$").replaceAll('"', '$\\"')}"`;
}

function once(source, anchor) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) !== -1) throw new Error("MyGo NSIS 结构缺失或重复，拒绝变换");
  return first;
}

export function validateMyGoNSISModule(module, source) {
  if (module.Path !== "github.com/egoist/mygo" || module.Version !== MYGO_NSIS_VERSION || module.Replace
    || createHash("sha256").update(source).digest("hex") !== MYGO_NSIS_SOURCE_SHA256) {
    throw new Error("Windows passive 适配仅支持未替换的锁定 MyGo v0.9.1 NSIS 源码");
  }
}

// The locked generator owns the installer. Only inject the two native MUI
// callbacks before their pages are expanded; keep the rest byte-for-byte.
export function transformMyGoNSIS(source, { version, installerInclude }) {
  if (version !== MYGO_NSIS_VERSION) throw new Error("MyGo NSIS 版本不匹配，拒绝变换");
  if (!path.isAbsolute(installerInclude)) throw new Error("NSIS include 必须是绝对路径");
  if (!source.startsWith("\uFEFFUnicode true\nManifestDPIAware true\nSetCompressor /SOLID lzma\n")
    || source.includes("\r") || /CHORDV_MYGO_PASSIVE_PAGES|ChordVDirectoryPre|ChordVFinishPre|MUI_PAGE_CUSTOMFUNCTION/.test(source)) {
    throw new Error("MyGo NSIS 头部或页面回调不符合锁定结构，拒绝变换");
  }
  const block = once(source, originalPages);
  const declaredPages = source.match(/^\s*(?:!insertmacro MUI_(?:UN)?PAGE_\w+|Page(?:Ex)?\b).*$/gm) ?? [];
  if (declaredPages.join("\n") !== originalPages.split("\n").slice(1, -1).join("\n")) {
    throw new Error("MyGo NSIS 页面有额外、缺失或重排声明，拒绝变换");
  }
  for (const anchor of [
    'Name "ChordV"\n', 'InstallDir "$LOCALAPPDATA\\Programs\\ChordV"\n',
    'InstallDirRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\app.chordv.desktop" "InstallLocation"\n',
    "RequestExecutionLevel user\n", "Section\n  Push \"$INSTDIR\"\n  Call CloseApp\n  SetOutPath \"$INSTDIR\"\n",
    "  !ifmacrodef customInstall\n    !insertmacro customInstall\n  !endif\nSectionEnd\n",
    "  !ifmacrodef customUnInstall\n    !insertmacro customUnInstall\n  !endif\n"
  ]) once(source, anchor);
  const include = `!include ${nsisQuote(installerInclude)}\n!ifmacrodef customInit\nFunction .onInit\n  !insertmacro customInit\nFunctionEnd\n!endif\n`;
  if (once(source, include) < block + originalPages.length || (source.match(/^!include /gm) ?? []).length !== 2) {
    throw new Error("MyGo NSIS include 不符合当前构建身份，拒绝变换");
  }
  return source.slice(0, block) + transformedPages + source.slice(block + originalPages.length);
}

export async function resolveMakensis(env = process.env, platform = process.platform) {
  const pathKey = platform === "win32" ? Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH" : "PATH";
  const candidates = (env[pathKey] ?? "").split(platform === "win32" ? ";" : path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry))
    .map((entry) => path.join(entry, platform === "win32" ? "makensis.exe" : "makensis"));
  if (platform === "win32") {
    // Keep MyGo 0.9.1's existing installed-NSIS discovery after PATH; only
    // its download fallback is intentionally excluded from this wrapper.
    for (const name of ["ProgramFiles(x86)", "ProgramFiles"]) {
      const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
      const directory = key ? env[key] : "";
      if (directory && path.isAbsolute(directory)) candidates.push(path.join(directory, "NSIS", "makensis.exe"));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return { executable: await realpath(candidate), pathKey };
    } catch (error) { if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error; }
  }
  throw new Error("正式 Windows 构建需要 PATH 或 ProgramFiles 已安装目录中的 makensis；未改用下载或其他编译器");
}

export async function prepareWindowsNSIS({ configDir, installerInclude, nativeDir, env, run }) {
  const { executable, pathKey } = await resolveMakensis(env);
  const { stdout } = await execute("go", ["list", "-m", "-json", "github.com/egoist/mygo"], { cwd: nativeDir, env, windowsHide: true });
  const module = JSON.parse(stdout);
  validateMyGoNSISModule(module, await readFile(path.join(module.Dir, "cmd/mygo/nsis.go")));
  const directory = path.join(configDir, "nsis-wrapper");
  await mkdir(directory);
  const launcher = path.join(directory, `makensis${process.platform === "win32" ? ".exe" : ""}`);
  const source = fileURLToPath(new URL("./windows/makensis-launcher.go", import.meta.url));
  const platform = process.platform === "win32" ? "windows" : process.platform;
  await run("go", ["build", "-trimpath", "-o", launcher, source], nativeDir, { GOOS: platform, GOARCH: process.arch === "x64" ? "amd64" : process.arch });
  if (await realpath(launcher) === executable) throw new Error("makensis wrapper 不得递归调用自身");
  await writeFile(path.join(directory, "launcher.json"), JSON.stringify({
    node: await realpath(process.execPath), script: fileURLToPath(new URL("./mygo-windows-nsis-wrapper.mjs", import.meta.url)),
    compiler: executable, launcher, version: module.Version, installerInclude
  }));
  const extraEnv = { [pathKey]: `${directory}${path.delimiter}${env[pathKey] ?? ""}` };
  return { extraEnv, directory, executable, launcher };
}
