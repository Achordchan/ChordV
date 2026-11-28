import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("连接主按钮在额度耗尽时禁用，组件下载失败也不例外", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({
    configFile: false, envFile: false, root,
    cacheDir: fileURLToPath(new URL("../../../.tmp/quota-control-vite", import.meta.url)),
    plugins: [react(), { name: "test-only-quota-control", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__quota-control") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><body><div id="root"></div><script type="module" src="/test/fixtures/quota-control.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 820, height: 588 } });
  const external: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  await page.goto(`${server.resolvedUrls!.local[0]}__quota-control`);
  const primary = page.locator(".control-primary-action");
  await page.getByRole("button", { name: "启动连接", exact: true }).waitFor();
  const initialBounds = await primary.boundingBox();
  assert.ok(initialBounds);
  assert.equal(await primary.isEnabled(), true);
  await primary.click(); assert.equal(await page.getByTestId("attempts").innerText(), "1");
  await page.getByRole("button", { name: "测试：耗尽额度", exact: true }).click();
  assert.equal((await primary.innerText()).trim(), "流量已用尽");
  assert.equal(await primary.isDisabled(), true);
  await primary.click({ force: true });
  assert.equal(await page.getByTestId("attempts").innerText(), "1", "耗尽的禁用按钮不能触发回调");
  await page.getByRole("button", { name: "测试：恢复额度", exact: true }).click();
  assert.equal((await primary.innerText()).trim(), "启动连接");
  assert.equal(await primary.isEnabled(), true);
  await primary.click(); assert.equal(await page.getByTestId("attempts").innerText(), "2");
  await page.getByRole("button", { name: "测试：组件下载失败" }).click();
  assert.equal((await primary.innerText()).trim(), "重试下载组件");
  await primary.click();
  assert.equal(await page.getByTestId("attempts").innerText(), "3");
  await page.getByRole("button", { name: "测试：耗尽额度" }).click();
  assert.equal((await primary.innerText()).trim(), "流量已用尽");
  assert.equal(await primary.isDisabled(), true, "下载失败不应放开已耗尽额度的连接入口");
  await primary.click({ force: true });
  assert.equal(await page.getByTestId("attempts").innerText(), "3");
  assert.deepEqual(await primary.boundingBox(), initialBounds, "额度与下载状态变化不能移动按钮");
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});
