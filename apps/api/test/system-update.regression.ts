import "reflect-metadata";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Client as PgClient } from "pg";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import { HealthController } from "../src/modules/system/health.controller";
import { SystemUpdateController } from "../src/modules/system/system-update.controller";
import { SystemUpdateService, verifyManifestSignature } from "../src/modules/common/system-update.service";
import type { PrismaService } from "../src/modules/common/prisma.service";
import type { DownloadMirrorService } from "../src/modules/common/download-mirror.service";
import type { SystemUpdateCheckDto } from "@chordv/shared";
import type { fetchPublicHttpUrl } from "../src/modules/common/remote-url.utils";

const SYSTEM_ENV_KEYS = [
  "CHORDV_SYSTEM_VERSION",
  "CHORDV_SYSTEM_UPDATE_ENABLED",
  "CHORDV_SYSTEM_RELEASES_DIR",
  "CHORDV_SYSTEM_STATE_DIR",
  "CHORDV_SYSTEM_UPDATE_MANIFEST_URL",
  "CHORDV_SYSTEM_CURRENT_LINK"
];

function withSystemEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of SYSTEM_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const key of SYSTEM_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function buildService() {
  const prisma = {} as unknown as PrismaService;
  const downloadMirror = {
    getEffectiveConfig: async () => ({ defaultMirrorPrefix: null, allowClientMirror: true, updatedAt: null })
  } as unknown as DownloadMirrorService;
  return new SystemUpdateService(prisma, downloadMirror);
}

function routeMetadata(controller: object, method: string) {
  const handler = (controller as { prototype: Record<string, unknown> }).prototype[method];
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler as object) as string,
    method: Reflect.getMetadata(METHOD_METADATA, handler as object) as number
  };
}

// 1) SystemUpdateController is guarded by AdminAuthGuard and exposes the expected routes.
{
  const guards = (Reflect.getMetadata(GUARDS_METADATA, SystemUpdateController) ?? []) as unknown[];
  assert.ok(guards.includes(AdminAuthGuard), "SystemUpdateController must be protected by AdminAuthGuard");

  const controllerPath = Reflect.getMetadata(PATH_METADATA, SystemUpdateController) as string;
  assert.equal(controllerPath, "admin/system", "system routes must live under admin/system");

  const version = routeMetadata(SystemUpdateController, "getVersion");
  assert.equal(version.path, "version");
  assert.equal(version.method, 0, "getVersion must be GET");

  const update = routeMetadata(SystemUpdateController, "update");
  assert.equal(update.path, "update");
  assert.equal(update.method, 1, "update must be POST");

  const rollback = routeMetadata(SystemUpdateController, "rollback");
  assert.equal(rollback.method, 1, "rollback must be POST");

  const restart = routeMetadata(SystemUpdateController, "restart");
  assert.equal(restart.method, 1, "restart must be POST");
}

// 1b) Manifest signature verification (the update supply-chain trust anchor):
//     a valid ed25519 detached signature verifies; any tampering fails closed.
{
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const manifest = Buffer.from('{"version":"0.0.2","artifact":{"sha256":"deadbeef"}}', "utf8");
  const sig = edSign(null, manifest, privateKey).toString("base64");

  assert.equal(verifyManifestSignature(manifest, sig, pubB64), true, "valid signature must verify");
  assert.equal(
    verifyManifestSignature(Buffer.from(manifest.toString("utf8") + " ", "utf8"), sig, pubB64),
    false,
    "tampered manifest must fail"
  );
  assert.equal(verifyManifestSignature(manifest, "", pubB64), false, "empty signature must fail");
  assert.equal(verifyManifestSignature(manifest, "bm90LWEtc2ln", pubB64), false, "garbage signature must fail");

  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.equal(verifyManifestSignature(manifest, sig, other), false, "wrong key must fail");
  assert.equal(verifyManifestSignature(manifest, sig, "not-base64!!"), false, "malformed key must fail");
}

// 2) HealthController is public (no guard) and returns liveness without touching the DB.
{
  const guards = (Reflect.getMetadata(GUARDS_METADATA, HealthController) ?? []) as unknown[];
  assert.equal(guards.length, 0, "health endpoint must remain public for the supervisor");
  const controllerPath = Reflect.getMetadata(PATH_METADATA, HealthController) as string;
  assert.equal(controllerPath, "health");
}

async function assertUpdateRequestSafety() {
  const service = buildService();
  const svc = service as unknown as {
    assertOperational(): void;
    assertNoPromotionInFlight(): Promise<void>;
    acquireLock(): Promise<{ assertHeld(): Promise<void>; release(): Promise<void> }>;
    createOperationGuarded(): Promise<void>;
    runUpdateInBackground(op: string, from: string, lock: { assertHeld(): Promise<void>; release(): Promise<void> }, expected?: string): Promise<void>;
    finishOperation(op: string, status: string, data: { failureReason?: string; toVersion?: string }): Promise<void>;
    downloadAndExtractRelease(): Promise<string>;
    cache: unknown;
  };
  svc.assertOperational = () => undefined;
  svc.assertNoPromotionInFlight = async () => undefined;
  let acquired = 0;
  svc.acquireLock = async () => { acquired += 1; return { assertHeld: async () => undefined, release: async () => undefined }; };
  svc.createOperationGuarded = async () => undefined;

  await assert.rejects(() => service.startUpdate(null, null, "not-a-version"), BadRequestException);
  assert.equal(acquired, 0, "malformed confirmed versions must never acquire a PostgreSQL lock");

  for (const version of ["1.0.0", "0.9.0", "1.3.0", null]) {
    const release = version ? {
      version, tag: null, publishedAt: null, changelog: [], notes: null, htmlUrl: null,
      downloadUrl: "https://example.com/release.tar.gz", fileSizeBytes: null, sha256: "a".repeat(64)
    } : null;
    const check: SystemUpdateCheckDto = {
      currentVersion: "1.0.0", latestVersion: version ?? "1.0.0", hasUpdate: version === "1.3.0",
      cached: false, checkedAt: new Date().toISOString(), release, warning: null
    };
    service.checkUpdate = async () => check;
    // A concurrent cache refresh must not replace the release returned by this check.
    svc.cache = { release: { ...release, version: "1.2.0" } };
    const outcomes: { status: string; reason?: string; target?: string }[] = [];
    svc.finishOperation = async (_op, status, data) => {
      outcomes.push({ status, reason: data.failureReason, target: data.toVersion });
    };
    let released = 0;
    svc.downloadAndExtractRelease = async () => { assert.fail("changed target must not be downloaded"); };
    await svc.runUpdateInBackground("sysop-confirmed", "1.0.0", {
      assertHeld: async () => undefined,
      release: async () => { released += 1; }
    }, "1.2.0");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "failed", `changed/missing target ${version} must not report success`);
    assert.match(outcomes[0].reason ?? "", /确认的版本 v1\.2\.0/);
    assert.equal(outcomes[0].target, undefined, "keep the originally confirmed audit target");
    assert.equal(released, 1);
  }
}

async function assertRejectedManifestBodyCleanup() {
  const svc = buildService() as unknown as {
    fetchManifestText(url: string, mirror: string | null, requireHttps: boolean, fetchUrl: typeof fetchPublicHttpUrl): Promise<string>;
  };
  const signals: AbortSignal[] = [];
  let cancelled = 0;
  const fetchStub = (async (_url: string, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    return { response: {
      ok: false, status: 503,
      body: { cancel: async () => { cancelled += 1; } }
    } };
  }) as unknown as typeof fetchPublicHttpUrl;
  await assert.rejects(() => svc.fetchManifestText("https://example.com/latest.json", "https://mirror.example/", false, fetchStub), /HTTP 503/);
  assert.equal(signals.length, 2, "exercise both mirror and direct error responses");
  assert.equal(cancelled, 2, "every rejected response body must be cancelled");
  assert.ok(signals.every((signal) => signal.aborted), "abort error streams before releasing their timeout");
}

async function assertLockConnectionLoss() {
  class ClientStub extends EventEmitter {
    ended = 0;
    connectFailure = false;
    async connect() { if (this.connectFailure) throw new Error("connect failed"); }
    async query() { return { rows: [{ locked: true }] }; }
    async end() { this.ended += 1; this.emit("end"); }
  }
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://test:secret@example.test/test";
  try {
    const service = buildService();
    type Lock = { assertHeld(): Promise<void>; release(): Promise<void> };
    const svc = service as unknown as {
      acquireLock(factory: () => PgClient): Promise<Lock>;
      runUpdateInBackground(op: string, from: string, lock: Lock, expected: string): Promise<void>;
      clearPendingMarker(): Promise<void>;
      finishOperation(op: string, status: string, data: { failureReason: string }): Promise<void>;
      downloadAndExtractRelease(): Promise<string>;
      operationInFlight: boolean;
      markRunning(): Promise<void>;
      writePendingMarker(): Promise<void>;
      scheduleProcessExit(reason: string, lock: Lock, op: string): void;
    };
    for (const event of ["error", "end"]) {
      const client = new ClientStub();
      const lock = await svc.acquireLock(() => client as unknown as PgClient);
      await lock.assertHeld();
      // An idle pg error must be handled, not thrown by EventEmitter into the process.
      client.emit(event, new Error("server connection lost"));
      await assert.rejects(() => lock.assertHeld(), /锁连接已断开/);
      await assert.rejects(() => svc.acquireLock(() => new ClientStub() as unknown as PgClient), /取消中/);
      await lock.release();
      await lock.release();
      assert.equal(client.ended, 1, "release is idempotent");
      assert.equal(svc.operationInFlight, false);
    }
    const failed = new ClientStub();
    failed.connectFailure = true;
    await assert.rejects(() => svc.acquireLock(() => failed as unknown as PgClient), /connect failed/);
    assert.equal(failed.ended, 1);
    assert.equal(svc.operationInFlight, false, "connect failure must release local fence");

    const client = new ClientStub();
    const lock = await svc.acquireLock(() => client as unknown as PgClient);
    const outcomes: string[] = [];
    svc.finishOperation = async (_id, status, data) => { outcomes.push(status); assert.match(data.failureReason, /锁连接已断开/); };
    svc.clearPendingMarker = async () => undefined;
    svc.downloadAndExtractRelease = async () => { assert.fail("lost lock must not stage a release"); };
    service.checkUpdate = async () => {
      client.emit("error", new Error("database restart during manifest fetch"));
      return { currentVersion: "1.0.0", latestVersion: "1.2.0", hasUpdate: true, cached: false,
        checkedAt: new Date().toISOString(), release: null, warning: null };
    };
    await svc.runUpdateInBackground("sysop-lost", "1.0.0", lock, "1.2.0");
    assert.deepEqual(outcomes, ["failed"]);
    assert.equal(client.ended, 1);
    assert.equal(svc.operationInFlight, false);

    // Loss during staging must not write promotion intent after the download finishes.
    const stagingClient = new ClientStub();
    const stagingLock = await svc.acquireLock(() => stagingClient as unknown as PgClient);
    svc.markRunning = async () => undefined;
    svc.writePendingMarker = async () => { assert.fail("cancelled stage cannot write pending intent"); };
    service.checkUpdate = async () => ({
      currentVersion: "1.0.0", latestVersion: "1.2.0", hasUpdate: true, cached: false,
      checkedAt: new Date().toISOString(), warning: null,
      release: { version: "1.2.0", tag: null, publishedAt: null, changelog: [], notes: null,
        htmlUrl: null, downloadUrl: "https://example.com/release.tar.gz", fileSizeBytes: null, sha256: "a".repeat(64) }
    });
    svc.downloadAndExtractRelease = async () => {
      stagingClient.emit("error", new Error("connection lost while extracting"));
      return "/unused/stage";
    };
    await svc.runUpdateInBackground("sysop-stage-lost", "1.0.0", stagingLock, "1.2.0");
    assert.deepEqual(outcomes, ["failed", "failed"]);
    assert.equal(stagingClient.ended, 1);

    // Lock loss across drain/hooks/final publication is exercised with real HTTP
    // and durable markers in system-update-shutdown.regression.ts.
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
}

async function main() {
  await assertLockConnectionLoss();
  await assertUpdateRequestSafety();
  await assertRejectedManifestBodyCleanup();
  // 3) Disabled environment (no releases/state dir) refuses mutating operations.
  await withSystemEnv({ CHORDV_SYSTEM_VERSION: "0.0.1" }, async () => {
    const service = buildService();
    assert.equal(service.getCurrentVersion(), "0.0.1");
    assert.equal(service.getRuntimeStatus().enabled, false);
    await assert.rejects(() => service.startUpdate(null, null), BadRequestException);
    await assert.rejects(() => service.startRollback(null, null), BadRequestException);
    await assert.rejects(() => service.startRestart(null, null), BadRequestException);
  });

  // 4) check-update without a configured manifest returns a warning and no update.
  await withSystemEnv(
    { CHORDV_SYSTEM_VERSION: "0.0.1", CHORDV_SYSTEM_RELEASES_DIR: "/tmp/x", CHORDV_SYSTEM_STATE_DIR: "/tmp/y" },
    async () => {
      const service = buildService();
      assert.equal(service.getRuntimeStatus().enabled, true, "releases+state dirs should enable self-update");
      const result = await service.checkUpdate(false);
      assert.equal(result.hasUpdate, false);
      assert.equal(result.currentVersion, "0.0.1");
      assert.ok(result.warning && result.warning.includes("清单"), "missing manifest should surface a warning");
    }
  );

  // 5) 'v'-prefixed CHORDV_SYSTEM_VERSION is normalized.
  await withSystemEnv({ CHORDV_SYSTEM_VERSION: "v1.2.3" }, () => {
    const service = buildService();
    assert.equal(service.getCurrentVersion(), "1.2.3");
  });

  // 6) Signed-manifest anti-downgrade ratchet: once a signed version is accepted, a
  //    later (mirror-replayed) manifest advertising an OLDER version is rejected, and
  //    the persisted floor only ever moves forward. This closes the replay window
  //    where a stale/malicious mirror hides a newer release behind an old signed one.
  {
    const stateDir = mkdtempSync(path.join(tmpdir(), "chordv-floor-"));
    try {
      await withSystemEnv(
        {
          CHORDV_SYSTEM_VERSION: "1.0.0",
          CHORDV_SYSTEM_RELEASES_DIR: path.join(stateDir, "releases"),
          CHORDV_SYSTEM_STATE_DIR: stateDir
        },
        async () => {
          const service = buildService();
          const svc = service as unknown as { enforceSignedManifestFloor: (v: string) => Promise<void> };
          const floorFile = path.join(stateDir, "manifest-floor-version");

          await svc.enforceSignedManifestFloor("1.2.0");
          assert.equal(readFileSync(floorFile, "utf8").trim(), "1.2.0", "first accepted version sets the floor");

          await svc.enforceSignedManifestFloor("1.3.0");
          assert.equal(readFileSync(floorFile, "utf8").trim(), "1.3.0", "a newer version raises the floor");

          await assert.rejects(
            () => svc.enforceSignedManifestFloor("1.2.0"),
            /低于|回放|降级/,
            "an older signed manifest must be rejected as replay/downgrade"
          );
          assert.equal(readFileSync(floorFile, "utf8").trim(), "1.3.0", "a rejected downgrade must NOT lower the floor");

          // Re-serving the current highest version is allowed (== floor, no downgrade).
          await svc.enforceSignedManifestFloor("1.3.0");
          assert.equal(readFileSync(floorFile, "utf8").trim(), "1.3.0");
        }
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

void main().then(() => {
  console.log("system-update.regression.ts passed");
});
