import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("完整App遵循Native判停；Web typed终态、首次失败宽限和恢复单飞", { timeout: 70_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const artifacts = fileURLToPath(new URL("../../../.tmp/ui-qa/round27-frontend-heartbeat", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const server = await createServer({ configFile: false, envFile: false, root,
    cacheDir: `${artifacts}/vite-cache`,
    resolve: { alias: { "@chordv/shared": fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)) } },
    plugins: [react(), { name: "test-only-lease-app", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__lease-app") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/test/fixtures/lease-heartbeat-app.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0, hmr: false } });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 820, height: 588 } });
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(server.resolvedUrls!.local[0]).origin) return route.continue();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  const open = async (platform: string) => {
    await page.goto(`${server.resolvedUrls!.local[0]}__lease-app?platform=${platform}`);
    await page.getByRole("button", { name: "断开连接", exact: true }).waitFor();
    await page.waitForFunction(() => (window as any).leaseFixture.network.includes("/api/client/bootstrap"));
    await page.clock.install();
  };
  const stops = () => page.evaluate(() => (window as any).leaseFixture.calls.filter((name: string) => name === "disconnect_runtime").length);
  await open("macos");
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as any).leaseFixture.emitHeartbeat(false));
    await page.clock.runFor(31_000);
    assert.equal(await stops(), 0, "桌面临时失败不能被界面提前判停");
    assert.equal(await page.getByRole("dialog", { name: "连接已过期", exact: true }).count(), 0);
  }
  await page.evaluate(() => (window as any).leaseFixture.emitHeartbeat(true, "old-lease"));
  assert.equal(await stops(), 0);
  await page.evaluate(() => (window as any).leaseFixture.emitHeartbeat(true));
  await page.getByRole("dialog", { name: "连接已过期", exact: true }).waitFor();
  assert.equal(await stops(), 0, "明确终态由Native清理，界面只显示原因");
  await page.evaluate(() => (window as any).leaseFixture.interrupt());
  await page.getByRole("alert").filter({ hasText: "系统代理待恢复" }).waitFor();
  for (const width of [820, 390]) {
    await page.setViewportSize({ width, height: width === 820 ? 588 : 760 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${artifacts}/native-lease-cleanup-${width}.png`, animations: "disabled" });
  }

  await open("web");
  await page.evaluate(() => (window as any).leaseFixture.setHeartbeat("expired"));
  await page.clock.runFor(5_100);
  await page.getByRole("dialog", { name: "连接已过期", exact: true }).waitFor();
  assert.equal(await stops(), 1, "2xx expired不是续租成功");

  await open("web");
  await page.evaluate(() => (window as any).leaseFixture.setHeartbeat("transient"));
  await page.clock.runFor(5_100);
  assert.equal(await stops(), 0, "503中的过期文字不能升级为终态");
  await page.clock.runFor(29_000);
  assert.equal(await stops(), 0, "从首次失败起算，宽限未到不能停");
  await page.clock.runFor(6_000);
  assert.equal(await stops(), 1, "宽限耗尽断连");

  await open("web");
  await page.evaluate(() => (window as any).leaseFixture.setHeartbeat("refresh-outage"));
  await page.clock.runFor(5_100);
  assert.equal(await stops(), 0, "401刷新遇503不是明确凭据撤销");
  await page.clock.runFor(29_000);
  assert.equal(await stops(), 0);
  await page.clock.runFor(6_000);
  assert.equal(await stops(), 1, "原token返回不能让临时失败永远不累计");
  assert.ok(await page.evaluate(() => (window as any).leaseFixture.network.includes("/api/auth/refresh")));
  for (const reason of ["account_disabled", "team_access_revoked"]) {
    await open("web");
    await page.evaluate(reason => (window as any).leaseFixture.setHeartbeat(reason), reason);
    await page.clock.runFor(5_100);
    assert.equal(await stops(), 1);
    assert.equal(await page.evaluate(() => (window as any).leaseFixture.stored()), null, "typed撤权必须清登录而非普通断连");
  }

  await open("web");
  await page.evaluate(() => (window as any).leaseFixture.setHeartbeat("pending"));
  await page.clock.runFor(5_100);
  const before = await page.evaluate(() => (window as any).leaseFixture.renewals());
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(11_000);
  assert.equal(await page.evaluate(() => (window as any).leaseFixture.renewals()), before, "定时器和恢复检查共享同一请求");
  await page.evaluate(() => { (window as any).leaseFixture.setHeartbeat("active"); (window as any).leaseFixture.release(); });
  await page.clock.runFor(100);
  assert.equal(await stops(), 0);
  await page.clock.runFor(5_100);
  assert.equal(await page.evaluate(() => (window as any).leaseFixture.renewals()), before + 1);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
