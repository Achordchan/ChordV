import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  SLOW_MIRROR_MARKER,
  downloadWithMirrorFallback,
  MIN_MIRROR_BYTES_PER_SECOND,
  MIRROR_RANKING_TTL_MS,
  minimumSpeedForAttempt,
  rankDownloadUrls,
  rememberProbeResults,
  resetMirrorRankingCacheForTest,
  urlsNeedingProbe
} from "../src/lib/downloadMirrorRanking";

const github = "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202611102204/geosite.dat";
const geoip = "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202611102204/geoip.dat";
const server = "https://v.achord.cn/api/downloads/runtime-versions/f73b6e5f-3aa8-4769-ab03-a1df1a78b2de";
const urls = [`https://ghfast.top/${github}`, `https://gh-proxy.com/${github}`, github, server];
const probe = (url: string, ok: boolean, bytesPerSecond: number) => ({ url, ok, bytesPerSecond, bytesReceived: ok ? 1 : 0, elapsedMs: 1, error: ok ? null : "x" });

resetMirrorRankingCacheForTest();
assert.deepEqual(rankDownloadUrls(urls, 0), urls, "没有测速结果时保持后台顺序");
assert.deepEqual(urlsNeedingProbe(urls, 0), urls);

rememberProbeResults([
  probe(urls[0], true, 200_000),
  probe(urls[1], true, 3_000_000),
  probe(urls[2], false, 0),
  probe(urls[3], true, 50_000)
], 1000);
assert.deepEqual(rankDownloadUrls(urls, 2000), [urls[1], urls[0], urls[3], urls[2]], "最快的镜像优先，失败的放最后");

const geoipUrls = [`https://ghfast.top/${geoip}`, `https://gh-proxy.com/${geoip}`, geoip, server.replace("f73b", "8377"), `https://new-mirror.example/${geoip}`];
assert.deepEqual(urlsNeedingProbe(geoipUrls, 2000), [geoipUrls[4]], "同一批镜像按主机复用测速，只测新主机");
assert.deepEqual(rankDownloadUrls(geoipUrls, 2000), [geoipUrls[1], geoipUrls[0], geoipUrls[3], geoipUrls[4], geoipUrls[2]], "未测的主机排在可用主机之后、失败主机之前");
assert.deepEqual(urlsNeedingProbe(geoipUrls, 1000 + MIRROR_RANKING_TTL_MS), geoipUrls, "测速结果过期后重新测");
assert.deepEqual(rankDownloadUrls(urls, 1000 + MIRROR_RANKING_TTL_MS), urls);

assert.equal(minimumSpeedForAttempt(0, 3), MIN_MIRROR_BYTES_PER_SECOND);
assert.equal(minimumSpeedForAttempt(2, 3), null, "最后一个地址再慢也要下完");
assert.equal(minimumSpeedForAttempt(0, 1), null);
async function fallbackChecks() {
  const nativeSource = readFileSync(new URL("../native/download.go", import.meta.url), "utf8");
  const nativeMarker = nativeSource.match(/const downloadSlowMirrorMarker = "([^"]+)"/)?.[1];
  assert.equal(nativeMarker, SLOW_MIRROR_MARKER, "原生低速错误和前端切源重试必须共享同一标记契约");
  const slowError = () => new Error(`${nativeMarker}: 下载源持续低速，请切换其他源`);
  // 服务器副本可用但慢、其余全挂：先因慢被放弃，全部失败后不带门槛重试它。
  const calls: Array<[string, number | null]> = [];
  const used = await downloadWithMirrorFallback(["server", "mirror-down", "github-down"], async (url, min) => {
    calls.push([url, min]);
    if (url === "server" && min !== null) throw slowError();
    if (url !== "server") throw new Error("connect failed");
  });
  assert.equal(used, "server");
  assert.deepEqual(calls, [["server", MIN_MIRROR_BYTES_PER_SECOND], ["mirror-down", MIN_MIRROR_BYTES_PER_SECOND], ["github-down", null], ["server", null]]);

  // 非慢速失败不重试；全部失败时抛出最后的错误。
  const attempts: string[] = [];
  await assert.rejects(downloadWithMirrorFallback(["a", "b"], async (url) => { attempts.push(url); throw new Error(`fail ${url}`); }), /fail b/);
  assert.deepEqual(attempts, ["a", "b"]);

  // 取消立即停止。
  const cancelled: string[] = [];
  await assert.rejects(downloadWithMirrorFallback(["a", "b"], async (url) => { cancelled.push(url); throw new Error("cancelled"); }, () => true), /cancelled/);
  assert.deepEqual(cancelled, ["a"]);

  const hookSource = readFileSync(new URL("../src/hooks/useUpdateFlow.ts", import.meta.url), "utf8");
  const hook = ts.createSourceFile("useUpdateFlow.ts", hookSource, ts.ScriptTarget.Latest, true);
  let stopPredicate = "";
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(hook) === "downloadWithMirrorFallback") {
      stopPredicate = node.arguments[2]?.getText(hook) ?? "";
    }
    ts.forEachChild(node, visit);
  }
  visit(hook);
  assert.ok(stopPredicate, "执行更新hook实际使用的停止切源规则，不在测试里另造取消判定");
  const predicateCode = ts.transpileModule(`const shouldStop=${stopPredicate};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const shouldStop = new Function(`${predicateCode};return shouldStop;`)() as (reason: unknown) => boolean;
  const nativeStallFormat = nativeSource.match(/var errDownloadStalled = fmt\.Errorf\("([^"]+)"/)?.[1];
  assert.ok(nativeStallFormat, "原生停滞必须提供区别于取消的错误原因");
  const stalled: string[] = [];
  const stalledSource = await downloadWithMirrorFallback(["stalled-mirror", "healthy-origin"], async url => {
    stalled.push(url);
    if (url === "stalled-mirror") throw new Error(nativeStallFormat.replace("%s", "45s"));
  }, shouldStop);
  assert.equal(stalledSource, "healthy-origin");
  assert.deepEqual(stalled, ["stalled-mirror", "healthy-origin"], "原生停滞超时必须切换下一下载源");
  for (const message of ["context canceled", "cancelled", "download_cancelled", "用户取消", "AbortError"]) {
    const userCancelled: string[] = [];
    await assert.rejects(downloadWithMirrorFallback(["a", "b"], async url => {
      userCancelled.push(url);
      throw new Error(message);
    }, shouldStop));
    assert.deepEqual(userCancelled, ["a"], `${message}: 用户取消不得继续切源`);
  }
}

await fallbackChecks();
console.log("download mirror ranking regression passed");
