import assert from "node:assert/strict";
import {
  clearGithubLatestReleaseCacheForTest,
  parseGithubLatestDownloadUrl,
  parseGithubLatestReleasePayload,
  resolveGithubLatestReleaseAsset
} from "../src/modules/common/github-latest-release";

const latestUrl = "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat";
const releasePayload = JSON.stringify({
  tag_name: "202607222256",
  published_at: "2026-07-22T22:56:22Z",
  assets: [
    {
      name: "geoip.dat",
      size: 17_784_192,
      digest: "sha256:" + "a".repeat(64),
      updated_at: "2026-07-22T22:56:32Z",
      browser_download_url:
        "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202607222256/geoip.dat"
    },
    {
      name: "geosite.dat",
      size: 10_480_351,
      digest: `sha256:${"5".repeat(64)}`,
      updated_at: "2026-07-22T22:56:30Z",
      browser_download_url:
        "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202607222256/geosite.dat"
    }
  ]
});

function testLatestUrlParsing() {
  assert.deepEqual(parseGithubLatestDownloadUrl(latestUrl), {
    owner: "Loyalsoldier",
    repo: "v2ray-rules-dat",
    assetName: "geosite.dat"
  });
  assert.equal(parseGithubLatestDownloadUrl("https://example.com/releases/latest/download/geosite.dat"), null);
  assert.equal(
    parseGithubLatestDownloadUrl(
      "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202607222256/geosite.dat"
    ),
    null
  );
}

function testLatestPayloadParsing() {
  const asset = parseGithubLatestReleasePayload(releasePayload, "geosite.dat");
  assert.equal(asset.versionLabel, "202607222256");
  assert.equal(asset.revision, "2026-07-22T22:56:30Z");
  assert.equal(asset.fileSizeBytes, 10_480_351n);
  assert.equal(asset.sha256, "5".repeat(64));
  assert.match(asset.originUrl, /\/releases\/download\/202607222256\/geosite\.dat$/);
}

async function testResolverUsesApiMetadataAndCache() {
  clearGithubLatestReleaseCacheForTest();
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return {
      response: new Response(releasePayload, {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      resolvedUrl: "https://api.github.com/repos/Loyalsoldier/v2ray-rules-dat/releases/latest"
    };
  };
  const first = await resolveGithubLatestReleaseAsset(latestUrl, fetcher as never, 1_000);
  const second = await resolveGithubLatestReleaseAsset(
    "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat",
    fetcher as never,
    1_000
  );
  assert.equal(first?.revision, "2026-07-22T22:56:30Z");
  assert.equal(second?.revision, "2026-07-22T22:56:32Z");
  assert.equal(requests, 1, "assets in the same repository must share one cached GitHub API response");

  const stale = await resolveGithubLatestReleaseAsset(
    latestUrl,
    (async () => {
      requests += 1;
      throw new Error("temporary GitHub outage");
    }) as never,
    16 * 60 * 1000
  );
  assert.equal(stale?.versionLabel, "202607222256", "expired cache must remain usable when refresh fails");
  assert.equal(requests, 2);
}

async function main() {
  testLatestUrlParsing();
  testLatestPayloadParsing();
  await testResolverUsesApiMetadataAndCache();
  console.log("GitHub latest release regression checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
