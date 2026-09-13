import assert from "node:assert/strict";
import { RuntimeVersionService } from "../src/modules/common/runtime-version.service";
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
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
