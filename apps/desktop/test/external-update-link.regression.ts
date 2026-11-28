import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { openExternalUrl } from "../src/lib/runtime";
import { cancelPreparedDesktopUpdate } from "../src/lib/nativeInstaller";
import { isCustomerSafeText } from "../src/lib/userFacingErrors";

// Exercise the real runtime adapter and update action without opening user apps.
async function main() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalMygo = Object.getOwnPropertyDescriptor(globalThis, "mygo");
  const calls: unknown[] = [];
  const testWindow = {
    navigator: { userAgent: "Windows" },
    mygo: {
      platform: "windows",
      call: async (method: string, command: string, args: unknown) => {
        assert.equal(method, "DesktopService.Invoke");
        calls.push([command, args]);
        return { ok: true };
      }
    },
    open: () => { throw new Error("Desktop must use native browser dispatch"); }
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: testWindow });
  Object.defineProperty(globalThis, "mygo", { configurable: true, value: testWindow.mygo });
  try {
    assert.deepEqual(await openExternalUrl(" https://example.com/setup.exe "), { ok: true });
    assert.deepEqual(calls, [["open_external_url", { url: "https://example.com/setup.exe" }]]);
    assert.deepEqual(await openExternalUrl("  "), { ok: false });
    assert.deepEqual(await cancelPreparedDesktopUpdate(), { ok: true });
    assert.deepEqual(calls.at(-1), ["cancel_desktop_update_install", {}], "准备取消通过职责模块直接派发原生命令");
    testWindow.mygo.call = async () => { throw new Error("Native browser failed"); };
    await assert.rejects(openExternalUrl("https://example.com/setup.exe"), /Native browser failed/);
    await assert.rejects(cancelPreparedDesktopUpdate(), /Native browser failed/, "原生取消失败必须传递给安装流程");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      navigator: { userAgent: "Browser" }, open: () => null
    } });
    assert.deepEqual(await openExternalUrl("https://example.com/setup.exe"), { ok: false });
    assert.deepEqual(await cancelPreparedDesktopUpdate(), { ok: false }, "浏览器不能假装取消了原生helper");
    const popup = { opener: {} as unknown, location: { replace: (url: string) => {
      assert.equal(popup.opener, null, "Detach opener before visiting external content");
      assert.equal(url, "https://example.com/setup.exe");
    } }, close: () => {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      navigator: { userAgent: "Browser" }, open: () => popup
    } });
    assert.deepEqual(await openExternalUrl("https://example.com/setup.exe"), { ok: true });

    const source = readFileSync(new URL("../src/hooks/useUpdateFlow.ts", import.meta.url), "utf8");
    const callback = source.match(/const handleUpdateDownload = useCallback\((async \([^)]*\) => \{[\s\S]*?\n  \}), \[/)?.[1];
    assert.ok(callback, "Production download action must be exercised");
    const compiled = ts.transpileModule(`const action = ${callback};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText;
    for (const outcome of ["success", "false", "throw"]) {
      const notices: Array<{ tone: string; title: string; message?: string }> = [];
      const context = {
        updateInstallBusyRef: { current: false },
        isCustomerSafeText,
        effectiveUpdate: { downloadUrl: "https://example.com/setup.exe", deliveryMode: "external_download" },
        resolveUpdateDownloadUrl: (value: string) => value,
        updatePlatform: "windows",
        isDesktopManagedUpdate: () => false,
        options: { notify: (notice: { tone: string; title: string; message?: string }) => notices.push(notice) },
        openExternalUrl: async () => {
          if (outcome === "throw") throw new Error("Native browser failed");
          return { ok: outcome === "success" };
        }
      };
      const run = new Function(...Object.keys(context), `${compiled}; return action;`)(...Object.values(context));
      assert.equal(await run(), outcome === "success");
      assert.equal(notices.length, 1, "Exactly one result notification");
      assert.equal(notices[0].tone, outcome === "success" ? "info" : "danger");
      if (outcome !== "success") assert.equal(notices[0].title, "无法打开下载链接");
      if (outcome === "throw") assert.doesNotMatch(notices[0].message ?? "", /Native browser failed/, "raw English errors never reach the notice");
    }
  } finally {
    if (originalMygo) Object.defineProperty(globalThis, "mygo", originalMygo);
    else Reflect.deleteProperty(globalThis, "mygo");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
  // The installed legacy binary rejects EXE delivery before its downloader runs.
  // Keep the actual released parser as evidence; do not replace it with a model.
  const legacySource = readFileSync(new URL("fixtures/legacy-1.1.7-update-parser.txt", import.meta.url), "utf8");
  const legacyJs = ts.transpileModule(legacySource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const normalizeLegacy = new Function(`${legacyJs}; return normalizeUpdateCheckResult;`)();
  const fallback = { currentVersion: "1.1.7", platform: "windows", channel: "stable", artifactType: "zip" };
  const response = { hasUpdate: true, latestVersion: "1.1.8", deliveryMode: "desktop_installer_download",
    recommendedArtifact: { type: "setup.exe", downloadUrl: "https://example.com/setup.exe" } };
  assert.throws(() => normalizeLegacy(response, fallback), /Windows installer updates are disabled/);
  const external = normalizeLegacy({ ...response, deliveryMode: "external_download" }, fallback);
  assert.equal(external.deliveryMode, "external_download");
  assert.equal(external.downloadUrl, response.recommendedArtifact.downloadUrl);
  console.log("External update links: native dispatch, rejection, blocked popup and truthful notifications passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
