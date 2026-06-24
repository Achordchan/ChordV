import "reflect-metadata";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BadGatewayException } from "@nestjs/common";
import { ImageBedService } from "../src/modules/common/image-bed.service";

function createInstance<T>(prototype: object, overrides: Record<string, unknown> = {}) {
  return Object.assign(Object.create(prototype), overrides) as T & Record<string, unknown>;
}

function createImageBedService(baseUrl: string, overrides: Record<string, unknown> = {}) {
  return createInstance<ImageBedService>(ImageBedService.prototype, {
    prisma: {
      systemSetting: {
        findUnique: async () => ({
          value: {
            baseUrl,
            apiToken: "test-token"
          },
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        })
      }
    },
    ...overrides
  });
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function testListPreservesHttpStatusAndRedactsProviderError() {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "Token image-bed-secret-token-123456 is invalid; Authorization: Bearer another-secret-token-123456"
      })
    );
  });
  const baseUrl = await listen(server);

  try {
    const service = createImageBedService(baseUrl);

    await assert.rejects(
      () => service.listAdminFiles(),
      (error) =>
        error instanceof BadGatewayException &&
        /图床列表读取失败（HTTP 401）：Token \*\*\* is invalid; Authorization: Bearer \*\*\*/i.test(error.message) &&
        !/image-bed-secret-token-123456|another-secret-token-123456/i.test(error.message),
      "image bed list HTTP failures must preserve provider status and redact echoed tokens"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testListPreservesBusinessFailureMessage() {
  const warnings: string[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, message: "bad token image-bed-secret-token-123456" }));
  });
  const baseUrl = await listen(server);

  try {
    const service = createImageBedService(baseUrl, {
      logger: {
        warn: (message: string) => warnings.push(message)
      }
    });

    await assert.rejects(
      () => service.listAdminFiles(),
      (error) =>
        error instanceof BadGatewayException &&
        /图床列表读取失败（HTTP 200）：bad token \*\*\*/i.test(error.message) &&
        !/image-bed-secret-token-123456/i.test(error.message),
      "image bed list business failures must preserve provider messages"
    );
    assert.doesNotMatch(warnings.join(" "), /image-bed-secret-token-123456/i);
    assert.match(warnings.join(" "), /bad token \*\*\*/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testUploadPreservesBusinessFailureMessage() {
  const warnings: string[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, message: "upload rejected Authorization: Bearer upload-secret-token-123456" }));
  });
  const baseUrl = await listen(server);
  const tempDir = await mkdtemp(path.join(tmpdir(), "image-bed-fidelity-"));
  const filePath = path.join(tempDir, "rejected.png");
  await writeFile(filePath, "image");

  try {
    const service = createImageBedService(baseUrl, {
      logger: {
        warn: (message: string) => warnings.push(message)
      }
    });

    await assert.rejects(
      () =>
        service.uploadSupportTicketAttachment({
          path: filePath,
          originalname: "rejected.png",
          mimetype: "image/png",
          size: 5
        }),
      (error) =>
        error instanceof BadGatewayException &&
        /图床上传失败（HTTP 200）：upload rejected Authorization: Bearer \*\*\*/i.test(error.message) &&
        !/upload-secret-token-123456/i.test(error.message),
      "image bed upload business failures must preserve provider messages"
    );
    assert.doesNotMatch(warnings.join(" "), /upload-secret-token-123456/i);
    assert.match(warnings.join(" "), /upload rejected Authorization: Bearer \*\*\*/i);
    assert.equal(existsSync(filePath), false, "failed image bed uploads must remove the temporary file");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testListPreservesTimeoutReason() {
  const previousTimeout = process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS;
  process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS = "25";
  const server = createServer(() => {
    // Keep the socket open so the service timeout path owns the failure message.
  });
  const baseUrl = await listen(server);

  try {
    const service = createImageBedService(baseUrl);

    await assert.rejects(
      () => service.listAdminFiles(),
      /图床服务请求超时，已等待 25ms/,
      "image bed timeouts must preserve the timeout budget in the error message"
    );
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS;
    } else {
      process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS = previousTimeout;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testDeleteRedactsFailedArrayProviderErrors() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: false,
        failed: [
          "Authorization: Bearer image-bed-secret-token-123456",
          "delete failed with token=another-secret-token-123456"
        ]
      })
    );
  });
  const baseUrl = await listen(server);

  try {
    const service = createImageBedService(baseUrl);
    const result = await service.deleteAdminFile({ path: "support-tickets/rejected.png" });

    assert.equal(result.success, false);
    assert.deepEqual(result.failed, ["Authorization: Bearer ***", "delete failed with token=***"]);
    assert.doesNotMatch(result.failed.join(" "), /image-bed-secret-token-123456|another-secret-token-123456/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testDeleteRedactsBusinessFailureMessageFallback() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: false,
        message: "Delete rejected; Authorization: Bearer image-bed-secret-token-123456"
      })
    );
  });
  const baseUrl = await listen(server);

  try {
    const service = createImageBedService(baseUrl);
    const result = await service.deleteAdminFile({ path: "support-tickets/rejected.png" });

    assert.deepEqual(result.failed, ["Delete rejected; Authorization: Bearer ***"]);
    assert.doesNotMatch(result.failed.join(" "), /image-bed-secret-token-123456/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main() {
  await testListPreservesHttpStatusAndRedactsProviderError();
  await testListPreservesBusinessFailureMessage();
  await testUploadPreservesBusinessFailureMessage();
  await testListPreservesTimeoutReason();
  await testDeleteRedactsFailedArrayProviderErrors();
  await testDeleteRedactsBusinessFailureMessageFallback();
  console.log("image bed error fidelity regression checks passed");
}

void main();
