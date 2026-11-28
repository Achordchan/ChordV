import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MYGO_NSIS_VERSION, resolveMakensis, transformMyGoNSIS, validateMyGoNSISModule } from "./mygo-windows-nsis.mjs";
import { writeWindowsInstallerInclude } from "./mygo-windows-installer.mjs";

const cli = fileURLToPath(new URL("./mygo-windows-nsis-wrapper.mjs", import.meta.url));
const identity = { name: "ChordV", identifier: "app.chordv.desktop", windows: { installDirName: "ChordV" } };
async function temporary(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "chordv-passive-test-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function generatedScript(include, output) {
  return `\uFEFFUnicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
Name "ChordV"
OutFile "${output}"
InstallDir "$LOCALAPPDATA\\Programs\\ChordV"
InstallDirRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\app.chordv.desktop" "InstallLocation"
RequestExecutionLevel user
!include "MUI2.nsh"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!include "${include}"
!ifmacrodef customInit
Function .onInit
  !insertmacro customInit
FunctionEnd
!endif
Function CloseApp
  Pop $0
FunctionEnd
Section
  Push "$INSTDIR"
  Call CloseApp
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  !ifmacrodef customInstall
    !insertmacro customInstall
  !endif
SectionEnd
Section "Uninstall"
  !ifmacrodef customUnInstall
    !insertmacro customUnInstall
  !endif
  RMDir /r "$INSTDIR"
SectionEnd
`;
}

test("锁版本和唯一完整MUI页面块，仅注入目录/完成PRE，不修改进度页或签名命令", async () => temporary(async (directory) => {
  const installerInclude = path.join(directory, "chordv.nsh");
  const source = generatedScript(installerInclude, path.join(directory, "setup.exe"));
  const transformed = transformMyGoNSIS(source, { version: MYGO_NSIS_VERSION, installerInclude });
  const inserted = transformed.split("\n").filter((line) => /!define (?:CHORDV_MYGO_PASSIVE_PAGES|MUI_PAGE_CUSTOMFUNCTION_PRE)/.test(line));
  assert.deepEqual(inserted, ["!define CHORDV_MYGO_PASSIVE_PAGES 1", "!define MUI_PAGE_CUSTOMFUNCTION_PRE ChordVDirectoryPre", "!define MUI_PAGE_CUSTOMFUNCTION_PRE ChordVFinishPre"]);
  assert.equal(transformed.split("\n").filter((line) => !inserted.includes(line)).join("\n"), source);
  assert.match(transformed, /MUI_PAGE_CUSTOMFUNCTION_PRE ChordVDirectoryPre\n!insertmacro MUI_PAGE_DIRECTORY/);
  assert.match(transformed, /MUI_PAGE_CUSTOMFUNCTION_PRE ChordVFinishPre\n!insertmacro MUI_PAGE_FINISH/);
  assert.doesNotMatch(transformed, /SetSilent|SendMessage|PostMessage|WM_COMMAND/);
  for (const command of [
    `!uninstfinalize '"%MYGO_SIGNER%" sign-uninstaller "%1"' = 0`,
    `!uninstfinalize '"$MYGO_SIGNER" sign-uninstaller "%1"' = 0`
  ]) {
    const signed = source.replace('Name "ChordV"\n', `Name "ChordV"\n${command}\n`);
    assert.ok(transformMyGoNSIS(signed, { version: MYGO_NSIS_VERSION, installerInclude }).includes(command));
  }
}));

test("错版本/替换模块/改过锁源/缺失重复额外重排页面/include错配/重复变换均拒绝", async () => temporary(async (directory) => {
  const installerInclude = path.join(directory, "chordv.nsh");
  const source = generatedScript(installerInclude, path.join(directory, "setup.exe"));
  const options = { version: MYGO_NSIS_VERSION, installerInclude };
  for (const version of ["v0.9.0", "v0.9.2", "0.9.1", ""]) assert.throws(() => transformMyGoNSIS(source, { ...options, version }), /版本/);
  for (const module of [
    { Path: "github.com/egoist/mygo", Version: "v0.9.2" },
    { Path: "github.com/egoist/mygo", Version: MYGO_NSIS_VERSION, Replace: { Dir: directory } },
    { Path: "github.com/egoist/mygo", Version: MYGO_NSIS_VERSION },
    { Path: "fixture/wrong", Version: MYGO_NSIS_VERSION }
  ]) assert.throws(() => validateMyGoNSISModule(module, Buffer.from("not locked source")), /锁定/);
  for (const changed of [
    source.replace("!insertmacro MUI_PAGE_DIRECTORY\n", ""),
    source.replace("!insertmacro MUI_PAGE_FINISH\n", "!insertmacro MUI_PAGE_FINISH\n!insertmacro MUI_PAGE_FINISH\n"),
    source + "!insertmacro MUI_PAGE_WELCOME\n", source + "Page custom Surprise\n",
    source.replace("MUI_PAGE_DIRECTORY\n!insertmacro MUI_PAGE_INSTFILES", "MUI_PAGE_INSTFILES\n!insertmacro MUI_PAGE_DIRECTORY"),
    source.replace("\nRequestExecutionLevel user\n", "\nRequestExecutionLevel admin\n"),
    source.replace("!include \"MUI2.nsh\"", "!define MUI_PAGE_CUSTOMFUNCTION_PRE Other\n!include \"MUI2.nsh\""),
    source + '!include "other.nsh"\n', source.replace("Name \"ChordV\"", "Name \"Other\""),
    source.replaceAll("\n", "\r\n"), source.slice(1),
    transformMyGoNSIS(source, options)
  ]) assert.throws(() => transformMyGoNSIS(changed, options), /拒绝变换|不符合/);
  assert.throws(() => transformMyGoNSIS(source, { ...options, installerInclude: path.join(directory, "wrong.nsh") }), /缺失/);
}));

test("wrapper不改原脚本，原argv/stdin/cwd/签名环境透明传递，退出码保留且临时脚本清理", async () => temporary(async (directory) => {
  const installerInclude = path.join(directory, "chordv.nsh");
  const file = path.join(directory, "installer.nsi");
  const original = generatedScript(installerInclude, path.join(directory, "setup.exe"));
  const fake = path.join(directory, "test-compiler.mjs");
  const launcher = path.join(directory, "launcher");
  const output = path.join(directory, "invocation.json");
  const configFile = path.join(directory, "launcher.json");
  await writeFile(launcher, "test-only launcher identity");
  await writeFile(file, original);
  await writeFile(fake, `import {readFileSync,writeFileSync} from 'node:fs';
writeFileSync(process.env.CHORDV_TEST_OUTPUT, JSON.stringify({args:process.argv.slice(2),stdin:readFileSync(0,'utf8'),cwd:process.cwd(),signer:process.env.MYGO_SIGNER,settings:process.env.MYGO_SIGN_SETTINGS,password:process.env.MYGO_WINDOWS_CERTIFICATE_PASSWORD,script:readFileSync(process.argv.at(-1),'utf8')}));process.exit(42);`);
  await writeFile(configFile, JSON.stringify({ compiler: process.execPath, launcher, version: MYGO_NSIS_VERSION, installerInclude }));
  const result = spawnSync(process.execPath, [cli, configFile, fake, "-V2", "-DTEST=参数 with space", file], {
    cwd: directory, encoding: "utf8", input: "original stdin", timeout: 10_000,
    env: { ...process.env, CHORDV_TEST_OUTPUT: output, MYGO_SIGNER: "fixture signer only", MYGO_SIGN_SETTINGS: "fixture settings only", MYGO_WINDOWS_CERTIFICATE_PASSWORD: "fixture password only" }
  });
  assert.equal(result.status, 42, result.stdout + result.stderr);
  const invoked = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(invoked.args.slice(0, -1), ["-V2", "-DTEST=参数 with space"]);
  assert.equal(invoked.stdin, "original stdin"); assert.equal(await realpath(invoked.cwd), await realpath(directory));
  assert.equal(invoked.signer, "fixture signer only"); assert.equal(invoked.settings, "fixture settings only"); assert.equal(invoked.password, "fixture password only");
  assert.match(invoked.script, /!define CHORDV_MYGO_PASSIVE_PAGES 1/);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal((await readdir(directory)).some((name) => name.startsWith(".chordv-passive-")), false);
  await writeFile(file, original.replace("!insertmacro MUI_PAGE_FINISH\n", ""));
  await rm(output);
  const rejected = spawnSync(process.execPath, [cli, configFile, fake, file], { cwd: directory, encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.equal((await readdir(directory)).includes("invocation.json"), false, "wrong structure must fail before compiler execution");
  await writeFile(configFile, JSON.stringify({ compiler: process.execPath, launcher: process.execPath }));
  const recursive = spawnSync(process.execPath, [cli, configFile, "-VERSION"], { encoding: "utf8" });
  assert.equal(recursive.status, 1); assert.match(recursive.stderr, /递归/);
}));

let compiler;
try { compiler = (await resolveMakensis()).executable; } catch { /* Compiler availability is explicit in the test result. */ }
test("真实makensis通过wrapper预处理/编译，native PRE调用已绑定且仅passive Abort", { skip: !compiler && "未安装 makensis，实际编译未执行" }, async () => temporary(async (directory) => {
  const installerInclude = await writeWindowsInstallerInclude(identity, directory);
  const file = path.join(directory, "installer.nsi");
  const original = generatedScript(installerInclude, path.join(directory, "setup.exe"));
  const launcher = path.join(directory, "launcher");
  const configFile = path.join(directory, "launcher.json");
  await writeFile(file, original); await writeFile(launcher, "identity only");
  await writeFile(configFile, JSON.stringify({ compiler, launcher, version: MYGO_NSIS_VERSION, installerInclude }));
  const compilerEnv = process.platform === "darwin" ? { ...process.env, LC_ALL: "en_US.UTF-8" } : process.env;
  const compilerOptions = { encoding: "utf8", timeout: 30_000, env: compilerEnv };
  const call = (...args) => spawnSync(process.execPath, [cli, configFile, ...args], compilerOptions);
  const version = call("-VERSION"); assert.equal(version.status, 0, version.stderr);
  const plain = spawnSync(compiler, ["-V2", file], compilerOptions);
  assert.notEqual(plain.status, 0, "hook without injected page callbacks must not compile");
  assert.match(plain.stderr + plain.stdout, /must be injected/);
  const preprocessed = call("-PPO", file); assert.equal(preprocessed.status, 0, preprocessed.stderr);
  for (const callback of ["ChordVDirectoryPre", "ChordVFinishPre"]) assert.match(preprocessed.stdout, new RegExp(`Call "${callback}"`));
  assert.match(preprocessed.stdout, /Function ChordVDirectoryPre[\s\S]*?Abort[\s\S]*?FunctionEnd/);
  assert.match(preprocessed.stdout, /SetAutoClose true/);
  assert.doesNotMatch(preprocessed.stdout, /SetSilent/);
  assert.doesNotMatch(preprocessed.stdout, /\.chordv-installer-qa-lease\.json/);
  const compiled = call("-V2", file); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  assert.equal((await readFile(path.join(directory, "setup.exe"))).subarray(0, 2).toString(), "MZ");
  assert.equal(await readFile(file, "utf8"), original);
  await writeWindowsInstallerInclude(identity, directory, { qaOnly: true });
  const qa = call("-PPO", file); assert.equal(qa.status, 0, qa.stderr);
  const qaGuard = /IfFileExists ["`]\$PROFILE\\\.chordv-installer-qa-lease\.json["`]/;
  for (const [entry, next] of [[".onInit", "Call ChordVParseParameters"], ["un.onInit", "Call un.ChordVReadRegistry"]]) {
    const body = qa.stdout.split(`Function ${entry}\n`)[1]?.split("FunctionEnd")[0];
    assert.ok(body && qaGuard.test(body) && body.includes(next));
    assert.ok(body.search(qaGuard) < body.indexOf(next));
  }
  const qaCompiled = call("-V2", file); assert.equal(qaCompiled.status, 0, qaCompiled.stdout + qaCompiled.stderr);
}));

test("启用 Windows 兼容钩子的构建准备独占 compiler 包装，PATH 不递归查找", async () => {
  const desktop = await readFile(new URL("./mygo-desktop.mjs", import.meta.url), "utf8");
  assert.match(desktop, /if \(windowsCompatibility\) \{\s+const wrapper = await prepareWindowsNSIS/);
  assert.ok(desktop.indexOf("await prepareWindowsNSIS") < desktop.indexOf('await run("go", buildArgs'));
  const tool = await readFile(new URL("./mygo-windows-nsis.mjs", import.meta.url), "utf8");
  assert.ok(tool.indexOf("await resolveMakensis(env)") < tool.indexOf('await mkdir(directory)'));
  await assert.rejects(resolveMakensis({ PATH: "" }), /PATH/);
});

test("Windows发现保持PATH优先，再按原MyGo顺序探测两处已安装NSIS，不下载", async () => temporary(async (directory) => {
  const pathDirectory = path.join(directory, "path-first");
  const x86 = path.join(directory, "Program Files (x86)");
  const native = path.join(directory, "Program Files");
  const pathExe = path.join(pathDirectory, "makensis.exe");
  const x86Exe = path.join(x86, "NSIS", "makensis.exe");
  const nativeExe = path.join(native, "NSIS", "makensis.exe");
  for (const file of [pathExe, x86Exe, nativeExe]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "Explicit discovery fixture, not an executable NSIS compiler", { mode: 0o755 });
  }
  const env = { Path: pathDirectory, "ProgramFiles(x86)": x86, ProgramFiles: native };
  assert.equal((await resolveMakensis(env, "win32")).executable, await realpath(pathExe));
  await rm(pathExe);
  assert.equal((await resolveMakensis(env, "win32")).executable, await realpath(x86Exe));
  await rm(x86Exe);
  assert.equal((await resolveMakensis(env, "win32")).executable, await realpath(nativeExe));
  assert.equal((await resolveMakensis({ PATH: "", programfiles: native }, "win32")).executable, await realpath(nativeExe));
  await assert.rejects(resolveMakensis({ PATH: "", ProgramFiles: native }, "darwin"), /已安装目录/);
  await rm(nativeExe);
  await assert.rejects(resolveMakensis(env, "win32"), /PATH 或 ProgramFiles 已安装目录/);
  await mkdir(nativeExe);
  await assert.rejects(resolveMakensis(env, "win32"), /PATH 或 ProgramFiles 已安装目录/);
}));
