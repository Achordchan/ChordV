import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../src/pages/ImageBedPage.tsx"), "utf8");
const apiClientSource = readFileSync(resolve(import.meta.dirname, "../src/api/client.ts"), "utf8");

function testInitialConfigLoadRefreshesFileListWhenTokenExists() {
  assert.match(
    source,
    /void loadConfig\(\{ loadFilesAfter: true \}\);/,
    "image bed page should load files after initial config load when a token exists"
  );
}

function testImageBedFileManagementUsesScopedTimeoutMessage() {
  assert.match(apiClientSource, /const IMAGE_BED_MANAGE_TIMEOUT_MS = 60 \* 1000;/);
  assert.match(apiClientSource, /const IMAGE_BED_MANAGE_TIMEOUT_MESSAGE = "图床管理请求仍在处理，请稍后刷新文件列表确认结果。";/);
  assert.match(apiClientSource, /async function requestAdminImageBedManage/);
  assert.match(apiClientSource, /requestAdminImageBedManage<AdminImageBedFileListDto>/);
  assert.match(apiClientSource, /requestAdminImageBedManage<DeleteAdminImageBedFileResultDto>/);
  assert.doesNotMatch(apiClientSource, /const IMAGE_BED_MANAGE_TIMEOUT_MS = 8 \* 1000;/);
}

testInitialConfigLoadRefreshesFileListWhenTokenExists();
testImageBedFileManagementUsesScopedTimeoutMessage();

console.log("image bed page regression checks passed");
