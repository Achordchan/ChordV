import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const artifacts = fileURLToPath(new URL("../../../output/playwright", import.meta.url));

async function geometry(page: Page) {
  return page.getByRole("dialog").evaluate(dialog => {
    const footer = [...dialog.querySelectorAll("button")].find(button => button.textContent === "检查更新")!;
    const overview = dialog.querySelector('[class*="_overview_"]')!;
    const boxes = [dialog, footer, dialog.querySelector("header")!, overview].map(element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
    });
    return { dialog: boxes[0], footer: boxes[1], header: boxes[2],
      overview: boxes[3], overviewClient: overview.clientHeight, overviewScroll: overview.scrollHeight,
      dialogClient: dialog.clientHeight, dialogScroll: dialog.scrollHeight,
      scrollTop: overview.scrollTop, overflow: getComputedStyle(overview).overflowY };
  });
}

async function waitForBusyButtonLayout(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll("button[data-loading]")].every(button => {
    const loader = button.querySelector(".mantine-Button-loader");
    if (!loader) return false;
    const bounds = button.getBoundingClientRect(), indicator = loader.getBoundingClientRect();
    return indicator.top >= bounds.top && indicator.bottom <= bounds.bottom;
  }));
}

test("更新中心底部操作固定可见，错误详情和历史页仅在中间滚动", { timeout: 60_000 }, async t => {
  const server = await createServer({
    configFile: false, envFile: false, root: desktopRoot,
    cacheDir: fileURLToPath(new URL("../../../.tmp/update-center-layout-vite", import.meta.url)),
    resolve: { alias: { "@chordv/shared": fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)) } },
    define: { "import.meta.env.VITE_GITHUB_RELEASE_REPOSITORY": "window.layoutTestRepository" },
    plugins: [react(), { name: "test-only-update-center-layout", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__update-center-layout") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>window.layoutTestRepository = new URLSearchParams(location.search).get("repository") ?? "fixture/layout-only";</script><div id="root"></div><script type="module" src="/test/fixtures/update-center-layout.tsx"></script></body></html>'));
      });
    } }],
    server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  t.after(() => server.close());
  await server.listen();
  const origin = server.resolvedUrls!.local[0];
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 820, height: 588 } });
  page.on("pageerror", error => console.error(error));
  const external: string[] = [];
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    external.push(url.href);
    if (url.hostname === "api.github.com" && url.pathname === "/repos/fixture/layout-only/releases") {
      return route.fulfill({ json: Array.from({ length: 25 }, (_, index) => ({
        tag_name: `v1.1.${30 - index}`, name: `布局回归版本 ${30 - index}`, draft: false, prerelease: false,
        body: "修复组件同步和更新中心显示。\n保留更新历史的独立滚动与返回入口。", published_at: "2026-11-16T00:00:00Z"
      })) });
    }
    return route.abort("blockedbyclient");
  });
  await mkdir(artifacts, { recursive: true });
  for (const size of [{ width: 820, height: 588 }, { width: 820, height: 560 }, { width: 390, height: 480 }]) {
    await page.setViewportSize(size);
    await page.goto(`${origin}__update-center-layout`);
    await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAnimations().every(animation => animation.playState === "finished"));
    const before = await geometry(page);
    assert.ok(before.footer.bottom <= before.dialog.bottom - 12, JSON.stringify(before));
    assert.ok(before.footer.y >= before.overview.bottom, "底部操作不能与可滚动内容重叠");
    assert.ok(before.dialogScroll <= before.dialogClient + 1, "dialog 本身不能溢出或裁切底部按钮");
    assert.equal(before.overflow, "auto");
    assert.ok(before.overviewScroll > before.overviewClient, "双行错误应只使中间区域滚动");
    await page.screenshot({ path: `${artifacts}/update-center-${size.width}x${size.height}-initial.png` });
    await page.locator('[class*="_overview_"]').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const after = await geometry(page);
    assert.ok(after.scrollTop > 0);
    assert.equal(after.footer.y, before.footer.y); assert.equal(after.header.y, before.header.y);
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByTestId("check-count").filter({ hasText: "1" }).waitFor();
    await page.screenshot({ path: `${artifacts}/update-center-${size.width}x${size.height}.png` });
    console.info(JSON.stringify({ viewport: size, ...after }));
  }
  const footerSummary = page.locator('[class*="_footer_"]');
  for (const [status, expected] of [["idle", "尚未检查"], ["checking", "正在检查…"], ["unsupported", "尚未配置 GitHub 发布仓库"], ["current", "上次成功检查版本："], ["failed", "本次检查失败"]]) {
    await page.goto(`${origin}__update-center-layout?status=${status}`);
    await footerSummary.filter({ hasText: expected }).waitFor();
    const bounds = await geometry(page);
    assert.ok(bounds.footer.bottom <= bounds.dialog.bottom && bounds.footer.y >= bounds.overview.bottom);
  }
  const releasePage = page.getByRole("button", { name: "打开 GitHub 发布页" });
  await page.evaluate(() => { window.open = () => null; });
  await releasePage.click();
  await page.getByRole("alert").filter({ hasText: "未能打开发布页" }).waitFor();
  const destinations: string[] = [];
  await page.context().route("https://github.com/**", route => {
    destinations.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<title>local observation</title>" });
  });
  await page.reload();
  const popup = page.waitForEvent("popup");
  await releasePage.click();
  const opened = await popup;
  await opened.waitForURL("https://github.com/fixture/layout-only/releases");
  assert.deepEqual(destinations, ["https://github.com/fixture/layout-only/releases"]);
  await opened.close();
  for (const repository of ["", "../untrusted"]) {
    await page.goto(`${origin}__update-center-layout?repository=${encodeURIComponent(repository)}`);
    await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
    assert.equal(await releasePage.count(), 0);
  }
  await page.setViewportSize({ width: 820, height: 588 });
  await page.goto(`${origin}__update-center-layout?status=current`);
  assert.equal(await page.getByLabel("与 GitHub 发布版本一致").count(), 2);
  assert.equal(await releasePage.count(), 0);
  await page.getByRole("button", { name: "查看更新日志" }).click();
  const history = page.getByRole("list", { name: "更新日志", exact: true });
  await history.waitFor();
  assert.equal(await history.locator(":scope > li").count(), 25);
  const headerY = await page.getByRole("button", { name: "返回更新中心" }).evaluate(element => element.getBoundingClientRect().y);
  assert.ok(await history.evaluate(element => element.scrollHeight > element.clientHeight));
  await history.evaluate(element => { element.scrollTop = element.scrollHeight; });
  assert.equal(await page.getByRole("button", { name: "返回更新中心" }).evaluate(element => element.getBoundingClientRect().y), headerY);
  await page.screenshot({ path: `${artifacts}/update-center-history.png` });
  await page.getByRole("button", { name: "返回更新中心" }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  for (const size of [{ width: 820, height: 588 }, { width: 390, height: 480 }]) {
    await page.setViewportSize(size);
    await page.goto(`${origin}__update-center-layout?ready=1`);
    const install = page.getByRole("button", { name: "立即安装", exact: true });
    await install.click();
    await page.getByTestId("install-count").filter({ hasText: "1" }).waitFor();
    assert.equal(await install.isDisabled(), true, "长准备期间不能重复安装");
    for (const control of [page.getByLabel(/接收测试版更新/),
      page.getByLabel(/自动在后台下载更新/),
      page.getByRole("button", { name: "检查更新", exact: true }),
      page.getByRole("button", { name: "关闭更新中心", exact: true }),
      ...await page.getByRole("button", { name: "重试", exact: true }).all()]) {
      assert.equal(await control.isDisabled(), true, "安装忙态必须禁用渠道、检查、组件更新和关闭控件");
      await control.evaluate(element => (element as HTMLElement).click());
    }
    await install.evaluate(element => (element as HTMLElement).click());
    await page.keyboard.press("Escape");
    assert.equal(await page.getByTestId("install-count").textContent(), "1");
    assert.equal(await page.getByTestId("close-count").textContent(), "0");
    assert.equal(await page.getByTestId("check-count").textContent(), "0");
    assert.equal(await page.getByTestId("component-update-count").textContent(), "0");
    await waitForBusyButtonLayout(page);
    const busyGeometry = await geometry(page);
    assert.ok(busyGeometry.footer.y >= busyGeometry.overview.bottom, "忙态底部操作不能重叠");
    assert.ok(busyGeometry.dialogScroll <= busyGeometry.dialogClient + 1, "忙态不能增加对话框溢出");
    await page.screenshot({ path: `${artifacts}/update-center-busy-${size.width}x${size.height}.png` });
    await page.evaluate(() => window.dispatchEvent(new Event("test-only-install-failed")));
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find(button => button.textContent === "立即安装");
      return Boolean(button && !button.disabled);
    });
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    assert.equal(await page.getByTestId("check-count").textContent(), "1", "失败清忙后恢复既有操作");
  }
  for (const surface of ["client", "progress"]) {
    await page.setViewportSize({ width: 820, height: 588 });
    await page.goto(`${origin}__update-center-layout?surface=${surface}`);
    const installs = page.getByRole("button", { name: "安装并重启", exact: true });
    await installs.first().click();
    await page.getByTestId("install-count").filter({ hasText: "1" }).waitFor();
    for (const control of await installs.all()) {
      assert.equal(await control.isDisabled(), true);
      await control.evaluate(element => (element as HTMLElement).click());
    }
    if (surface === "client") {
      assert.equal(await page.getByRole("button", { name: "关闭版本更新", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "稍后再说", exact: true }).isDisabled(), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.getByTestId("close-count").textContent(), "0");
    }
    assert.equal(await page.getByTestId("install-count").textContent(), "1");
    await waitForBusyButtonLayout(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "忙态不引入横向溢出");
    await page.screenshot({ path: `${artifacts}/update-${surface}-busy.png` });
  }
  assert.deepEqual(external, ["https://api.github.com/repos/fixture/layout-only/releases?per_page=30"], "唯一外部请求已由测试拦截，未连接真实服务");
});
