import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { openExternalUrl } from "../src/lib/runtime";

// Exercise the real runtime adapter and update action without opening user apps.
async function main() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: unknown[] = [];
  const testWindow = {
    navigator: { userAgent: "Windows" },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        calls.push([command, args]);
        return { ok: true };
      }
    },
    open: () => { throw new Error("Desktop must use native browser dispatch"); }
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: testWindow });
  try {
    assert.deepEqual(await openExternalUrl(" https://example.com/setup.exe "), { ok: true });
    assert.deepEqual(calls, [["open_external_url", { url: "https://example.com/setup.exe" }]]);
    assert.deepEqual(await openExternalUrl("  "), { ok: false });
    testWindow.__TAURI_INTERNALS__.invoke = async () => { throw new Error("Native browser failed"); };
    await assert.rejects(openExternalUrl("https://example.com/setup.exe"), /Native browser failed/);
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      navigator: { userAgent: "Browser" }, open: () => null
    } });
    assert.deepEqual(await openExternalUrl("https://example.com/setup.exe"), { ok: false });
    const popup = { opener: {} as unknown, location: { replace: (url: string) => {
      assert.equal(popup.opener, null, "Detach opener before visiting external content");
      assert.equal(url, "https://example.com/setup.exe");
    } }, close: () => {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      navigator: { userAgent: "Browser" }, open: () => popup
    } });
    assert.deepEqual(await openExternalUrl("https://example.com/setup.exe"), { ok: true });

    const source = readFileSync(new URL("../src/hooks/useUpdateFlow.ts", import.meta.url), "utf8");
    const callback = source.match(/const handleUpdateDownload = useCallback\((async \(\) => \{[\s\S]*?\n  \}), \[/)?.[1];
    assert.ok(callback, "Production download action must be exercised");
    const compiled = ts.transpileModule(`const action = ${callback};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText;
    for (const outcome of ["success", "false", "throw"]) {
      const notices: Array<{ color: string; title: string }> = [];
      const context = {
        effectiveUpdate: { downloadUrl: "https://example.com/setup.exe", deliveryMode: "external_download" },
        resolveUpdateDownloadUrl: (value: string) => value,
        updatePlatform: "windows",
        isDesktopManagedUpdate: () => false,
        options: { notify: (notice: { color: string; title: string }) => notices.push(notice) },
        openExternalUrl: async () => {
          if (outcome === "throw") throw new Error("Native browser failed");
          return { ok: outcome === "success" };
        }
      };
      const run = new Function(...Object.keys(context), `${compiled}; return action;`)(...Object.values(context));
      assert.equal(await run(), outcome === "success");
      assert.equal(notices.length, 1, "Exactly one result notification");
      assert.equal(notices[0].color, outcome === "success" ? "blue" : "red");
      if (outcome !== "success") assert.equal(notices[0].title, "无法打开下载链接");
    }
  } finally {
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
