import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LOCAL_FILE_ITEMS,
  buildLocalFileRows,
  formatFileSize,
  isCredentialPath,
  localFileKindForComponent,
  resolveLocalFileVersions,
  supportsLocalFiles,
  type LocalFileEntry
} from "../src/lib/localFiles.ts";

const MAC_ROOT = "/Users/张 三/Library/Application Support/app.chordv.desktop";
const WIN_BIN = "C:\\Users\\张 三\\AppData\\Local\\app.chordv.desktop\\runtime\\bin";

function macEntries(): LocalFileEntry[] {
  return [
    { kind: "appData", path: MAC_ROOT, isDirectory: true, exists: true, sizeBytes: null },
    { kind: "xray", path: `${MAC_ROOT}/runtime/bin/xray`, isDirectory: false, exists: true, sizeBytes: 29_779_968 },
    { kind: "geoip", path: `${MAC_ROOT}/runtime/bin/geoip.dat`, isDirectory: false, exists: false, sizeBytes: null },
    { kind: "geosite", path: `${MAC_ROOT}/runtime/bin/geosite.dat`, isDirectory: false, exists: true, sizeBytes: 2048 },
    { kind: "runtime", path: `${MAC_ROOT}/runtime`, isDirectory: true, exists: true, sizeBytes: null },
    { kind: "updater", path: `${MAC_ROOT}/updater`, isDirectory: true, exists: true, sizeBytes: null }
  ];
}

function testFixedItemsNeverIncludeCredentials() {
  assert.deepEqual(LOCAL_FILE_ITEMS.map((item) => item.kind), ["appData", "xray", "geoip", "geosite", "runtime", "updater"]);
  for (const item of LOCAL_FILE_ITEMS) {
    assert.doesNotMatch(`${item.kind} ${item.label} ${item.hint ?? ""}`, /session|凭据|登录/i, `${item.kind} must not expose credentials`);
  }
  assert.equal(isCredentialPath(`${MAC_ROOT}/session.json`), true);
  assert.equal(isCredentialPath("C:\\x\\SESSION.JSON"), true);
  assert.equal(isCredentialPath(`${MAC_ROOT}/session.json.tmp`), true);
  assert.equal(isCredentialPath(`${MAC_ROOT}/runtime/bin/xray`), false);
}

function testUnexpectedEntriesAreDropped() {
  const rows = buildLocalFileRows([
    { kind: "appData", path: `${MAC_ROOT}/session.json`, isDirectory: false, exists: true, sizeBytes: 10 },
    { kind: "session" as never, path: `${MAC_ROOT}/session.json`, isDirectory: false, exists: true, sizeBytes: 10 },
    ...macEntries()
  ]);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].path, MAC_ROOT, "the credential path cannot replace the app data row");
  for (const row of rows) assert.doesNotMatch(row.path, /session\.json/i);
  assert.deepEqual(buildLocalFileRows(null), []);
}

function testRowLabelsAndStatus() {
  const rows = buildLocalFileRows(macEntries(), { xray: "26.3.27", geo: "202609200512" });
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
  assert.deepEqual(rows.map((row) => row.label), ["应用数据目录", "Xray 内核", "GEO 数据（geoip.dat）", "GEO 数据（geosite.dat）", "运行时目录", "更新目录"]);
  assert.equal(byKind.xray.status, "28.4 MB · 版本 26.3.27");
  assert.equal(byKind.xray.revealLabel, "在文件夹中显示");
  assert.equal(byKind.geoip.status, "尚未下载", "missing component says so instead of a size");
  assert.equal(byKind.geoip.revealLabel, "打开上级目录", "missing files open their parent directory");
  assert.equal(byKind.geosite.status, "2.0 KB · 版本 202609200512");
  assert.equal(byKind.runtime.status, null, "directories are not sized");
  assert.equal(byKind.runtime.revealLabel, "打开文件夹");
  assert.equal(byKind.appData.path, MAC_ROOT, "paths come from native code unchanged");
}

function testWindowsPathsAreKeptVerbatim() {
  const path = `${WIN_BIN}\\xray.exe`;
  const [row] = buildLocalFileRows([{ kind: "xray", path, isDirectory: false, exists: true, sizeBytes: 512 }]);
  assert.equal(row.path, path);
  assert.equal(row.status, "512 B");
}

function testVersionsReuseExistingData() {
  assert.deepEqual(resolveLocalFileVersions({ summaryXray: "已安装", storedXray: "26.3.27", summaryGeo: "最新版本", storedGeo: null }), { xray: "26.3.27", geo: null });
  assert.deepEqual(resolveLocalFileVersions({ summaryXray: "26.4.1", storedXray: "26.3.27", summaryGeo: "未完整安装", storedGeo: "202609200512" }), { xray: "26.4.1", geo: "202609200512" });
  assert.equal(formatFileSize(null), null);
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(150 * 1024 * 1024), "150 MB");
}

function testPlatformsAndEntries() {
  assert.equal(supportsLocalFiles("macos"), true);
  assert.equal(supportsLocalFiles("windows"), true);
  for (const platform of ["android", "ios", "web", "linux", null]) assert.equal(supportsLocalFiles(platform), false, String(platform));
  assert.equal(localFileKindForComponent("xray"), "xray");
  assert.equal(localFileKindForComponent("geo"), "geoip");

  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/components/SubscriptionPanel.tsx", import.meta.url), "utf8");
  const center = readFileSync(new URL("../src/components/UpdateCenterModal.tsx", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../src/lib/runtime.ts", import.meta.url), "utf8");
  const native = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.equal(app.match(/onOpenLocalFiles=\{localFilesAvailable \? /g)?.length, 2, "both menus are gated by platform");
  assert.match(app, /onRevealComponent=\{localFilesAvailable \? /);
  assert.match(panel, /检查更新"\}\s*<\/Menu\.Item>\s*\{props\.onOpenLocalFiles \?[\s\S]*?本地文件/, "“本地文件” sits below “检查更新” in the ⋯ menu");
  assert.match(panel, /aria-label="更多操作"[\s\S]*?本地文件/);
  assert.match(center, /在文件夹中显示/);
  assert.match(runtime, /invoke\("reveal_local_file", \{ kind \}\)/, "the frontend sends a fixed kind, never a path");
  assert.match(native, /async fn reveal_local_file\(app: AppHandle, kind: local_files::LocalFileKind\)/, "no general-purpose open-any-path command");
  assert.match(native, /resolve_reveal_target\(&roots\.app_data, &roots\.path_of\(kind\)\)/);
}

function main() {
  testFixedItemsNeverIncludeCredentials();
  testUnexpectedEntriesAreDropped();
  testRowLabelsAndStatus();
  testWindowsPathsAreKeptVerbatim();
  testVersionsReuseExistingData();
  testPlatformsAndEntries();
  console.log("desktop local files regression checks passed");
}

main();
