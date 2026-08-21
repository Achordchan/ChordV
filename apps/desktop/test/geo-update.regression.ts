import assert from "node:assert/strict";
import {
  buildGeoPlanRevision,
  isGeoPlanCurrent,
  readStoredGeoVersionLabel,
  resolveGeoPlanVersionLabel,
  resolveStoredGeoPlanVersionLabel,
  shouldCheckGeoUpdate
} from "../src/lib/geoUpdate.ts";
import type { RuntimeComponentDownloadItem } from "../src/lib/runtimeComponents.ts";

function makeItem(
  component: "geoip" | "geosite",
  revision = "2026-07-22T10:00:00.000Z"
): RuntimeComponentDownloadItem {
  return {
    id: `component_${component}`,
    revision,
    component,
    fileName: `${component}.dat`,
    fileSizeBytes: component === "geoip" ? 100 : 200,
    sourceFormat: "direct",
    archiveEntryName: null,
    checksumSha256: null,
    candidates: [
      {
        label: "origin",
        url: `https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202607222256/${component}.dat`,
        source: "origin"
      }
    ],
    selectedUrl: `https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202607222256/${component}.dat`,
    displayName: component === "geoip" ? "GeoIP 数据" : "GeoSite 数据"
  };
}

function testShouldCheckGeoUpdate() {
  assert.equal(shouldCheckGeoUpdate(null), true);
  assert.equal(shouldCheckGeoUpdate(Date.now() - 13 * 60 * 60 * 1000), true);
  assert.equal(shouldCheckGeoUpdate(Date.now() - 60 * 60 * 1000), false);
}

function testBackendPlanRevision() {
  const items = [makeItem("geoip"), makeItem("geosite")];
  const revision = buildGeoPlanRevision(items);
  assert.ok(revision);
  assert.equal(buildGeoPlanRevision([items[0]]), null, "GeoIP/GeoSite 必须同时由后台配置");
  assert.notEqual(
    buildGeoPlanRevision([makeItem("geoip", "2026-07-22T11:00:00.000Z"), items[1]]),
    revision,
    "后台修改任一 GEO 组件后必须形成新计划版本"
  );
}

function testGeoCurrentRequiresBackendRevisionAndLocalFiles() {
  const items = [makeItem("geoip"), makeItem("geosite")];
  const revision = buildGeoPlanRevision(items);
  const local = {
    geoip: { kind: "geoip" as const, exists: true, path: "C:/geoip.dat", sizeBytes: 100, checksumSha256: null, versionLabel: null },
    geosite: { kind: "geosite" as const, exists: true, path: "C:/geosite.dat", sizeBytes: 200, checksumSha256: null, versionLabel: null }
  };
  assert.equal(isGeoPlanCurrent(local, items, revision), true);
  assert.equal(isGeoPlanCurrent(local, items, "旧后台版本"), false);
  assert.equal(isGeoPlanCurrent({ ...local, geosite: null }, items, revision), false);
}

function testGeoVersionLabels() {
  const items = [makeItem("geoip"), makeItem("geosite")];
  const revision = buildGeoPlanRevision(items);
  assert.equal(resolveGeoPlanVersionLabel(items), "202607222256");
  assert.equal(resolveStoredGeoPlanVersionLabel(revision), "202607222256");
  assert.equal(readStoredGeoVersionLabel({
    getItem: (key: string) => key === "chordv.geo.installedReleaseTag" ? "202607212250" : null
  } as Storage), "202607212250");
  assert.equal(
    resolveGeoPlanVersionLabel([
      { ...items[0], candidates: [], selectedUrl: "https://components.example.com/geoip.dat" },
      { ...items[1], candidates: [], selectedUrl: "https://components.example.com/geosite.dat" }
    ]),
    null
  );
}

function main() {
  testShouldCheckGeoUpdate();
  testBackendPlanRevision();
  testGeoCurrentRequiresBackendRevisionAndLocalFiles();
  testGeoVersionLabels();
  console.log("desktop GEO backend-plan regression checks passed");
}

main();