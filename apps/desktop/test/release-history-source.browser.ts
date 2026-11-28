import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("更新日志区分未配置与网络失败，只有网络失败可重试", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({
    configFile: false, envFile: false, root,
    cacheDir: fileURLToPath(new URL("../../../.tmp/release-history-source-vite", import.meta.url)),
    resolve: { alias: { "@chordv/shared": fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)) } },
    define: { "import.meta.env.VITE_GITHUB_RELEASE_REPOSITORY": "window.releaseHistoryTestRepository" },
    plugins: [react(), { name: "test-only-release-history-source", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__release-history-source") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><body><div id="root"></div><script>window.releaseHistoryTestRepository = new URLSearchParams(location.search).has("configured") ? "fixture/history-only" : "";</script><script type="module" src="/test/fixtures/release-history-source.tsx"></script></body></html>'));
      });
    } }], server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  t.after(() => server.close()); await server.listen();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const external: string[] = [], errors: string[] = [];
  let requests = 0, raceRequests = 0, raceMode = false;
  let paging = false;
  const pages: number[] = [];
  let finishDelayed!: () => void;
  let delayedStarted!: () => void;
  const hasDelayed = new Promise<void>(resolve => { delayedStarted = resolve; });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    external.push(url.href);
    if (paging && url.origin === "https://api.github.com" && url.pathname === "/repos/fixture/history-only/releases") {
      const number = Number(url.searchParams.get("page") ?? "1");
      pages.push(number);
      if (number === 1) return route.fulfill({ headers: { Link: '<https://api.github.com/repositories/123/releases?page=2>; rel="next", <https://api.github.com/repositories/123/releases?page=2>; rel="last"', "Access-Control-Expose-Headers": "Link" }, json: Array.from({ length: 30 }, (_, i) => ({
        tag_name: i === 29 ? "v9.0.0-beta.1" : `server-v1.0.${i}`, name: "非正式桌面版本", draft: false, prerelease: false
      })) });
      if (number === 2 && pages.filter(n => n === 2).length === 1) return route.fulfill({ status: 503, body: "temporarily unavailable" });
      if (number === 2) return route.fulfill({ headers: { Link: '<https://api.github.com/repositories/123/releases?page=1>; rel="prev"', "Access-Control-Expose-Headers": "Link" }, json: Array.from({ length: 30 }, (_, i) => ({ tag_name: `v1.1.${i}`, name: i === 12 ? "桌面正式版" : `桌面版本 ${i}`, draft: false, prerelease: false })) });
      return route.abort();
    }
    if (url.href === "https://api.github.com/repos/fixture/history-only/releases?per_page=30") {
      if (raceMode) {
        const request = ++raceRequests;
        if (request === 1) return route.fulfill({ status: 503, body: "test-only unavailable" });
        if (request === 2) await new Promise<void>(resolve => { finishDelayed = resolve; delayedStarted(); });
        return route.fulfill({ json: [{ tag_name: request === 2 ? "v1.1.13" : "v1.2.0-beta.1",
          name: request === 2 ? "旧正式版" : "新测试版", draft: false, prerelease: request !== 2, body: "测试隔离响应" }] });
      }
      requests++;
      return requests === 1 ? route.fulfill({ status: 503, body: "test-only unavailable" }) : route.fulfill({ json: [] });
    }
    return route.abort("blockedbyclient");
  });
  const origin = server.resolvedUrls!.local[0];
  await page.goto(`${origin}__release-history-source`);
  await page.getByText("尚未配置 GitHub 发布仓库，本地版本未接入在线更新。", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await page.getByRole("button", { name: "重试" }).count(), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /网络|加载不出来/);
  assert.deepEqual(external, [], "未配置时不能发送网络请求");
  await page.goto(`${origin}__release-history-source?configured`);
  await page.getByText("更新日志暂时加载不出来，请检查网络后重试。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByText("还没有已发布的版本。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "重试" }).count(), 0);
  assert.equal(requests, 2, "重试真实重新调用更新日志传输边界");
  assert.deepEqual(external, Array(2).fill("https://api.github.com/repos/fixture/history-only/releases?per_page=30"));
  raceMode = true;
  await page.goto(`${origin}__release-history-source?configured`);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await hasDelayed;
  assert.equal(raceRequests, 2, "旧通道重试已开始并暂停响应");
  await page.getByRole("button", { name: "切换测试版", exact: true }).click();
  await page.getByText("新测试版", { exact: true }).waitFor();
  const lateResponse = page.waitForResponse("https://api.github.com/repos/fixture/history-only/releases?per_page=30");
  finishDelayed();
  await (await lateResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText("旧正式版", { exact: true }).count(), 0, "旧通道重试迟到不能覆盖新通道结果");
  assert.equal(await page.getByText("新测试版", { exact: true }).count(), 1);
  assert.equal(raceRequests, 3);
  paging = true;
  await page.setViewportSize({ width: 820, height: 560 });
  await page.goto(`${origin}__release-history-source?configured`);
  await page.getByText("本页没有此渠道的桌面版本。").waitFor();
  const next = page.getByRole("button", { name: "下一页", exact: true });
  const box = await next.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 560);
  assert.deepEqual(pages, [1], "不自动循环请求历史页");
  await next.click();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByText("桌面正式版", { exact: true }).waitFor();
  assert.equal(await next.count(), 0);
  await page.getByRole("button", { name: "上一页" }).click();
  await next.waitFor();
  assert.deepEqual(pages, [1, 2, 2, 1]);
  assert.deepEqual(errors, []);
});
