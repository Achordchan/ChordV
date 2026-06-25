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
  assert.match(apiClientSource, /const IMAGE_BED_CONFIG_TIMEOUT_MS = 8 \* 1000;/);
  assert.match(apiClientSource, /const IMAGE_BED_LIST_TIMEOUT_MS = 10 \* 1000;/);
  assert.match(apiClientSource, /const IMAGE_BED_MANAGE_TIMEOUT_MS = 60 \* 1000;/);
  assert.match(apiClientSource, /const IMAGE_BED_LIST_TIMEOUT_MESSAGE = "图床文件列表加载超时，请稍后重试或缩小搜索范围。";/);
  assert.match(apiClientSource, /const IMAGE_BED_CONFIG_SAVE_TIMEOUT_MESSAGE = "图床配置保存请求仍在处理，请稍后刷新图床配置确认结果。";/);
  assert.match(apiClientSource, /const IMAGE_BED_MANAGE_TIMEOUT_MESSAGE = "图床管理请求仍在处理，请稍后刷新文件列表确认结果。";/);
  assert.match(apiClientSource, /async function requestAdminImageBedManage/);
  assert.match(apiClientSource, /function isBackendHttpErrorMessage/);
  assert.match(apiClientSource, /function readRequestIdFromErrorMessage/);
  assert.match(apiClientSource, /function appendRequestIdToErrorMessage/);
  assert.match(
    apiClientSource,
    /!isBackendHttpErrorMessage\(message\) && \/请求超时\|AbortError\|aborted\|timeout\|timed out\/i\.test\(message\)/,
    "image bed manage wrapper should not replace backend JSON errors with the local timeout message"
  );
  assert.match(
    apiClientSource,
    /appendRequestIdToErrorMessage\(init\?\.timeoutMessage \?\? IMAGE_BED_MANAGE_TIMEOUT_MESSAGE, readRequestIdFromErrorMessage\(message\)\)/,
    "image bed manage timeout wrapper should preserve requestId from the original request error"
  );
  assert.match(apiClientSource, /requestAdminImageBedManage<AdminImageBedFileListDto>/);
  assert.match(
    apiClientSource,
    /fetchAdminImageBedConfig\(\)[\s\S]*?timeoutMs: IMAGE_BED_CONFIG_TIMEOUT_MS/,
    "image bed config load should not use the long generic admin read timeout"
  );
  assert.match(
    apiClientSource,
    /updateAdminImageBedConfig\(input: UpdateAdminImageBedConfigInputDto\)[\s\S]*?requestAdminImageBedManage<AdminImageBedConfigDto>[\s\S]*?timeoutMessage: IMAGE_BED_CONFIG_SAVE_TIMEOUT_MESSAGE/,
    "image bed config save should use the image-bed wrapper so local timeouts keep the save-specific uncertain message"
  );
  assert.match(
    apiClientSource,
    /requestAdminImageBedManage<AdminImageBedFileListDto>[\s\S]*?timeoutMs: IMAGE_BED_LIST_TIMEOUT_MS,[\s\S]*?timeoutMessage: IMAGE_BED_LIST_TIMEOUT_MESSAGE/,
    "image bed list loading should use a short read timeout and read-specific timeout copy instead of mutation confirmation copy"
  );
  assert.match(apiClientSource, /requestAdminImageBedManage<DeleteAdminImageBedFileResultDto>/);
  assert.doesNotMatch(apiClientSource, /const IMAGE_BED_MANAGE_TIMEOUT_MS = 8 \* 1000;/);
}

function testImageBedSaveAndDeleteAlwaysReleaseBusyState() {
  assert.match(
    source,
    /async function handleSave\(\)[\s\S]*?finally\s*{[\s\S]*?savingRef\.current = false;[\s\S]*?setSaving\(false\);[\s\S]*?}/,
    "image bed config save should always release saving state after success, failure, or uncertain refresh"
  );
  assert.match(
    source,
    /async function handleDelete\(file: AdminImageBedFileDto\)[\s\S]*?finally\s*{[\s\S]*?deletingPathRef\.current === file\.name[\s\S]*?deletingPathRef\.current = null;[\s\S]*?setDeletingPath\(null\);[\s\S]*?}/,
    "image bed delete should always release deleting state even when the request times out or remains uncertain"
  );
}

function testImageBedSaveUncertainNotificationKeepsOriginalError() {
  assert.match(
    source,
    /message: uncertain \? buildUncertainMutationMessage\("图床配置", message\) : message/,
    "image bed config save uncertain notification should keep timeout, network, and requestId details"
  );
}

testInitialConfigLoadRefreshesFileListWhenTokenExists();
testImageBedFileManagementUsesScopedTimeoutMessage();
testImageBedSaveAndDeleteAlwaysReleaseBusyState();
testImageBedSaveUncertainNotificationKeepsOriginalError();

console.log("image bed page regression checks passed");
