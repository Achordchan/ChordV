import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, type Locator } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("生命周期持久反馈不遮挡820×588控件，660×468和390登录保留双错误及长原因详情", { timeout: 90_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ configFile: false, envFile: false, root,
    cacheDir: fileURLToPath(new URL("../../../.tmp/native-lifecycle-layout-vite", import.meta.url)),
    plugins: [react(), { name: "test-only-native-lifecycle-layout", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__native-lifecycle-layout") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/test/fixtures/native-lifecycle-layout.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 820, height: 588 } });
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  const artifacts = fileURLToPath(new URL("../../../.tmp/ui-qa", import.meta.url)); await mkdir(artifacts, { recursive: true });
  const measurements: unknown[] = [];
  const clickReachable = async (button: Locator, name: string) => {
    const geometry = await button.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { box: rect.toJSON(), hit: Boolean(hit && element.contains(hit)) };
    });
    assert.ok(geometry.box.top >= 0 && geometry.box.bottom <= (await page.viewportSize())!.height, `${name}必须完整处于固定窗口内`);
    assert.equal(geometry.hit, true, `${name}不能被持久提示覆盖`);
    await button.click();
  };
  const controlNames = [["公告", "announcements"], ["工单", "tickets"], ["检查更新", "update"],
    ["更多操作", "more"], ["启动连接", "connect"], ["自定义分流", "routing"], ["连接诊断", "diagnostics"]];
  const clickAllControls = async () => {
    for (const [label, name] of controlNames) {
      await clickReachable(page.getByRole("button", { name: label, exact: true }), name);
      if (name === "more") await page.getByRole("menuitem", { name: "刷新订阅", exact: true }).click();
    }
  };
  for (const mode of ["user", "team"]) {
    await page.goto(`${server.resolvedUrls!.local[0]}__native-lifecycle-layout?mode=${mode}`);
    await page.waitForFunction(() => Boolean((window as any).lifecycleLayoutTest));
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    const baseline = await page.locator(".desktop-content").boundingBox();
    const headerBaseline = await page.locator(".subscription-card").boundingBox();
    await page.evaluate(() => (window as any).lifecycleLayoutTest.notice({ kind: "runtime-interrupted", cause: "watchdog-exited",
      proxyRestored: true, message: "代理恢复进程已退出，连接已断开，请重新连接。" }));
    await page.getByRole("alert").filter({ hasText: "连接已断开" }).waitFor();
    await page.screenshot({ path: `${artifacts}/native-lifecycle-layout-${mode}.png` });
    await clickAllControls();
    const clicks = await page.evaluate(() => (window as any).lifecycleLayoutTest.clicks);
    for (const name of ["announcements", "tickets", "update", "refresh", "connect", "routing", "diagnostics"]) assert.ok(clicks.includes(name));
    const feedback = page.getByRole("alert").filter({ hasText: "连接已断开" });
    const feedbackBox = await feedback.boundingBox();
    assert.deepEqual(await page.locator(".subscription-card").boundingBox(), headerBaseline, "持久反馈不能改变个人/团队头视觉尺寸");
    measurements.push({ mode, state: "short", header: headerBaseline, feedback: feedbackBox,
      primary: await page.locator(".control-primary-action").boundingBox(), footer: await page.locator(".control-footer").boundingBox() });
    assert.ok(feedbackBox && feedbackBox.height <= 58, "反馈区最高两行，不得挤走连接按钮");
    for (const selector of [".subscription-actions--toolbar", ".control-primary-action", ".control-footer"]) {
      const rect = await page.locator(selector).boundingBox();
      assert.ok(rect && feedbackBox && (rect.y + rect.height <= feedbackBox.y || feedbackBox.y + feedbackBox.height <= rect.y), `${selector}不能与反馈bounds相交`);
    }
    await page.getByRole("button", { name: "关闭系统提示", exact: true }).click();
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.deepEqual(await page.locator(".desktop-content").boundingBox(), baseline, "关闭提示后零占位，双栏恢复原布局");
    const reason = "权限校验失败：" + "独立代理日志恢复被拒绝，保留原始错误原因。".repeat(35) + "END-OF-ORIGINAL-REASON";
    await page.evaluate(reason => (window as any).lifecycleLayoutTest.notice({ kind: "runtime-interrupted", cause: "watchdog-exited",
      proxyRestored: false, message: `代理恢复进程已退出，系统代理恢复未完成，请重试断开连接。原因：${reason}` }), reason);
    const longFeedback = page.getByRole("alert").filter({ hasText: "系统代理待恢复" });
    assert.ok((await longFeedback.boundingBox())!.height <= 58);
    await clickAllControls();
    const longBox = await longFeedback.boundingBox();
    for (const selector of [".subscription-actions--toolbar", ".control-primary-action", ".control-footer"]) {
      const rect = await page.locator(selector).boundingBox();
      assert.ok(rect && longBox && (rect.y + rect.height <= longBox.y || longBox.y + longBox.height <= rect.y), `${selector}不能与长消息反馈bounds相交`);
    }
    await page.screenshot({ path: `${artifacts}/native-lifecycle-layout-${mode}-long.png` });
    measurements.push({ mode, state: "long", feedback: longBox,
      primary: await page.locator(".control-primary-action").boundingBox(), footer: await page.locator(".control-footer").boundingBox() });
    await page.getByRole("button", { name: "查看系统提示详情", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      for (let node: Element | null = dialog; node; node = node.parentElement) {
        if (getComputedStyle(node).opacity !== "1" || node.getAnimations().some(animation => animation.playState === "running")) return false;
      }
      return true;
    });
    assert.match(await dialog.innerText(), /END-OF-ORIGINAL-REASON/);
    assert.ok((await dialog.innerText()).includes(reason), "详情完整保留原始原因，不以摘要替代");
    const dialogBox = await dialog.boundingBox();
    assert.ok(dialogBox && dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 588, "长原因详情在固定窗口内滚动");
    await page.screenshot({ path: `${artifacts}/native-lifecycle-layout-${mode}-details.png` });
    await page.getByRole("button", { name: "关闭系统提示详情", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "关闭系统提示", exact: true }).click();
    await page.evaluate(() => (window as any).lifecycleLayoutTest.ordinary());
    await page.getByText("普通短时提示", { exact: true }).waitFor();
    assert.equal(await page.locator(".desktop-content").boundingBox().then(box => box!.y), baseline!.y, "普通短时toast维持原行为");
  }
  for (const viewport of [{ width: 660, height: 468 }, { width: 390, height: 760 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${server.resolvedUrls!.local[0]}__native-lifecycle-layout?mode=login`);
    await page.waitForFunction(() => Boolean((window as any).lifecycleLayoutTest));
    await page.evaluate(() => (window as any).lifecycleLayoutTest.notice({ kind: "startup-recovery-failed", message: "startup-original-cause" }));
    await page.getByRole("alert").filter({ hasText: "启动恢复未完成" }).waitFor();
    assert.equal(await page.getByText("邮箱或密码错误", { exact: true }).count(), 1, "生命周期反馈不可覆盖真实登录失败");
    assert.equal(await page.locator(".auth-screen__error").count(), 2, "复用内联错误宿主，分别保留两类原因");
    await page.getByRole("button", { name: "查看系统提示详情", exact: true }).click();
    assert.match(await page.getByRole("dialog").innerText(), /startup-original-cause/);
    await page.getByRole("button", { name: "关闭系统提示详情", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await clickReachable(page.getByRole("button", { name: "账号帮助", exact: true }), "login-help");
    await page.getByRole("button", { name: "关闭账号帮助", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await clickReachable(page.getByRole("button", { name: "登录", exact: true }), "login");
    measurements.push({ mode: "login", viewport,
      feedback: await page.getByRole("alert").filter({ hasText: "启动恢复未完成" }).boundingBox(),
      login: await page.getByRole("button", { name: "登录", exact: true }).boundingBox(),
      help: await page.getByRole("button", { name: "账号帮助", exact: true }).boundingBox() });
    assert.ok((await page.evaluate(() => (window as any).lifecycleLayoutTest.clicks)).includes("login"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${artifacts}/native-lifecycle-layout-login-${viewport.width}.png` });
    await page.getByRole("button", { name: "关闭系统提示", exact: true }).click();
    assert.equal(await page.getByText("邮箱或密码错误", { exact: true }).count(), 1);
  }
  await writeFile(`${artifacts}/native-lifecycle-layout-geometry.json`, JSON.stringify(measurements, null, 2));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
