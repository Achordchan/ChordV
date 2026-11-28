import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("真实组件hook区分未配置与下载失败，已安装组件保持可用", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({
    configFile: false, envFile: false, root,
    cacheDir: fileURLToPath(new URL("../../../.tmp/runtime-source-vite", import.meta.url)),
    resolve: { alias: { "@chordv/shared": fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)) } },
    define: { "import.meta.env.VITE_GITHUB_RELEASE_REPOSITORY": JSON.stringify("") },
    plugins: [react(), { name: "test-only-runtime-source", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__runtime-source-state") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/fixtures/runtime-source-state.tsx"></script></body></html>'));
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
  const artifacts = fileURLToPath(new URL("../../../output/playwright", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  for (const files of ["missing", "installed", "missing-record", "corrupt-record", "tampered", "size-mismatch", "legacy-unverified", "bundle-claims-ready"]) {
    await page.goto(`${server.resolvedUrls!.local[0]}__runtime-source-state?files=${files}`);
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-report"]')?.textContent?.includes('"source":"startup"'));
    let report = JSON.parse((await page.getByTestId("runtime-report").textContent())!);
    assert.equal(report.success, files === "installed"); assert.equal(report.summary.sourceConfigured, false);
    assert.equal(report.support.complete, files === "installed", "支持上下文必须按相同本地安装校验判完整");
    assert.deepEqual(report.summary.failed, []); assert.equal(report.summary.current, false);
    assert.equal(await page.getByTestId("runtime-ready").textContent(), String(files === "installed"));
    assert.equal(await page.getByTestId("runtime-phase").textContent(), files === "installed" ? "ready" : "unconfigured");
    if (files !== "installed") {
      assert.equal(await page.getByRole("region", { name: "组件状态" }).count(), 0);
      assert.ok((await page.getByText("组件未安装", { exact: true }).count()) > 0);
      assert.equal(await page.getByRole("button", { name: "重新下载" }).count(), 0);
      assert.equal(report.summary.xray.localVersion, null);
      assert.equal(report.summary.geo.localVersion, null);
      assert.equal(report.support.xrayVersion, null);
      assert.equal(report.support.geoVersion, null);
      if (files !== "missing") assert.match(report.summary.xray.message, /本地校验或安装记录未通过/);
    } else {
      assert.equal(await page.getByRole("region", { name: "组件状态" }).count(), 0);
      assert.equal(report.summary.xray.localVersion, "26.11.9");
      assert.equal(report.summary.xray.current, false); assert.equal(report.summary.xray.available, false);
      assert.equal(report.summary.xray.remoteVersion, null);
      assert.ok((await page.getByText("内核已安装", { exact: true }).count()) > 0);
    }
    assert.equal(await page.getByRole("region", { name: "组件下载进度" }).count(), 0, "没有下载时不渲染下载面板或空进度条");
    assert.equal(await page.getByRole("progressbar").count(), 0);
    assert.doesNotMatch(await page.locator("body").innerText(), /下载未完成|内核准备失败|请重试或查看详情/);
    await page.screenshot({ path: `${artifacts}/runtime-source-${files}.png` });
    await page.getByRole("button", { name: "检查连接前组件" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-report"]')?.textContent?.includes('"source":"connect"'));
    report = JSON.parse((await page.getByTestId("runtime-report").textContent())!);
    assert.equal(report.success, files === "installed");
    assert.ok(report.commands.includes("ensure_bundled_runtime_components"));
    assert.ok(report.commands.every((command: string) => ["desktop_runtime_environment", "get_runtime_component_local_info", "ensure_bundled_runtime_components"].includes(command)), JSON.stringify(report.commands));
    assert.deepEqual(report.summary.failed, []);
    assert.equal(await page.getByRole("region", { name: "组件下载进度" }).count(), 0, "点击连接前检查也不能让未配置状态变成下载进度浮层");
  }
  await page.goto(`${server.resolvedUrls!.local[0]}__runtime-source-state?files=installed-then-invalid`);
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-ready"]')?.textContent === "true");
  await page.getByRole("button", { name: "模拟本地记录失效" }).click();
  await page.getByRole("button", { name: "检查缓存连接" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-report"]')?.textContent?.includes('"source":"connect"'));
  const invalidated = JSON.parse((await page.getByTestId("runtime-report").textContent())!);
  assert.equal(invalidated.success, false, "ready缓存与近期GEO检查不能掩盖连接前安装记录失效");
  assert.equal(invalidated.support.complete, false);
  assert.equal(invalidated.support.xrayVersion, null);
  assert.equal(invalidated.support.geoVersion, null);
  assert.equal(await page.getByTestId("runtime-ready").textContent(), "false");
  assert.equal(await page.getByTestId("runtime-phase").textContent(), "unconfigured");
  assert.deepEqual(external, [], "仓库未配置时不尝试网络请求，更不能开始下载");
  assert.deepEqual(errors, []);
});
