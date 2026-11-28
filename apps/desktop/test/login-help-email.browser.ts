import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("账号帮助处理原生邮件打开失败，最小窗口仍可操作", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({
    configFile: false, envFile: false, root,
    cacheDir: fileURLToPath(new URL("../../../.tmp/login-help-email-vite", import.meta.url)),
    plugins: [react(), { name: "test-only-login-help-email", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__login-help-email") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><body><div id="root"></div><script type="module" src="/test/fixtures/login-help-email.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 660, height: 468 } });
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  const artifacts = fileURLToPath(new URL("../../../.tmp/ui-qa", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  for (const height of [468, 440]) {
    await page.setViewportSize({ width: 660, height });
    for (const mode of ["reject", "false", "success"]) {
      await page.goto(`${server.resolvedUrls!.local[0]}__login-help-email?mode=${mode}`);
      await page.getByRole("button", { name: "账号帮助", exact: true }).click();
      const send = page.getByRole("button", { name: "发送邮件", exact: true });
      await send.click();
      if (mode !== "success") {
        await page.getByRole("alert").filter({ hasText: "未能打开邮件应用" }).waitFor({ timeout: 5000 });
        await page.waitForFunction(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog || !dialog.getAnimations({ subtree: true }).every(animation => animation.playState === "finished")) return false;
          for (let element: Element | null = dialog; element; element = element.parentElement) {
            if (getComputedStyle(element).opacity !== "1" || !element.getAnimations().every(animation => animation.playState === "finished")) return false;
          }
          return true;
        });
        assert.doesNotMatch(await page.getByRole("dialog").innerText(), /test-only|native|rejection/);
        const geometry = await page.getByRole("dialog").evaluate(dialog => ({
          box: dialog.getBoundingClientRect().toJSON(), client: dialog.clientHeight, scroll: dialog.scrollHeight,
          buttons: [...dialog.querySelectorAll("button")].map(e => e.getBoundingClientRect().toJSON()),
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth
        }));
        assert.equal(geometry.horizontalOverflow, false);
        assert.ok(geometry.box.y >= 0 && geometry.box.bottom <= height);
        assert.ok(geometry.scroll <= geometry.client + 1);
        assert.ok(geometry.buttons.every(button => button.y >= 0 && button.bottom <= height));
        await page.screenshot({ path: `${artifacts}/login-help-email-${mode}${height === 468 ? "" : "-440"}.png` });
        await page.getByRole("button", { name: "关闭账号帮助", exact: true }).click();
        await page.getByRole("button", { name: "账号帮助", exact: true }).click();
        assert.equal(await page.getByRole("alert").count(), 0, "重开帮助应清除上次失败提示");
      } else {
        await page.waitForFunction(() => (window as any).loginHelpEmailTest.requests.length === 1);
        assert.equal(await page.getByRole("alert").count(), 0);
      }
      const requests = await page.evaluate(() => (window as any).loginHelpEmailTest.requests as string[]);
      assert.equal(requests.length, 1);
      const address = new URL(requests[0]);
      assert.equal(address.protocol, "mailto:"); assert.equal(address.pathname, "achordchan@gmail.com");
      assert.deepEqual([...address.searchParams.keys()].sort(), ["body", "subject"]);
      assert.ok(address.searchParams.get("body")!.includes("\n\n登录邮箱：login-help@test.invalid"));
      assert.equal(await send.isEnabled(), true);
    }
  }
  await page.goto(`${server.resolvedUrls!.local[0]}__login-help-email?mode=delayed`);
  await page.getByRole("button", { name: "账号帮助", exact: true }).click();
  const send = page.getByRole("button", { name: "发送邮件", exact: true });
  await send.click({ clickCount: 2 });
  assert.equal(await send.isDisabled(), true);
  assert.equal(await page.evaluate(() => (window as any).loginHelpEmailTest.requests.length), 1, "忙态不重复请求系统打开");
  await page.getByRole("button", { name: "关闭账号帮助", exact: true }).click();
  await page.getByRole("button", { name: "账号帮助", exact: true }).click();
  await page.evaluate(() => (window as any).loginHelpEmailTest.rejectPending());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole("alert").count(), 0, "已关闭帮助的迟到失败不能回灌新弹窗");
  assert.equal(await send.isEnabled(), true);
  await send.click();
  await page.evaluate(() => (window as any).loginHelpEmailTest.rejectPending());
  await page.getByRole("alert").filter({ hasText: "未能打开邮件应用" }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).loginHelpEmailTest.requests.length), 2);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});
