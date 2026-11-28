import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { COMPONENT_CHECK_INTERVAL_MS, COMPONENT_CHECK_RETRY_BASE_MS, COMPONENT_CHECK_THROTTLE_MS } from "../src/lib/componentSyncLoop";

test("真实hook和浏览器时钟验证单飞、节流退避、窗口恢复、登出卸载及无配置退出", { timeout: 90_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ configFile: false, envFile: false, root,
    cacheDir: fileURLToPath(new URL("../../../.tmp/component-sync-vite", import.meta.url)),
    resolve: { alias: { "@chordv/shared": fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)) } },
    define: { "import.meta.env.VITE_GITHUB_RELEASE_REPOSITORY": "window.componentSyncTestRepository" },
    plugins: [react(), { name: "test-only-component-version-sync", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__component-version-sync") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html><body><div id="root"></div><script>window.componentSyncTestRepository=new URLSearchParams(location.search).has("unconfigured")?"":"fixture/components";</script><script type="module" src="/test/fixtures/component-version-sync.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  await page.clock.install({ time: new Date("2026-11-17T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-17T00:00:01Z"));
  await page.goto(`${server.resolvedUrls!.local[0]}__component-version-sync`);
  const snapshot = () => page.evaluate(() => (window as any).componentSyncFixture?.snapshot());
  await expect.poll(async () => Boolean(await snapshot())).toBe(true);
  await page.clock.runFor(1);
  await expect.poll(async () => (await snapshot()).calls).toBe(1);
  await page.evaluate(() => {
    (window as any).componentSyncFixture.request("windows");
    (window as any).componentSyncFixture.request();
    (window as any).componentSyncFixture.request();
    (window as any).componentSyncFixture.resolve(false);
  });
  await expect.poll(async () => Boolean((await snapshot()).syncError)).toBe(true);
  await page.clock.runFor(COMPONENT_CHECK_RETRY_BASE_MS - 1);
  assert.equal((await snapshot()).calls, 1);
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await page.clock.runFor(1);
  await expect.poll(async () => (await snapshot()).calls).toBe(2);
  await page.evaluate(() => { (window as any).componentSyncFixture.resolve(true); });
  await expect.poll(async () => (await snapshot()).syncError).toBe(null);
  await page.clock.runFor(COMPONENT_CHECK_INTERVAL_MS - 1); assert.equal((await snapshot()).calls, 2);
  await page.clock.runFor(1); await expect.poll(async () => (await snapshot()).calls).toBe(3);
  await page.evaluate(() => {
    (window as any).componentSyncFixture.busy(true);
    (window as any).componentSyncFixture.resolve(true);
    (window as any).componentSyncFixture.request();
    (window as any).componentSyncFixture.nativeConnected(true);
  });
  await expect.poll(async () => (await snapshot()).busy).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    (window as any).componentSyncFixture.busy(false);
  });
  await expect.poll(async () => (await snapshot()).busy).toBe(false);
  const hiddenReads = (await snapshot()).reads;
  await page.clock.runFor(COMPONENT_CHECK_THROTTLE_MS);
  assert.equal((await snapshot()).calls, 3); assert.equal((await snapshot()).reads, hiddenReads);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1);
  await expect.poll(async () => (await snapshot()).deferred).toBe(true);
  const reads = (await snapshot()).reads;
  await page.clock.runFor(COMPONENT_CHECK_INTERVAL_MS);
  assert.equal((await snapshot()).reads, reads, "已连接时不循环读取原生状态或启动同步");
  await page.evaluate(() => { (window as any).componentSyncFixture.disconnect(); });
  await page.clock.runFor(1); await expect.poll(async () => (await snapshot()).calls).toBe(4);
  await page.evaluate(() => { (window as any).componentSyncFixture.logout(); });
  await expect.poll(async () => (await snapshot()).accessToken).toBe(null);
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await page.clock.runFor(COMPONENT_CHECK_INTERVAL_MS);
  assert.equal((await snapshot()).calls, 4);
  await page.evaluate(() => { (window as any).componentSyncFixture.resolve(false); });
  assert.equal((await snapshot()).syncError, null, "登出后的迟到失败不污染界面");
  await page.evaluate(() => { (window as any).componentSyncFixture.login(); });
  await page.clock.runFor(1); await expect.poll(async () => (await snapshot()).calls).toBe(5);
  await page.evaluate(() => { (window as any).componentSyncFixture.reject(); });
  await expect.poll(async () => Boolean((await snapshot()).syncError)).toBe(true);
  await page.evaluate(() => { (window as any).componentSyncFixture.manualSuccess(); window.dispatchEvent(new Event("focus")); });
  await expect.poll(async () => (await snapshot()).syncError).toBe(null);
  await page.clock.runFor(COMPONENT_CHECK_THROTTLE_MS);
  await expect.poll(async () => (await snapshot()).calls).toBe(6);
  assert.equal((await snapshot()).maximum, 1);
  await page.evaluate(() => { (window as any).componentSyncFixture.unmount(); });
  await page.evaluate(() => { (window as any).componentSyncFixture.resolve(false); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(COMPONENT_CHECK_INTERVAL_MS * 2); assert.equal((await snapshot()).calls, 6);
  await page.goto(`${server.resolvedUrls!.local[0]}__component-version-sync?unconfigured`);
  await expect.poll(async () => Boolean(await snapshot())).toBe(true);
  await page.clock.runFor(COMPONENT_CHECK_INTERVAL_MS * 3);
  await page.evaluate(() => { (window as any).componentSyncFixture.request(); window.dispatchEvent(new Event("focus")); });
  await page.clock.runFor(COMPONENT_CHECK_INTERVAL_MS);
  assert.equal((await snapshot()).calls, 0); assert.equal((await snapshot()).reads, 0); assert.equal((await snapshot()).syncError, null);
  await page.evaluate(() => { (window as any).componentSyncFixture.unmount(); });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
