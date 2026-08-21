import "reflect-metadata";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES } from "@chordv/shared/update-limits";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { buildExternalArtifactPayload } from "../../admin/src/features/releases/artifactPayloads";
import { buildRemoteRuntimeComponentPayload, emptyRuntimeComponentEditorForm } from "../../admin/src/features/runtime-components/types";
import { CreateReleaseArtifactDto, CreateRuntimeComponentDto } from "../src/modules/admin/admin.dto";
import { RuntimeComponentsService } from "../src/modules/common/runtime-components.service";
import { assertReleaseArtifactClientUsable } from "../src/modules/common/release-center.utils";

const require = createRequire(import.meta.url);

async function assertSharedUpdateLimitDeploymentArtifacts() {
  const workspaceRoot = [process.cwd(), path.resolve(process.cwd(), "../..")].find((candidate) =>
    existsSync(path.join(candidate, "packages", "shared", "package.json"))
  );
  assert.ok(workspaceRoot, "workspace root containing packages/shared must be discoverable");
  const sharedRoot = path.join(workspaceRoot, "packages", "shared");
  const sharedPackage = JSON.parse(readFileSync(path.join(sharedRoot, "package.json"), "utf8"));
  const updateLimitExports = sharedPackage.exports?.["./update-limits"];

  assert.equal(updateLimitExports?.import, "./dist/update-limits.mjs");
  assert.equal(updateLimitExports?.require, "./dist/update-limits.cjs");

  const cjsPath = path.join(sharedRoot, "dist", "update-limits.cjs");
  const esmPath = path.join(sharedRoot, "dist", "update-limits.mjs");
  assert.equal(existsSync(cjsPath), true, "shared build must generate the CommonJS update-limit artifact");
  assert.equal(existsSync(esmPath), true, "shared build must generate the ESM update-limit artifact");
  assert.doesNotMatch(
    readFileSync(cjsPath, "utf8"),
    /\.\.\/src|update-limits\.data\.json/,
    "deployed CommonJS update-limit artifact must not depend on the source tree"
  );

  const cjsLimits = require(cjsPath);
  const esmLimits = await import(`${pathToFileURL(esmPath).href}?deployment-contract=1`);
  assert.equal(cjsLimits.MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES, MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES);
  assert.equal(esmLimits.MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES, MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES);
  assert.equal(esmLimits.default.MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES, MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES);

  const onePanelBundleSource = readFileSync(
    path.join(workspaceRoot, "scripts", "prepare-1panel-chordv-bundle.mjs"),
    "utf8"
  );
  assert.match(
    onePanelBundleSource,
    /["']packages\/shared\/scripts["']/,
    "1Panel bundle must include the shared runtime generator used by the Docker build"
  );
}

async function main() {
  await assertSharedUpdateLimitDeploymentArtifacts();
  const runtimeForm = {
    ...emptyRuntimeComponentEditorForm("xray"),
    platform: "windows" as const,
    architecture: "x64" as const,
    source: "custom_remote" as const,
    originUrl: "https://cdn.example.com/xray.zip",
    fileName: "xray.zip",
    expectedHash: "A".repeat(64)
  };
  const runtimePayload = buildRemoteRuntimeComponentPayload(runtimeForm);
  const runtimeDto = plainToInstance(CreateRuntimeComponentDto, runtimePayload);
  assert.deepEqual(validateSync(runtimeDto), [], "frontend runtime payload must satisfy the real DTO");

  let savedRuntime: Record<string, any> | null = null;
  const runtimeService = Object.assign(Object.create(RuntimeComponentsService.prototype), {
    prisma: {
      runtimeComponent: {
        create: async ({ data }: any) => {
          savedRuntime = data;
          return {
            ...data,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          };
        }
      }
    },
    withRuntimeComponentIdentityConflictGuard: async (task: () => Promise<unknown>) => task(),
    publishRuntimeComponentUpdatedBestEffort: () => undefined
  }) as RuntimeComponentsService;
  await runtimeService.createAdminRuntimeComponent(runtimePayload);
  assert.equal(savedRuntime?.expectedHash, "a".repeat(64));

  const artifactPayload = buildExternalArtifactPayload(
    "windows",
    "https://cdn.example.com/ChordV-full.zip",
    true,
    "104857600",
    "B".repeat(64),
    "windows_full_replace_zip"
  );
  const artifactDto = plainToInstance(CreateReleaseArtifactDto, artifactPayload);
  assert.deepEqual(validateSync(artifactDto), [], "frontend external artifact payload must satisfy the real DTO");

  const zeroSizeDto = plainToInstance(CreateReleaseArtifactDto, { ...artifactPayload, fileSizeBytes: "0" });
  assert.ok(
    validateSync(zeroSizeDto).some((error) => error.property === "fileSizeBytes"),
    "real DTO must reject zero-byte external artifacts"
  );
  const invalidHashDto = plainToInstance(CreateReleaseArtifactDto, { ...artifactPayload, fileHash: "not-a-sha256" });
  assert.deepEqual(validateSync(invalidHashDto), [], "invalid optional hashes must not block external artifacts");
  const overLimitDto = plainToInstance(CreateReleaseArtifactDto, {
    ...artifactPayload,
    fileSizeBytes: String(MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES + 1)
  });
  assert.ok(
    validateSync(overLimitDto).some((error) => error.property === "fileSizeBytes"),
    "real DTO must reject external artifacts above the shared desktop limit"
  );
  assert.doesNotThrow(() =>
    assertReleaseArtifactClientUsable(
      {
        ...artifactPayload,
        fileSizeBytes: BigInt(artifactPayload.fileSizeBytes!),
        fileHash: artifactPayload.fileHash!,
        deliveryMode: artifactPayload.deliveryMode!,
        type: artifactPayload.type,
        downloadUrl: artifactPayload.downloadUrl
      },
      "windows"
    )
  );
  assert.doesNotThrow(() =>
    assertReleaseArtifactClientUsable(
      {
        ...artifactPayload,
        fileSizeBytes: BigInt(artifactPayload.fileSizeBytes!),
        fileHash: null,
        deliveryMode: artifactPayload.deliveryMode!,
        type: artifactPayload.type,
        downloadUrl: artifactPayload.downloadUrl
      },
      "windows"
    )
  );

  assert.throws(
    () =>
      assertReleaseArtifactClientUsable(
        {
          ...artifactPayload,
          fileSizeBytes: BigInt(MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES) + 1n,
          fileHash: artifactPayload.fileHash!,
          deliveryMode: artifactPayload.deliveryMode!,
          type: artifactPayload.type,
          downloadUrl: artifactPayload.downloadUrl
        },
        "windows"
      ),
    /安装包不能超过/,
    "API publish gate must reject artifacts above the shared desktop limit"
  );


  assert.throws(
    () =>
      assertReleaseArtifactClientUsable(
        {
          ...artifactPayload,
          downloadUrl: "http://cdn.example.com/ChordV-full.zip",
          fileSizeBytes: BigInt(artifactPayload.fileSizeBytes!),
          fileHash: artifactPayload.fileHash!,
          deliveryMode: artifactPayload.deliveryMode!,
          type: artifactPayload.type
        },
        "windows"
      ),
    /HTTPS/,
    "API publish gate must reject desktop external artifacts that the native client refuses to download"
  );

  console.log("runtime-release-contract.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});