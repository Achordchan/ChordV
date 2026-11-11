import assert from "node:assert/strict";
import {
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
console.log("download mirror ranking regression passed");
