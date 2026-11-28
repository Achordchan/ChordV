import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const nativeRoot = resolve(import.meta.dirname, "../native");
const installer = readFileSync(resolve(nativeRoot, "installer.go"), "utf8");
const service = readFileSync(resolve(nativeRoot, "service.go"), "utf8");
const fixtureRoot = resolve(import.meta.dirname, "../../../tests/e2e/fixtures/windows-legacy");

function ordered(source: string, parts: string[]) {
  let previous = -1;
  for (const part of parts) {
    const index = source.indexOf(part);
    assert.ok(index > previous, `缺少或顺序错误：${part}`);
    previous = index;
  }
}

test("MyGo Windows更新只执行重新授权并校验的安装包，统一交接保留平台门禁", () => {
  const update = installer.slice(installer.indexOf("func (s *DesktopService) installWindowsUpdate"), installer.indexOf("func (s *DesktopService) consumeInstallReport"));
  ordered(update, [
    'runtime.GOOS != "windows"', 's.validatedInstaller("")', "s.handoffInstaller(ctx, p, installerHandoffOps{start: startWindowsInstaller"
  ]);
  const validate = installer.slice(installer.indexOf("func (s *DesktopService) validatedInstaller"), installer.indexOf("func (s *DesktopService) openInstaller"));
  ordered(validate, ["s.verifyGrantReceipt(p.Grant)", "p.SHA256 != p.Grant.SHA256", "filepath.EvalSymlinks(p.Path)", "verifyFile(p.Path, p.SHA256, p.Size)"]);
  assert.match(installer, /runtime\.GOOS == "windows" && ext != "\.exe"/);
  assert.match(service, /case "download_desktop_installer"/);
  assert.match(service, /case "install_windows_update"/);
  assert.doesNotMatch(update, /Copy-Item|Remove-Item|powershell|--installer-maintenance|tauri_plugin_updater/i);
});

test("安装信任链及失败生命周期执行真实Go行为测试，不以源码顺序匹配代替行为", () => {
  const names = [
    "TestManifestSignaturesAcceptPEMRawAndDERAndRejectChangedBytes",
    "TestNativeDownloadsRequireConfiguredManifestAuthorization",
    "TestManifestAuthorizationCannotTrustCallerSuppliedKey",
    "TestNativeReleaseFloorPersistsAndRejectsReplayOrChangedSameBuild",
    "TestVerifiedDownloadResumesAndPublishesOnlyValidFile",
    "TestDownloadRejectsHashMismatchAndPreservesPreviousFile",
    "TestDownloadRejectsWrongRangeAndLength",
    "TestInstallReportRequiresTypedResultBeforeConsumption",
    "TestInstallerHandoffStartFailureKeepsServiceRetryable",
    "TestInstallerHandoffReportFailureStillQuits",
    "TestInstallerHandoffActualReportWriteFailureStillQuits",
    "TestInstallerHandoffRejectsMissingCallbacksBeforeCleanup",
    "TestInstallerHandoffRevalidatesReceiptAndFile",
    "TestInstallerHandoffCleanupFailureDoesNotLaunch",
    "TestInstallerHandoffHonorsCancellationBeforeStart",
    "TestInstallerHandoffSerializesConcurrentAttempts",
    "TestInstallerHandoffStartFailurePreservesLiveSSEAndHeartbeat",
    "TestNSISInstallerCommandLinePinsUnquotedLastDirectory",
    "TestNSISInstallerCommandLineRejectsInjectionAndRelativePaths"
  ];
  const result = spawnSync("go", ["test", "-count=1", "-run", `^(${names.join("|")})$`, "-v", "."], {
    cwd:nativeRoot, encoding:"utf8", timeout:120000,
    env:{...process.env,CGO_ENABLED:"0",GOPROXY:"off",GOTOOLCHAIN:"local"}
  });
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stdout+result.stderr);
  for (const name of names) assert.ok(result.stdout.includes(`--- PASS: ${name} `),`未实际通过Go测试：${name}`);
  assert.doesNotMatch(result.stdout,/--- SKIP:/);
});

test("保留真实旧版Windows迁移基线的固定版本与摘要，不生成或伪装安装包", () => {
  const fixture = JSON.parse(readFileSync(resolve(fixtureRoot,"baseline.json"),"utf8"));
  assert.equal(fixture.version,"1.1.7");
  assert.equal(fixture.architecture,"x64");
  assert.equal(fixture.fileName,"ChordV_1.1.7_x64-setup.exe");
  assert.equal(fixture.downloadUrl,"https://github.com/Achordchan/ChordV/releases/download/v1.1.7/ChordV_1.1.7_x64-setup.exe");
  assert.equal(fixture.sha256,"c0f7a4c7914dcfdc600a20156d548230c369b205a77183e2ec390d73bacb8340");
  assert.equal(fixture.binaryIncluded,false);
  assert.ok(readdirSync(fixtureRoot).every((name)=>!/[.](?:exe|dll|zip)$/i.test(name)));
});
