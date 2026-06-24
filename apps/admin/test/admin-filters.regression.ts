import assert from "node:assert/strict";
import { isPotentiallyCompletedMutationFailure, readError } from "../src/utils/admin-filters";

function backendError(statusCode: number, message: string) {
  return new Error(JSON.stringify({ statusCode, message }));
}

function testReadErrorPreservesImageBedProviderHttpError() {
  const message = readError(
    backendError(502, "图床上传失败（HTTP 401）：Token *** is invalid"),
    "fallback"
  );

  assert.equal(message, "图床上传失败（HTTP 401）：Token *** is invalid");
}

function testReadErrorPreservesImageBedTimeout() {
  const message = readError(
    backendError(502, "图床服务请求超时，已等待 25ms。"),
    "fallback"
  );

  assert.equal(message, "图床服务请求超时，已等待 25ms。");
}

function testReadErrorKeepsGenericServiceUnavailableFallback() {
  const message = readError(
    backendError(503, "Service Unavailable"),
    "fallback"
  );

  assert.equal(message, "后台或外部服务暂不可用，请稍后重试。");
}

function testReadErrorPreservesSpecificBadRequestDetail() {
  assert.equal(
    readError(backendError(400, "上传型运行组件的 expectedHash 与当前文件 SHA256 不一致。"), "fallback"),
    "上传型运行组件的 expectedHash 与当前文件 SHA256 不一致。"
  );
  assert.equal(
    readError(backendError(400, "Windows 静默全量更新 ZIP 不可用。"), "fallback"),
    "Windows 静默全量更新 ZIP 不可用。"
  );
  assert.equal(
    readError(backendError(400, "External download URL must start with http:// or https://."), "fallback"),
    "External download URL must start with http:// or https://."
  );
}

function testReadErrorKeepsGenericBadRequestFallback() {
  const message = readError(backendError(400, "Bad Request"), "fallback");

  assert.equal(message, "提交内容不完整或格式不正确，请检查后重试。");
}

function testReadErrorKeepsRequestIdForNetworkFailure() {
  const message = readError(
    new Error("GET /api/admin/users failed before HTTP response requestId=admin-network-check: Failed to fetch"),
    "fallback"
  );

  assert.match(message, /Request ID: admin-network-check/);
}

function testReadErrorKeepsRequestIdForTimeout() {
  const message = readError(
    new Error("GET /api/admin/users failed before HTTP response requestId=admin-timeout-check: 请求超时"),
    "fallback"
  );

  assert.match(message, /Request ID: admin-timeout-check/);
}

function testReadErrorKeepsRequestIdForExpiredSession() {
  const message = readError(
    new Error(JSON.stringify({ statusCode: 401, message: "Unauthorized", requestId: "admin-session-check" })),
    "fallback"
  );

  assert.match(message, /Request ID: admin-session-check/);
}

function testImageBedManageTimeoutIsUncertainMutationFailure() {
  assert.equal(
    isPotentiallyCompletedMutationFailure("图床管理请求仍在处理，请稍后刷新文件列表确认结果。"),
    true
  );
}

testReadErrorPreservesImageBedProviderHttpError();
testReadErrorPreservesImageBedTimeout();
testReadErrorKeepsGenericServiceUnavailableFallback();
testReadErrorPreservesSpecificBadRequestDetail();
testReadErrorKeepsGenericBadRequestFallback();
testReadErrorKeepsRequestIdForNetworkFailure();
testReadErrorKeepsRequestIdForTimeout();
testReadErrorKeepsRequestIdForExpiredSession();
testImageBedManageTimeoutIsUncertainMutationFailure();

console.log("admin filter regression checks passed");
