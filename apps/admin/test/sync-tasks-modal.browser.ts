import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("真实同步任务组件按当前过滤结果显示空态，不借用其他对象全局总数", { timeout: 90000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: false, envFile: false,
    cacheDir: fileURLToPath(new URL("../../../.tmp/sync-tasks-vite", import.meta.url)),
    resolve: { alias: { "@chordv/shared": fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)) } },
    plugins: [react(), { name: "test-only-sync-tasks-modal", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__sync-tasks-modal") return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/fixtures/sync-tasks-modal.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  const artifacts = fileURLToPath(new URL("../../../output/playwright", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const open = async (scenario: string, scope = "node") => {
    await page.goto(`${server.resolvedUrls!.local[0]}__sync-tasks-modal?scenario=${scenario}&scope=${scope}`);
    await expect(page.getByRole("dialog", { name: "同步任务" })).toBeVisible();
  };
  const empty = () => page.getByText("暂无待处理任务", { exact: true });
  const more = () => page.getByText(/仍有其他待处理命令/);
  const rows = () => page.getByRole("dialog").locator("li");

  await t.test("过滤为空但其他对象全局摘要非零：节点/用户/订阅/团队均显示当前对象空态", async () => {
    for (const scope of ["node", "user", "subscription", "team"]) {
      await open("empty", scope);
      await expect(empty()).toBeVisible();
      await expect(page.getByText("当前对象没有待处理的同步任务。", { exact: true })).toBeVisible();
      await expect(more()).toHaveCount(0);
      await expect(rows()).toHaveCount(0);
    }
    await page.screenshot({ path: `${artifacts}/sync-tasks-filtered-empty.png` });
    const bounds = await page.getByRole("dialog").boundingBox();
    assert.ok(bounds && bounds.width <= 480 && bounds.x >= 0 && bounds.x + bounds.width <= 1180);
  });
  await t.test("过滤非空只呈现当前对象命令，不把其他节点数量当成截断依据", async () => {
    await open("nonempty");
    await expect(empty()).toHaveCount(0);
    await expect(rows()).toHaveCount(1);
    await expect(page.getByText("节点B", { exact: true })).toBeVisible();
    await expect(page.getByText("节点A", { exact: true })).toHaveCount(0);
    await expect(more()).toHaveCount(0);
    await page.screenshot({ path: `${artifacts}/sync-tasks-filtered-nonempty.png` });
  });
  await t.test("过滤页达到200条也不凭全局摘要猜测该对象还有任务", async () => {
    await open("full");
    await expect(rows()).toHaveCount(200);
    await expect(more()).toHaveCount(0);
    await expect(empty()).toHaveCount(0);
  });
  await t.test("未过滤页面保留全局摘要与超过200条的截断提示", async () => {
    await open("global");
    await expect(rows()).toHaveCount(200);
    await expect(page.getByText("仅展示最近 200 条命令，仍有其他待处理命令。", { exact: true })).toBeVisible();
    await expect(empty()).toHaveCount(0);
    await expect(page.getByRole("button", { name: "查看全部" })).toHaveCount(0);
    await open("global-empty");
    await expect(empty()).toBeVisible();
    await expect(page.getByText("连接撤销和节点命令均无待处理任务。", { exact: true })).toBeVisible();
  });
  await t.test("过滤详情加载时没有空态，成功返回空结果才显示空态", async () => {
    await open("loading");
    await expect(page.getByRole("status", { name: "正在加载数据" })).toBeVisible();
    await expect(empty()).toHaveCount(0);
    await expect(more()).toHaveCount(0);
    await page.evaluate(() => window.syncTasksFixture.resolveEmpty());
    await expect(page.getByRole("status", { name: "正在加载数据" })).toHaveCount(0);
    await expect(empty()).toBeVisible();
  });
  await t.test("过滤详情失败不是空态，已有结果失败时保留结果与错误提示", async () => {
    await open("loading");
    await page.evaluate(() => window.syncTasksFixture.fail());
    await expect(page.getByRole("alert")).toContainText("节点命令加载失败");
    await expect(empty()).toHaveCount(0);
    await expect(more()).toHaveCount(0);
    await open("stale-error");
    await expect(page.getByRole("alert")).toContainText("以下保留上次结果，可能已过期。");
    await expect(rows()).toHaveCount(1);
    await expect(empty()).toHaveCount(0);
    await expect(more()).toHaveCount(0);
  });
  await t.test("查看全部正常调用回调并恢复未过滤的全局队列", async () => {
    await open("empty");
    await page.getByRole("button", { name: "查看全部" }).click();
    assert.equal(await page.evaluate(() => window.syncTasksFixture.showAllClicks()), 1);
    await expect(empty()).toHaveCount(0);
    await expect(rows()).toHaveCount(2);
    await expect(page.getByText("节点A", { exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "查看全部" })).toHaveCount(0);
    await expect(more()).toHaveCount(0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "组件不得引入横向溢出");
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
