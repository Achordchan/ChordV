import assert from "node:assert/strict";
import { readError } from "../src/utils/admin-filters";

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

testReadErrorPreservesImageBedProviderHttpError();
testReadErrorPreservesImageBedTimeout();
testReadErrorKeepsGenericServiceUnavailableFallback();

console.log("admin filter regression checks passed");
