import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("通知不遮挡弹窗操作，长错误和嵌套切换不丢失", { timeout: 90000 }, async t => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, envFile: false,
    optimizeDeps: { entries: ["test/fixtures/admin-notifications.tsx"] },
    cacheDir: fileURLToPath(new URL("../../../.tmp/admin-notifications-vite", import.meta.url)),
    plugins: [react(), { name: "test-only-admin-notifications", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__admin-notifications") return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><body><div id="root"></div><script type="module" src="/test/fixtures/admin-notifications.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  const open = async (scenario = "policy", width = 1024, height = 768) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${server.resolvedUrls!.local[0]}__admin-notifications?scenario=${scenario}`);
  };
  const settle = () => page.waitForFunction(() => document.querySelector('[role="dialog"]') &&
    [...document.querySelectorAll('[role="dialog"], .mantine-Notification-root')].every(element =>
      getComputedStyle(element).opacity === "1" && element.getAnimations({ subtree: true }).every(animation => animation.playState === "finished")));
  const clearHit = async (button: ReturnType<typeof page.getByRole>) => {
    await settle();
    assert.equal(await button.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, "通知或分段控件不能覆盖操作按钮");
  };
  const contained = async () => {
    await settle();
    assert.equal(await page.locator('.mantine-Notification-root').evaluateAll(elements => elements.every(element => {
      const dialog = element.closest('[role="dialog"]');
      if (!dialog) return false;
      const notice = element.getBoundingClientRect(), box = dialog.getBoundingClientRect();
      return notice.x >= box.x && notice.right <= box.right;
    })), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  };
  await open();
  const save = page.getByRole("button", { name: "保存策略", exact: true });
  await save.click();
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(1);
  await page.waitForFunction(() => [...document.querySelectorAll(".mantine-Notification-root")].every(el => getComputedStyle(el).opacity === "1"));
  await mkdir(fileURLToPath(new URL("../../../.tmp/ui-qa", import.meta.url)), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("../../../.tmp/ui-qa/admin-notifications-policy.png", import.meta.url)) });
  assert.equal(await save.evaluate(button => {
    const rect = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }), true, "成功通知仍遮挡保存按钮，不能靠等待消失或强制点击通过");
  await save.click({ timeout: 2000 });
  await expect(page.getByRole("status")).toHaveText("保存次数：2");
  await contained(); await clearHit(save);
  await page.getByRole("textbox", { name: "默认模式", exact: true }).click();
  await page.getByRole("option", { name: "全局代理", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "默认模式", exact: true })).toHaveValue("全局代理");
  await clearHit(save);
  await page.getByRole("dialog").locator("button.mantine-Modal-close").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(2);
  assert.equal(await page.locator(".mantine-Notification-root").evaluateAll(elements => elements.every(el => !el.closest('[role="dialog"]'))), true);
  await page.getByRole("button", { name: "打开策略", exact: true }).click();
  await contained();
  await page.locator("#policy-notice-1 .mantine-Notification-closeButton").click();
  await page.locator("#policy-notice-2 .mantine-Notification-closeButton").click();
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
  await expect.poll(() => page.getByRole("dialog").evaluate(el => getComputedStyle(el).display)).toBe("block");

  for (const [width, height] of [[1440, 1000], [1024, 768], [390, 640]]) {
    await open("security", width, height);
    const id = await page.getByRole("switch", { name: "修改密码" }).getAttribute("id");
    await page.locator(`label[for="${id}"]`).click();
    const submit = page.getByRole("button", { name: "保存修改", exact: true });
    const passwords = page.locator('input[autocomplete="new-password"]');
    await passwords.nth(0).fill(" example-pass ");
    await passwords.nth(1).fill("example-pass");
    await expect(submit).toBeDisabled();
    for (const [value, valid] of [[" example-pass ", true], ["界".repeat(24), true], ["界".repeat(25), false], [" ".repeat(8), false], ["fixture-next", true]] as const) {
      await passwords.nth(0).fill(value);
      await passwords.nth(1).fill(value);
      assert.equal(await submit.isEnabled(), valid);
    }
    await submit.click(); await contained(); await clearHit(submit);
    await clearHit(page.getByRole("button", { name: "取消", exact: true }));
    const field = page.getByLabel(/^当前密码/);
    await field.scrollIntoViewIfNeeded();
    await submit.click(); await expect(page.getByRole("status")).toHaveText("保存次数：2");
    await contained(); await clearHit(submit);
    await page.screenshot({ path: fileURLToPath(new URL(`../../../.tmp/ui-qa/admin-notifications-security-${width}.png`, import.meta.url)) });
  }

  await open("long");
  await save.click(); await contained(); await clearHit(save);
  const description = page.locator(".mantine-Notification-description");
  assert.equal(await description.evaluate(el => getComputedStyle(el).userSelect), "text");
  assert.equal(await description.evaluate(el => el.scrollHeight > el.clientHeight), true, "长错误必须可以独立滚动查看，而非裁掉");
  await description.hover(); await page.mouse.wheel(0, 3000);
  await expect.poll(() => description.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: fileURLToPath(new URL("../../../.tmp/ui-qa/admin-notifications-long-error.png", import.meta.url)) });
  await page.getByRole("dialog").locator("button.mantine-Modal-close").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await description.hover(); await page.mouse.wheel(0, 30000);
  await expect.poll(() => description.evaluate(element => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length - "请求编号：fixture-end".length);
    range.setEnd(text, text.textContent!.length);
    const tail = range.getBoundingClientRect(), notice = element.closest(".mantine-Notification-root")!.getBoundingClientRect();
    return tail.top >= notice.top && tail.bottom <= notice.bottom && tail.bottom <= innerHeight;
  })).toBe(true);
  await page.locator(".mantine-Notification-closeButton").click();
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);

  await open("queue");
  await save.click(); await expect(page.locator(".mantine-Notification-root")).toHaveCount(3);
  await clearHit(save);
  for (let count = 1; count <= 5; count++) {
    await page.locator(`#policy-notice-${count} .mantine-Notification-closeButton`).click();
  }
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);

  await open("drawer");
  await save.click(); await contained(); await clearHit(save);
  await save.click(); await expect(page.getByRole("status")).toHaveText("保存次数：2");
  await contained(); await clearHit(save);
  await page.screenshot({ path: fileURLToPath(new URL("../../../.tmp/ui-qa/admin-notifications-drawer.png", import.meta.url)) });
  await page.getByRole("dialog").locator("button.mantine-Drawer-close").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(2);

  await open("nested");
  await save.click(); await contained();
  await page.getByRole("button", { name: "打开确认弹窗", exact: true }).click();
  const nested = page.getByRole("dialog", { name: "确认操作", exact: true });
  await expect(nested.locator(".mantine-Notification-root")).toHaveCount(1);
  await nested.getByRole("button", { name: "确认并提示", exact: true }).click();
  await expect(nested.locator(".mantine-Notification-root")).toHaveCount(2);
  await nested.locator("button.mantine-Modal-close").click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await contained(); await clearHit(save);

  await open("autoclose");
  await save.click(); await contained();
  const originalNotice = await page.locator("#policy-notice-1").elementHandle();
  await page.getByRole("dialog").locator("button.mantine-Modal-close").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.equal(await originalNotice!.evaluate(element => element === document.querySelector("#policy-notice-1")), true, "切换容器必须移动原节点，而非重新创建通知");
  await expect(page.getByTestId("notice-opens")).toHaveText("1");
  await expect(page.locator(".mantine-Notification-root")).toHaveCount(0, { timeout: 3000 });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
