import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("真实App离线恢复永不返回时，先显示可交互登录页再确认本地首屏", { timeout: 40_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const artifacts = fileURLToPath(new URL("../../../.tmp/ui-qa", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const server = await createServer({ configFile: false, envFile: false, root,
    cacheDir: fileURLToPath(new URL("../../../.tmp/app-readiness-vite", import.meta.url)),
    resolve: { alias: { "@chordv/shared": fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)) } },
    plugins: [react(), { name: "test-only-app-readiness", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__app-readiness") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/test/fixtures/app-startup-readiness.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0 } });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 660, height: 468 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort("blockedbyclient"));
  await page.goto(`${server.resolvedUrls!.local[0]}__app-readiness?mode=offline`);
  await page.waitForFunction(() => (window as any).startupReadinessFixture?.network.includes("/api/client/bootstrap"));
  assert.equal(await page.getByRole("textbox", { name: "邮箱", exact: true }).isEnabled(), true, "离线会话恢复不能阻塞本地可交互首屏");
  await page.waitForFunction(() => (window as any).startupReadinessFixture.acknowledgements.length === 1, undefined, { timeout: 2500 });
  assert.equal(await page.getByRole("textbox", { name: "邮箱", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "账号帮助", exact: true }).click();
  await page.getByRole("dialog", { name: "账号帮助" }).waitFor();
  const ack = await page.evaluate(() => (window as any).startupReadinessFixture.acknowledgements[0]);
  assert.deepEqual(ack, { payload: { input: { screen: "login" } }, loginCommitted: true, emailEnabled: true });
  await page.getByRole("button", { name: "关闭账号帮助", exact: true }).click();
  await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
  for (const size of [{ width: 660, height: 468 }, { width: 820, height: 588 }, { width: 390, height: 760 }]) {
    await page.setViewportSize(size);
    const field = await page.getByRole("textbox", { name: "邮箱", exact: true }).boundingBox();
    assert.ok(field && field.x >= 0 && field.x + field.width <= size.width && field.y + field.height <= size.height, "真实登录首屏控件须处于窗口内");
    await page.screenshot({ path: `${artifacts}/app-readiness-offline-login-${size.width}x${size.height}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 820, height: 588 });
  await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("new@test.invalid");
  await page.getByLabel("密码", { exact: true }).fill("test-only-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByText("新登录用户", { exact: true }).waitFor();
  await page.evaluate(() => (window as any).startupReadinessFixture.releaseRestore());
  await page.waitForFunction(() => (window as any).startupReadinessFixture.completedNetwork.length === 2);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  assert.equal(await page.getByText("新登录用户", { exact: true }).count(), 1, "旧恢复迟到不能覆盖用户刚完成的新登录");
  assert.equal(await page.getByText("旧会话用户", { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => (window as any).startupReadinessFixture.stored().accessToken), "test-only-access-new",
    JSON.stringify(await page.evaluate(() => ({ stored: (window as any).startupReadinessFixture.stored(), saves: (window as any).startupReadinessFixture.savedSessions, calls: (window as any).startupReadinessFixture.calls, network: (window as any).startupReadinessFixture.network }))));
  assert.equal(await page.evaluate(() => (window as any).startupReadinessFixture.acknowledgements.length), 1, "登录切屏不重复确认启动");
  await page.screenshot({ path: `${artifacts}/app-readiness-manual-login-announcement-820x588.png`, animations: "disabled" });
  await page.getByRole("dialog").filter({ hasText: "维护提醒" }).getByRole("button", { name: "我知道了", exact: true }).click();
  const closeHint = page.getByRole("dialog", { name: "关闭窗口说明", exact: true });
  await closeHint.getByRole("button", { name: "我知道了", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0);
  await page.screenshot({ path: `${artifacts}/app-readiness-manual-login-820x588.png`, animations: "disabled" });

  for (const mode of ["no-session", "ack-failed", "resize-pending", "resize-failed"]) {
    await page.setViewportSize({ width: 660, height: 468 });
    await page.goto(`${server.resolvedUrls!.local[0]}__app-readiness?mode=${mode}`);
    await page.getByRole("heading", { name: "账号登录", exact: true }).waitFor();
    if (mode === "resize-failed") {
      await page.getByText("窗口尺寸调整未完成，请重试。", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).startupReadinessFixture.acknowledgements.length), 0, "布局失败不能确认健康");
      continue;
    }
    if (mode === "resize-pending") {
      await page.waitForFunction(() => (window as any).startupReadinessFixture.calls.includes("transition_main_window"));
      assert.equal(await page.evaluate(() => (window as any).startupReadinessFixture.acknowledgements.length), 0, "JS桥已可调用但本地布局未完成时不能确认");
      await page.evaluate(() => (window as any).startupReadinessFixture.releaseResize());
    }
    await page.waitForFunction(() => (window as any).startupReadinessFixture.acknowledgements.length === 1);
    if (mode === "ack-failed") {
      await page.getByText("启动确认未完成", { exact: true }).waitFor();
      await page.screenshot({ path: `${artifacts}/app-readiness-ack-failed-660x468.png`, animations: "disabled" });
      await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("retry@test.invalid");
      assert.equal(await page.evaluate(() => (window as any).startupReadinessFixture.acknowledgements.length), 1, "明确失败后不能用重复调用掩盖失败");
      assert.equal(await page.evaluate(() => (window as any).startupReadinessFixture.calls.some((name: string) => name === "quit_application" || name === "quit_for_update")), false, "候选退出由原生负责");
    } else {
      assert.equal(await page.getByRole("textbox", { name: "邮箱", exact: true }).isEnabled(), true);
      assert.equal(await page.evaluate(() => (window as any).startupReadinessFixture.network.includes("/api/client/bootstrap")), false, "无登录也可确认，不为确认启动请求认证API");
    }
  }
  await page.goto(`${server.resolvedUrls!.local[0]}__app-readiness?mode=recovery-pending`);
  const warning = page.getByText("更新结果待确认", { exact: true });
  await warning.waitFor();
  await page.waitForFunction(() => {
    const notice = document.querySelector(".mantine-Notification-root");
    if (!notice) return false;
    const r = notice.getBoundingClientRect();
    return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;
  });
  const bounds = await warning.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 660 && bounds.y >= 0 && bounds.y + bounds.height <= 468);
  await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("usable@test.invalid");
  const recoveryAdvice = "暂时无法新建连接或重新安装更新。请保留更新文件并联系客服。";
  for (const size of [{ width: 660, height: 468 }, { width: 390, height: 760 }]) {
    await page.setViewportSize(size);
    await page.goto(`${server.resolvedUrls!.local[0]}__app-readiness?mode=recovery-failed`);
    await page.getByText("更新安装未完全成功", { exact: true }).waitFor();
    const recoveryMessage = `更新失败，原版本已保留。 ${recoveryAdvice}`;
    const message = page.getByText(recoveryMessage, { exact: true });
    await message.waitFor();
    const notice = page.locator(".mantine-Notification-root").filter({ has: message });
    const initialBox = await notice.boundingBox();
    await page.waitForFunction((text) => {
      const matched = [...document.querySelectorAll(".mantine-Notification-root")].find((item) => item.textContent?.includes(text));
      if (!matched) return false;
      const r = matched.getBoundingClientRect();
      return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;
    }, recoveryMessage, { timeout: 1500 });
    const box = await notice.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height);
    t.diagnostic(`恢复提示 ${size.width}×${size.height}：初次 ${JSON.stringify(initialBox)}；进入窗口后 ${JSON.stringify(box)}`);
    assert.equal(await notice.count(), 1, "失败和恢复限制应在同一条提示里");
    assert.equal(await warning.count(), 0, "已确认失败不能同时提示结果待确认");
    await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("usable@test.invalid");
    await page.screenshot({ path: `${artifacts}/app-readiness-recovery-failed-${size.width}x${size.height}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 820, height: 588 });
  await page.goto(`${server.resolvedUrls!.local[0]}__app-readiness?mode=release-unavailable`);
  await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("new@test.invalid");
  await page.getByLabel("密码", { exact: true }).fill("test-only-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByText("新登录用户", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "账号登录", exact: true }).count(), 0, "业务初始化没有版本信息时仍须进入主界面");
  assert.equal(await page.evaluate(() => (window as any).startupReadinessFixture.stored().accessToken), "test-only-access-new");
  assert.deepEqual(errors, []);
});
