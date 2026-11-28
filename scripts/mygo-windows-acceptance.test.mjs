import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acceptanceManifest, inspectAcceptanceContents, inspectAcceptanceInputs, legacySource, lockedLegacyContract, peIdentity } from "./mygo-windows-acceptance.mjs";

const source = (name) => readFile(new URL(name, import.meta.url), "utf8");
const inputs = { schemaVersion: 1, legacy: { installer: "old.exe", signature: "old.exe.sig" }, current: { installer: "current-setup.exe", binary: "ChordV.exe" } };

test("验收输入固定schema，不接受自声明哈希、公钥或verified", () => {
  assert.deepEqual(acceptanceManifest(inputs), inputs);
  for (const changed of [
    { ...inputs, verified: true }, { ...inputs, expectedSHA256: "a".repeat(64) },
    { ...inputs, legacy: { ...inputs.legacy, publicKey: "operator key" } },
    { ...inputs, current: { ...inputs.current, binary: "../ChordV.exe" } },
    { ...inputs, current: { ...inputs.current, binary: "old.exe" } }
  ]) assert.throws(() => acceptanceManifest(changed), /schema|identity|filenames/);
});

const legacySourcePresent = spawnSync("git", ["cat-file", "-e", `${legacySource}:apps/desktop/src-tauri/tauri.conf.json`]).status === 0;
test("实际旧合同绑定397a64d配置、固定公钥、updater锁版本", { skip: !legacySourcePresent && "浅克隆缺锁定旧源；专用runtime workflow必须fetch-depth 0，不能据此接受安装器" }, () => {
  const contract = lockedLegacyContract();
  assert.equal(contract.source, legacySource); assert.equal(contract.version, "1.1.12"); assert.equal(contract.mode, "passive");
  assert.equal(contract.manufacturer, "chordv");
  assert.equal(contract.manufacturerRegistryKey, "Software\\chordv\\ChordV");
});

test("PE结构解析只验证头部，不把合成PE当真实安装验收；非Windows完整检查提前拒绝", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "chordv-qa-pe-parser-"));
  try {
    const file = path.join(directory, "header-only-parser-fixture.bin");
    const bytes = Buffer.alloc(128); bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);
    await writeFile(file, bytes);
    assert.equal((await peIdentity(file)).machine, 0x8664);
    await assert.rejects(peIdentity(file, 0x14c), /architecture/);
    await writeFile(file, "not an executable"); await assert.rejects(peIdentity(file), /PE/);
    if (process.platform !== "win32") await assert.rejects(inspectAcceptanceInputs(directory, path.join(directory, "not-created")), /requires Windows/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("纯内容检查不形成Windows执行旁路；CLI仍先拒绝非Windows且固定选择系统7-Zip", async () => {
  await assert.rejects(inspectAcceptanceContents("unused", "unused", "relative-sevenzip"), /absolute ordinary/);
  const inspector = await source("./mygo-windows-acceptance.mjs");
  const runtime = inspector.slice(inspector.indexOf("export async function inspectAcceptanceInputs"));
  assert.ok(runtime.indexOf('process.platform !== "win32"') < runtime.indexOf("return inspectAcceptanceContents"));
  assert.match(runtime, /"7-Zip", "7z.exe"/);
  assert.match(inspector, /purpose: "content-inspection-only"/);
  assert.match(inspector, /runtimePreflightAccepted: false/);
  assert.doesNotMatch(inspector, /ALLOW_NON_WINDOWS|SKIP_PLATFORM|FORCE_WINDOWS|process\.env\.CHORDV_QA_/);
});

test("启动安装前需短期专用标准账户/SID/租约、空HKCU、空默认与专属目录，绝不重置代理", async () => {
  const sandbox = await source("./windows/qa/InstallerSandbox.psm1");
  const main = await source("./windows/qa/Invoke-ChordVInstallerAcceptance.ps1");
  for (const required of ["ChordVQa-", "ExpectedSid", "Disposable", "ExpiresUtc", "IsInRole", "SessionId", "Assert-NoChordVRegistration", "Assert-NoReparse"]) assert.ok(sandbox.includes(required));
  for (const key of ["chordv", "achordchan", "app.chordv.desktop"]) assert.ok(sandbox.includes(`HKCU:\\Software\\${key}\\ChordV`));
  assert.ok(main.indexOf("New-InstallerSandbox") < main.indexOf("Invoke-ActualInstaller"));
  assert.doesNotMatch(sandbox + main, /Set-ItemProperty|Remove-ItemProperty|Remove-Item|CreateSubKey|DeleteSubKey|ProxyEnable\s*=|taskkill/i);
  assert.match(main, /ProductionTransitionEnabled = \$false/);
  assert.match(main, /AppReported|Arguments reported inside/);
  assert.match(main, /if \(-not \$report\.ProxyUnchanged\) \{\s+\$report\.Status = 'failed'/);
  assert.match(main, /catch \{ \$report\.ProxyUnchanged = \$false; \$proxyFailure = \$_ \}/);
  assert.ok(main.indexOf("acceptance-report.json") < main.indexOf("throw $proxyFailure"));
  assert.match(main, /if \(\$proxyFailure -and -not \$originalFailure\) \{ throw \$proxyFailure \}/);
  assert.match(main, /\$originalFailure = \$_/);
});

test("真实双根/P与/S/参数/旧入口/记录/未知文件/失败/受限卸载接线存在，不自动宣布完整迁移", async () => {
  const main = await source("./windows/qa/Invoke-ChordVInstallerAcceptance.ps1");
  const cases = await source("./windows/qa/InstallerCases.psm1");
  assert.match(main, /default-passive.*'\/P'/); assert.match(main, /custom-silent-quoted-edge.*'\/S'/);
  for (const term of ["/UPDATE /R /ARGS", "chordv-desktop.exe", "chordv_desktop.exe", "ExistingMutex", "ConflictingDirectory", "UnknownFileHashes", "Uninstall.exe", "WindowsParsedArguments", "AppReportedArguments = 'not-observed'"]) assert.ok(cases.includes(term));
  assert.match(main, /'中文 参数', '\/路径\/参数', ''/);
  assert.match(cases, /WaitForApp\(20000\)/); assert.match(cases, /Where-Object InstallProgress/);
  assert.match(cases, /observations-passed-not-full-migration-acceptance/);
  assert.doesNotMatch(cases, /Start-Sleep|while\s*\(|mock\.exe|verified\s*=\s*\$true/i);
  const observer = await source("./windows/qa/InstallerObservation.cs");
  assert.match(observer, /SetWinEventHook/); assert.match(observer, /GetMessage/);
  assert.match(observer, /CommandLineToArgvW/); assert.doesNotMatch(observer, /SendMessage\(|WriteProcessMemory|mouse_event/);
});

test("workflow仅main手动、专属self-hosted交互账户、保护environment；不发布不远端触发", async () => {
  const workflow = await source("../.github/workflows/verify-windows-installer-runtime.yml");
  assert.match(workflow, /workflow_dispatch/); assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /self-hosted, Windows, X64, chordv-installer-disposable/);
  assert.match(workflow, /environment: windows-installer-disposable/);
  assert.match(workflow, /contents: read/); assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /vars.WINDOWS_QA_ACCOUNT_SID/); assert.match(workflow, /vars.WINDOWS_QA_LEASE_ID/);
  assert.doesNotMatch(workflow, /pull_request:|push:|schedule:|contents: write|workflow_dispatch\/|gh workflow|choco|docker|publish-github-release|stage-legacy/);
});
