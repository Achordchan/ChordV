import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hooks = fileURLToPath(new URL("./windows/chordv-installer.nsh", import.meta.url));
const reserved = new Set(["chordv.exe", "uninstall.exe", ".mygo-files", "chordv-desktop.exe", "chordv_desktop.exe"]);

function nsisString(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("NSIS 路径含控制字符");
  return `"${value.replaceAll("$", "$$").replaceAll('"', '$\\"')}"`;
}

function validName(name) {
  return name !== "." && name !== ".." && !/[<>:"/\\|?*\x00-\x1f$]/.test(name)
    && !/[. ]$/.test(name) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name);
}

function installedPath(name) {
  return '"$INSTDIR\\' + nsisString(name.replaceAll("/", "\\")).slice(1);
}

// The temporary MyGo config has no automatic resources/ directory: its explicit
// resources list is the complete copy plan. Reject links rather than guessing
// which user files a recursive uninstaller would own after following one.
export async function windowsOwnedPayload(resources) {
  const files = ["ChordV.exe", ".mygo-files", "Uninstall.exe"];
  const directories = [];
  const names = new Set();
  async function visit(source, target) {
    const segments = target.split("/");
    if (segments.some((name) => !validName(name)) || reserved.has(segments[0].toLowerCase())) {
      throw new Error(`Windows 安装资源名称无效或覆盖程序入口：${target}`);
    }
    const folded = target.toLowerCase();
    if (names.has(folded)) throw new Error(`Windows 安装资源路径重复：${target}`);
    names.add(folded);
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`Windows 安装资源不接受符号链接：${target}`);
    if (stat.isDirectory()) {
      directories.push(target);
      for (const name of (await readdir(source)).sort()) {
        const child = path.join(source, name);
        if ([".DS_Store", "Thumbs.db", "desktop.ini"].includes(name)) continue;
        if (name.startsWith(".") && (await lstat(child)).isDirectory()) continue;
        await visit(child, `${target}/${name}`);
      }
    } else if (stat.isFile()) files.push(target);
    else throw new Error(`Windows 安装资源不是普通文件：${target}`);
  }
  for (const source of resources) await visit(source, path.basename(source));
  return { files, directories: directories.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b)) };
}

export async function writeWindowsInstallerInclude(config, configDir, { qaOnly = false } = {}) {
  if (config.name !== "ChordV" || config.identifier !== "app.chordv.desktop" || config.windows?.installDirName !== "ChordV") {
    throw new Error("旧 Windows 安装兼容钩子仅用于正式 ChordV 身份");
  }
  const { files, directories } = await windowsOwnedPayload(config.resources ?? []);
  const output = path.join(configDir, "chordv-windows-installer.nsh");
  const lines = [
    "; Generated from the exact resources of this build. Never read an installed manifest as deletion authority.",
    ...(qaOnly ? ["!define CHORDV_INSTALLER_QA_ONLY 1"] : []),
    "!macro ChordVPayloadCheck PREFIX",
    ...[...files, ...directories].map((name) => '  !insertmacro ChordVCheckOwned "${PREFIX}" ' + nsisString(name.replaceAll("/", "\\"))),
    "!macroend",
    "!macro ChordVPayloadDelete",
    ...files.map((name) => `  Delete ${installedPath(name)}`),
    ...directories.map((name) => `  RMDir ${installedPath(name)}`),
    "!macroend",
    `!include ${nsisString(hooks)}`,
    ""
  ];
  await writeFile(output, lines.join("\n"));
  return output;
}
