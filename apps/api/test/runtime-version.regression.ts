import assert from "node:assert/strict";
import { AUTO_RETENTION_MS, MANUAL_RETENTION_MS, RuntimeVersionService, isPastRetention, runtimeRetentionMs, selectExpiredAutoVersions } from "../src/modules/common/runtime-version.service";
import { listGithubVersionTags } from "../src/modules/common/runtime-version-files";

// No network or filesystem work: policy rejection must happen before enqueueing.
async function main() {
  let queued = 0;
  let kind = "xray";
  const prisma = {
    runtimeComponent: { findUnique: async () => ({ id: "component", kind }) },
    $transaction: async () => { queued++; throw new Error("unexpected enqueue"); }
  };
  const service = new RuntimeVersionService(prisma as never, { publish() {} } as never);
  await assert.rejects(service.acquire({ componentId: "component", sourceUrl: "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip", version: "v1.2.3", autoLatest: true }), /固定版本/);
  await assert.rejects(service.acquire({ componentId: "component", sourceUrl: "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip", version: "v1.2.3", autoLatest: false }), /固定版本/);
  await assert.rejects(service.acquire({ componentId: "component", sourceUrl: "https://github.com/XTLS/Xray-core/releases/download/v1.2.4/Xray-windows-64.zip", version: "v1.2.3", autoLatest: false }), /不一致/);
  kind = "geoip";
  await assert.rejects(service.acquire({ componentId: "component", sourceUrl: "https://example.com/geoip.dat", autoLatest: true }), /latest/);
  await assert.rejects(service.acquire({ componentId: "component", sourceUrl: "http://example.com/geoip.dat", version: "2026.09.11", autoLatest: false }), /HTTPS/);
  assert.equal(queued, 0);
  const pages: string[] = [];
  const tags = await listGithubVersionTags("https://github.com/XTLS/Xray-core/releases/latest/download/Xray-macos-64.zip", (async (url: string) => {
    pages.push(url);
    const records = pages.length === 1
      ? Array.from({length: 5}, (_, index) => ({tag_name: `v1.0.${index}`, prerelease: index === 1, assets: [{body: "x".repeat(450_000)}]}))
      : [{tag_name: "v0.9.0"}, {tag_name: "v1.0.0"}];
    return {response: new Response(JSON.stringify(records)), resolvedUrl: url};
  }) as never);
  assert.equal(pages.length, 2);
  assert.ok(pages.every(url => url.includes("per_page=5")));
  assert.equal(tags.length, 5, "exclude prereleases and duplicate tags across pages");
  assert.equal(tags.at(-1)?.value, "v0.9.0");
  testRetention();
}

function testRetention() {
  const day = 24 * 60 * 60_000;
  const now = Date.UTC(2026, 8, 27);
  const ago = (days: number) => new Date(now - days * day);
  // 保留期：只有“自动跟随最新”的非 Xray 组件缩短为 2 天
  assert.equal(runtimeRetentionMs({ autoLatest: true }, "geoip"), AUTO_RETENTION_MS);
  assert.equal(runtimeRetentionMs({ autoLatest: false }, "geosite"), MANUAL_RETENTION_MS);
  assert.equal(runtimeRetentionMs({ autoLatest: true }, "xray"), MANUAL_RETENTION_MS);
  assert.equal(runtimeRetentionMs(null, "geoip"), MANUAL_RETENTION_MS);

  // 每天一份：当前 d0，上一份 d1，更早的 d2..d9；另有检查记录和失败记录
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, status: "ready", createdAt: ago(i + 0.1), publishedAt: ago(i), retainUntil: i === 0 ? null : ago(i - 1 - 2) })),
    { id: "unchanged-old", status: "unchanged", createdAt: ago(5), publishedAt: null, retainUntil: null },
    { id: "unchanged-new", status: "unchanged", createdAt: ago(0.5), publishedAt: null, retainUntil: null },
    { id: "failed-old", status: "failed", createdAt: ago(4), publishedAt: null, retainUntil: null },
    { id: "downloading", status: "downloading", createdAt: ago(9), publishedAt: null, retainUntil: null }
  ];
  const expired = new Set(selectExpiredAutoVersions(rows, "d0", now).map(row => row.id));
  assert.ok(!expired.has("d0"), "current version is kept");
  assert.ok(!expired.has("d1"), "the previous version is kept for rollback");
  for (const id of ["d3", "d4", "d9", "unchanged-old", "failed-old"]) assert.ok(expired.has(id), `${id} is cleaned up`);
  assert.ok(!expired.has("unchanged-new"), "records younger than 2 days stay");
  assert.ok(!expired.has("downloading"), "in-progress fetches are never removed");
  // d2 was replaced 1 day ago (retainUntil in the future): still inside its 2-day window
  const d2 = rows.find(row => row.id === "d2")!;
  assert.equal(isPastRetention({ ...d2, retainUntil: new Date(now + day) }, AUTO_RETENTION_MS, now), false);
  // 手动组件仍按 30 天
  assert.equal(isPastRetention({ id: "x", status: "ready", createdAt: ago(10), publishedAt: ago(10), retainUntil: null }, MANUAL_RETENTION_MS, now), false);
  assert.equal(isPastRetention({ id: "x", status: "ready", createdAt: ago(31), publishedAt: ago(31), retainUntil: ago(1) }, MANUAL_RETENTION_MS, now), true);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
