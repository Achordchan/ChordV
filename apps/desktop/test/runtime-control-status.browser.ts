import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("ControlPanel只按真实运行信号显示启动状态及活跃端口", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ configFile: false, envFile: false, root,
    cacheDir: fileURLToPath(new URL("../../../.tmp/runtime-control-status-vite", import.meta.url)),
    plugins: [react(), { name: "test-only-runtime-control-status", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__runtime-control-status") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/test/fixtures/runtime-control-status.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  const artifacts = fileURLToPath(new URL("../../../.tmp/ui-qa", import.meta.url)); await mkdir(artifacts, { recursive: true });
  for (const width of [820, 390]) {
    await page.setViewportSize({ width, height: width === 820 ? 588 : 760 });
    await page.goto(`${server.resolvedUrls!.local[0]}__runtime-control-status`);
    const ports = page.getByLabel("本地代理端口", { exact: true });
    await page.getByText("内核已启动", { exact: true }).waitFor();
    assert.match(await ports.innerText(), /17890[\s\S]*17891/);
    for (const [scenario, label, live] of [
      ["error-stopped", "内核已停止", false], ["idle-ready", "内核已安装", false],
      ["error-running", "内核已启动", false], ["connecting", "内核已安装", false],
      ["idle-completed", "内核已安装", false], ["idle-stale-pid", "内核已安装", false],
      ["connected-missing-pid", "内核已安装", false], ["android-connected", "内核已启动", true],
      ["android-stopped", "内核已停止", false], ["connected", "内核已启动", true]
    ] as const) {
      await page.getByRole("button", { name: scenario, exact: true }).click();
      assert.equal(await page.getByText(label, { exact: true }).count(), 1, `${scenario}: ${await page.locator('.control-panel').innerText()}`);
      const text = await ports.innerText();
      if (live) assert.match(text, /17890[\s\S]*17891/);
      else { assert.match(text, /HTTP --[\s\S]*SOCKS --/); assert.doesNotMatch(text, /17890|17891/); }
      if (scenario === "error-stopped") {
        assert.equal(await page.getByRole("button", { name: "断开连接", exact: true }).isEnabled(), true, "异常清理入口保持可用");
        const layout = await page.getByText("内核已停止", { exact: true }).evaluate(element => ({
          bottom: element.getBoundingClientRect().bottom, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth
        }));
        assert.equal(layout.overflow, false); assert.ok(layout.bottom <= layout.height, "状态文案不能被固定尺寸裁切");
        await page.screenshot({ path: `${artifacts}/runtime-control-stopped-${width}.png` });
      }
    }
  }
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});
