import assert from "node:assert/strict";
import {
  buildGeoComponentItem,
  buildGeoDownloadCandidates,
  buildGeoRemoteAssetsFromRelease,
  isLocalGeoCurrent,
  parseGithubReleasePayload,
  parseSha256Sum,
  shouldCheckGeoUpdate
} from "../src/lib/geoUpdate.ts";
import { applyUpdateMirrorPrefix, normalizeMirrorPrefix } from "../src/lib/updateState.ts";

// Keep side-effect free imports with explicit extensions for Node strip-types.
void applyUpdateMirrorPrefix;
void normalizeMirrorPrefix;

function testParseSha256Sum() {
  assert.equal(
    parseSha256Sum("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  geoip.dat"),
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  );
  assert.equal(parseSha256Sum("not-a-hash"), null);
}

function testShouldCheckGeoUpdate() {
  assert.equal(shouldCheckGeoUpdate(null), true);
  assert.equal(shouldCheckGeoUpdate(Date.now() - 13 * 60 * 60 * 1000), true);
  assert.equal(shouldCheckGeoUpdate(Date.now() - 60 * 60 * 1000), false);
}

function testParseGithubReleaseAndBuildPlan() {
  const release = parseGithubReleasePayload(
    JSON.stringify({
      tag_name: "202607122240",
      published_at: "2026-07-12T22:41:15Z",
      assets: [
        {
          name: "geoip.dat",
          size: 17872715,
          browser_download_url:
            "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202607122240/geoip.dat"
        },
        {
          name: "geosite.dat",
          size: 10413524,
          browser_download_url:
            "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202607122240/geosite.dat"
        }
      ]
    })
  );
  assert.ok(release);
  const plan = buildGeoRemoteAssetsFromRelease(release!, {
    "geoip.dat": "a".repeat(64),
    "geosite.dat": "b".repeat(64)
  });
  assert.ok(plan);
  assert.equal(plan!.releaseTag, "202607122240");
  assert.equal(plan!.assets.length, 2);

  const item = buildGeoComponentItem(plan!.assets[0], "https://mirror.example.com/fetch?url={url}");
  assert.equal(item.component, "geoip");
  assert.ok(item.candidates.some((candidate) => candidate.source === "client_override"));
  assert.ok(item.candidates.some((candidate) => candidate.url.includes("jsdelivr")));
}

function testLocalGeoCurrent() {
  const remote = {
    kind: "geoip" as const,
    fileName: "geoip.dat" as const,
    releaseTag: "202607122240",
    fileSizeBytes: 100,
    checksumSha256: "A".repeat(64),
    originUrl: "https://example.com/geoip.dat"
  };
  assert.equal(
    isLocalGeoCurrent(
      {
        kind: "geoip",
        exists: true,
        path: "C:/tmp/geoip.dat",
        sizeBytes: 100,
        checksumSha256: "a".repeat(64)
      },
      remote
    ),
    true
  );
  assert.equal(
    isLocalGeoCurrent(
      {
        kind: "geoip",
        exists: true,
        path: "C:/tmp/geoip.dat",
        sizeBytes: 99,
        checksumSha256: "a".repeat(64)
      },
      remote
    ),
    false
  );
}

function testDownloadCandidatesOrder() {
  const candidates = buildGeoDownloadCandidates(
    "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202607122240/geoip.dat",
    "202607122240",
    "geoip.dat",
    null
  );
  assert.equal(candidates[candidates.length - 1].source, "origin");
  assert.ok(candidates.some((item) => item.label === "ghproxy"));
  assert.ok(candidates.some((item) => item.label === "ghfast"));
  assert.ok(candidates.length >= 3);
}

function main() {
  testParseSha256Sum();
  testShouldCheckGeoUpdate();
  testParseGithubReleaseAndBuildPlan();
  testLocalGeoCurrent();
  testDownloadCandidatesOrder();
  console.log("desktop geo update regression checks passed");
}

main();
