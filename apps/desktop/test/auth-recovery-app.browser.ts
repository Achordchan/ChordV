import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("完整App退出后新登录不受旧刷新成功或旧401影响", { timeout: 70_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const artifacts = fileURLToPath(new URL("../../../.tmp/ui-qa/round27-frontend-heartbeat", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const server = await createServer({ configFile: false, envFile: false, root,
    cacheDir: `${artifacts}/auth-vite-cache`,
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
  const open = async () => {
    await page.goto(`${server.resolvedUrls!.local[0]}__lease-app?platform=web`);
    await page.getByRole("button", { name: "断开连接", exact: true }).waitFor();
    await page.waitForFunction(() => (window as any).leaseFixture.network.includes("/api/client/bootstrap"));
  };
  const stops = () => page.evaluate(() => (window as any).leaseFixture.calls.filter((name: string) => name === "disconnect_runtime").length);
  for (const outcome of ["success", "rejected"]) await t.test(outcome, async () => {
    await open();
    await page.evaluate(outcome => { (window as any).leaseFixture.beginPendingRefresh(outcome); window.dispatchEvent(new Event("focus")); }, outcome);
    await page.waitForFunction(() => (window as any).leaseFixture.network.includes("/api/auth/refresh"));
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await page.getByRole("textbox", { name: "邮箱", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("new@test.invalid");
    await page.getByLabel("密码", { exact: true }).fill("test-only-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByText("新登录用户", { exact: true }).waitFor();
    const stoppedBefore = await stops();
    await page.evaluate(() => (window as any).leaseFixture.releaseRefresh());
    // Flush the real HTTP bridge and React, without advancing the host clock.
    await page.waitForFunction(() => (window as any).leaseFixture.refreshCompleted() >= 1);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const diagnostic = await page.evaluate(() => ({ body: document.body.innerText, stored: (window as any).leaseFixture.stored(),
      calls: (window as any).leaseFixture.calls, network: (window as any).leaseFixture.network,
      completed: (window as any).leaseFixture.refreshCompleted() }));
    await writeFile(`${artifacts}/auth-final-diagnostic-${outcome}.json`, JSON.stringify(diagnostic, null, 2));
    await page.screenshot({ path: `${artifacts}/auth-final-diagnostic-${outcome}.png`, animations: "disabled" });
    assert.equal(await page.getByText("新登录用户", { exact: true }).count(), 1, "旧刷新不得切回旧账号或清理新登录");
    assert.equal(await page.evaluate(() => (window as any).leaseFixture.stored()?.accessToken), "test-only-new-access");
    assert.equal(await stops(), stoppedBefore, "旧401不得停止新账号的本机连接");
    await page.screenshot({ path: `${artifacts}/auth-recovery-${outcome}.png`, animations: "disabled" });
  });
  await t.test("错误密码在登录表单内提示，修改后可重新登录", async () => {
    await open();
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await page.setViewportSize({ width: 660, height: 440 });
    await page.getByLabel("邮箱", { exact: true }).fill("new@test.invalid");
    const password = page.getByLabel("密码", { exact: true });
    const submit = page.getByRole("button", { name: "登录", exact: true });
    await password.fill("test-only-wrong-password");
    await submit.click();
    const alert = page.locator("form").getByRole("alert").filter({ hasText: "邮箱或密码错误。" });
    await alert.waitFor({ timeout: 3500 });
    assert.equal(await page.getByText("邮箱或密码错误。", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const box = await alert.boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= 440);
    await password.fill("test-only-password");
    await alert.waitFor({ state: "detached" });
    await submit.click();
    await page.getByText("新登录用户", { exact: true }).waitFor();
  });
  await t.test("同一公告刷新保留倒计时，另一条公告重新计时", async () => {
    await open();
    const push = (id: string, title: string) => page.evaluate(([id, title]) => (window as any).leaseFixture.pushCountdown(id, title), [id, title]);
    await push("first", "初次显示");
    await page.getByRole("dialog", { name: "初次显示" }).getByRole("button", { name: /请等待 [23]s/ }).waitFor();
    await push("first", "内容刷新");
    const refreshed = page.getByRole("dialog", { name: "内容刷新" });
    await refreshed.waitFor();
    assert.doesNotMatch(await refreshed.getByRole("button").innerText(), /请等待 [45]s/);
    await refreshed.getByRole("button", { name: "我知道了" }).waitFor();
    await push("next", "第二条公告");
    const next = page.getByRole("dialog", { name: "第二条公告" });
    await next.getByRole("button", { name: "请等待 5s" }).waitFor();
    const confirm = next.getByRole("button");
    assert(await confirm.isDisabled());
    const button = await confirm.boundingBox(), dialog = await next.boundingBox();
    assert.ok(button && dialog && button.x >= dialog.x && button.y >= dialog.y &&
      button.x + button.width <= dialog.x + dialog.width && button.y + button.height <= dialog.y + dialog.height);
  });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
