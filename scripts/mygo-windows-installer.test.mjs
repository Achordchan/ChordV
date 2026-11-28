import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { windowsOwnedPayload, writeWindowsInstallerInclude } from "./mygo-windows-installer.mjs";

const identity = { name: "ChordV", identifier: "app.chordv.desktop", windows: { installDirName: "ChordV" } };
const script = (name) => readFile(new URL(`./windows/${name}`, import.meta.url), "utf8");
async function temporary(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "chordv-installer-contract-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("卸载权限仅由当前构建的精确文件列表生成，不信任目标目录内的清单", async () => temporary(async (directory) => {
  const resources = path.join(directory, "测试资源");
  await mkdir(path.join(resources, "nested"), { recursive: true });
  await mkdir(path.join(resources, ".git"));
  await writeFile(path.join(resources, "nested/file.txt"), "owned");
  await writeFile(path.join(resources, ".git/unshipped"), "not shipped by MyGo");
  await writeFile(path.join(resources, ".DS_Store"), "not shipped by MyGo");
  const owned = await windowsOwnedPayload([resources]);
  assert.deepEqual(owned.files, ["ChordV.exe", ".mygo-files", "Uninstall.exe", "测试资源/nested/file.txt"]);
  assert.deepEqual(owned.directories, ["测试资源/nested", "测试资源"]);
  const include = await writeWindowsInstallerInclude({ ...identity, resources: [resources] }, directory);
  const source = await readFile(include, "utf8");
  assert.match(source, /!insertmacro ChordVCheckOwned "\$\{PREFIX\}" "测试资源\\nested\\file.txt"/);
  assert.match(source, /Delete "\$INSTDIR\\测试资源\\nested\\file.txt"/);
  assert.ok(source.indexOf('RMDir "$INSTDIR\\测试资源\\nested"') < source.indexOf('RMDir "$INSTDIR\\测试资源"'));
  assert.doesNotMatch(source, /RMDir \/r|FileRead|unshipped|\.DS_Store/);
}));

test("资源链接、重复名称、Windows保留名和程序入口冲突在打包前拒绝", async (context) => temporary(async (directory) => {
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  await mkdir(first); await mkdir(second);
  await writeFile(path.join(first, "data.txt"), "a");
  await writeFile(path.join(second, "DATA.txt"), "b");
  await assert.rejects(windowsOwnedPayload([path.join(first, "data.txt"), path.join(second, "DATA.txt")]), /重复/);
  await context.test("资源符号链接拒绝", async (linkTest) => {
    try { await symlink(path.join(first, "data.txt"), path.join(directory, "linked.txt")); }
    catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") return linkTest.skip("当前 Windows 账户没有创建符号链接权限");
      throw error;
    }
    await assert.rejects(windowsOwnedPayload([path.join(directory, "linked.txt")]), /符号链接/);
  });
  for (const name of ["ChordV.exe", "Uninstall.exe", ".mygo-files", "chordv-desktop.exe", "NUL.txt", "bad$var", "trailing.", "ADS:stream"]) {
    await assert.rejects(windowsOwnedPayload([path.join(directory, name)]), /名称无效|程序入口/);
  }
  await assert.rejects(writeWindowsInstallerInclude({ ...identity, name: "ChordV MyGo Local" }, directory), /仅用于正式/);
}));

test("正式 Windows 或独立 QA 入口才接入旧安装钩子，普通调试和其他平台不接管", async () => {
  const source = await readFile(new URL("./mygo-desktop.mjs", import.meta.url), "utf8");
  assert.match(source, /const windowsCompatibility = goOS === "windows" && \(options\.release \|\| options\.windowsInstallerQA\)/);
  assert.match(source, /if \(windowsCompatibility\) config\.windows\.installerInclude = await writeWindowsInstallerInclude\(config, configDir, \{ qaOnly: options\.windowsInstallerQA \}\)/);
  assert.match(source, /config\.out = path\.join\(PROJECT_ROOT, "output", options\.windowsInstallerQA \? "windows-installer-qa" : "mygo"\)/);
  const resources = source.indexOf("config.resources =");
  const include = source.indexOf("config.windows.installerInclude =");
  const persist = source.search(/await writeFile\(path\.join\(\w+, "mygo\.json"\)/);
  assert.ok(resources >= 0 && resources < include && include < persist);
});

test("Windows installer QA 拒绝与正式发行、其他架构或启动模式混用", () => {
  const entry = fileURLToPath(new URL("./mygo-desktop.mjs", import.meta.url));
  for (const args of [
    ["--platform", "windows", "--arch", "x64"],
    ["--build-only", "--platform", "windows", "--arch", "arm64"],
    ["--build-only", "--platform", "macos", "--arch", "x64"],
    ...["--release", "--e2e", "--skip-installer", "--dev", "--check"].map(flag => ["--build-only", "--platform", "windows", "--arch", "x64", flag])
  ]) {
    const result = spawnSync(process.execPath, [entry, "--windows-installer-qa", ...args], { encoding: "utf8", timeout: 4000 });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /Windows 安装验收仅支持 --build-only --platform windows --arch x64/);
  }
});

test("仅 QA 包生成测试账户标记门禁，正式包不带该限制", async () => temporary(async directory => {
  const source = await script("chordv-installer.nsh");
  assert.match(source, /!macro ChordVCheckQAProfile[\s\S]*?!ifdef CHORDV_INSTALLER_QA_ONLY[\s\S]*?\$PROFILE\\\.chordv-installer-qa-lease\.json[\s\S]*?!endif\s+!macroend/);
  assert.match(source, /!macro customInit\s+SetShellVarContext current\s+!insertmacro ChordVCheckQAProfile\s+Call ChordVParseParameters/);
  assert.match(source, /Function un\.onInit\s+SetShellVarContext current\s+!insertmacro ChordVCheckQAProfile/);
  const include = await writeWindowsInstallerInclude({ ...identity, resources: [] }, directory);
  assert.doesNotMatch(await readFile(include, "utf8"), /CHORDV_INSTALLER_QA_ONLY/);
  await writeWindowsInstallerInclude({ ...identity, resources: [] }, directory, { qaOnly: true });
  assert.match(await readFile(include, "utf8"), /^!define CHORDV_INSTALLER_QA_ONLY 1$/m);
}));

test("旧参数解析保留官方quote-aware解析器，passive仅跳原生页面而不是降成silent", async () => {
  const source = await script("chordv-installer.nsh");
  for (const flag of ["/P", "/UPDATE", "/R", "/ARGS", "/D="]) assert.ok(source.includes(`"${flag}"`));
  assert.match(source, /GetCommandLineW/);
  assert.match(source, /lstrlenW/);
  assert.match(source, /ChordVReadFlag "\/P" \$ChordVPassive/);
  assert.match(source, /Function ChordVDirectoryPre[\s\S]*?\$ChordVPassive == 1\s+Abort/);
  assert.match(source, /Function ChordVFinishPre[\s\S]*?\$ChordVPassive == 1\s+Abort/);
  assert.match(source, /\/P 和 \/S 不能同时使用/);
  assert.match(await script("chordv-install-actions.nsh"), /\$ChordVPassive == 1\s+SetAutoClose true/);
  assert.doesNotMatch(source, /SetSilent|--installer-maintenance|taskkill/);
  assert.ok(source.indexOf("Call ChordVParseParameters") < source.indexOf("Call ChordVReadRegistry", source.indexOf("!macro customInit")));
  assert.match(source, /Function \.onInstSuccess[\s\S]*Exec '\$\\"\$INSTDIR\\ChordV\.exe\$\\" \$ChordVRestartArgs'/);
});

test("目录/注册表/卸载边界有前置检查，不调用旧卸载器或递归删除用户目录", async () => {
  const paths = await script("chordv-paths.nsh");
  const registry = await script("chordv-registry.nsh");
  const actions = await script("chordv-install-actions.nsh");
  const entry = await script("chordv-installer.nsh");
  assert.match(paths, /GetFileAttributesW/);
  assert.match(paths, /IntOp \$2 \$1 & 0x10/);
  assert.match(paths, /GetParent/);
  assert.match(registry, /SetRegView 32/); assert.match(registry, /SetRegView 64/);
  assert.match(registry, /MainBinaryName/); assert.match(registry, /UninstallString/);
  assert.match(registry, /不同的 ChordV 安装目录/);
  assert.match(entry, /Function un\.onInit[\s\S]*ChordVPayloadCheck "un\."/);
  assert.match(actions, /!macro customUnInstall[\s\S]*!insertmacro ChordVPayloadDelete[\s\S]*\n  Return\n!macroend/);
  assert.doesNotMatch(actions, /^\s*RMDir \/r|Exec.*uninstall/i);
});

const compiler = process.env.MAKENSIS ?? "makensis";
// Match the macOS cross-packager: makensis must decode the Chinese script as UTF-8.
const compilerEnv = process.platform === "darwin" ? { ...process.env, LC_ALL: "en_US.UTF-8" } : process.env;
const compilerOptions = { encoding: "utf8", timeout: 30_000, env: compilerEnv };
const installedCompiler = spawnSync(compiler, ["-VERSION"], compilerOptions);
test("实际makensis编译所有hook及Return跳过模板递归删除的控制流", { skip: installedCompiler.status !== 0 && "未安装 makensis；仅静态合同测试，未执行 NSIS 编译" }, async () => temporary(async (directory) => {
  const include = await writeWindowsInstallerInclude({ ...identity, resources: [] }, directory);
  const escape = (value) => value.replaceAll("$", "$$");
  const source = `Unicode true
Name "ChordV"
OutFile "${escape(path.join(directory, "contract.exe"))}"
InstallDir "$LOCALAPPDATA\\Programs\\ChordV"
RequestExecutionLevel user
!include "MUI2.nsh"
!define CHORDV_MYGO_PASSIVE_PAGES 1
!define MUI_PAGE_CUSTOMFUNCTION_PRE ChordVDirectoryPre
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE ChordVFinishPre
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!include "${escape(include)}"
Function .onInit
  !insertmacro customInit
FunctionEnd
Section
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  !insertmacro customInstall
SectionEnd
Section "Uninstall"
  !insertmacro customUnInstall
  RMDir /r "$INSTDIR"
SectionEnd
`;
  const file = path.join(directory, "contract.nsi");
  await writeFile(file, source);
  const result = spawnSync(compiler, ["-V2", file], compilerOptions);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const expanded = spawnSync(compiler, ["-PPO", file], compilerOptions);
  assert.equal(expanded.status, 0, expanded.stdout + expanded.stderr);
  assert.match(expanded.stdout, /Return\s+RMDir \/r "\$INSTDIR"/);
  assert.match(expanded.stdout, /IntOp \$3 \$1 & 0x400/);
}));
