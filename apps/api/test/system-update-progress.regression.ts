import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { SystemUpdateService } from "../src/modules/common/system-update.service";
import { SYSTEM_UPDATE_PHASE_FILE } from "../src/modules/common/system-update.constants";
import { downloadExternalReleaseArtifactFile } from "../src/modules/common/release-center.utils";
import type { PrismaService } from "../src/modules/common/prisma.service";
import type { DownloadMirrorService } from "../src/modules/common/download-mirror.service";

/**
 * Progress visibility for running system-update operations:
 *  - app-side phase/progress persistence (throttled, best-effort, never after drain),
 *  - the download callback plumbing in release-center.utils,
 *  - supervisor phase.json passthrough into getOperation (allowlisted + operation-scoped),
 *  - terminal statuses clearing phase/progress.
 */

function buildService(prisma: { systemUpdateOperation: { update: (args: unknown) => Promise<unknown> } } = {
  systemUpdateOperation: { update: async () => undefined }
}) {
  return new SystemUpdateService(
    prisma as unknown as PrismaService,
    { getEffectiveConfig: async () => ({ defaultMirrorPrefix: null }) } as unknown as DownloadMirrorService
  );
}

async function phasePassthrough() {
  const state = mkdtempSync(path.join(tmpdir(), "chordv-phase-"));
  try {
    const service = buildService();
    (service as unknown as { config: { stateDir: string } }).config.stateDir = state;
    const svc = service as unknown as {
      readSupervisorPhase(): Promise<{ operationId: string; phase: string } | null>;
    };
    const file = path.join(state, SYSTEM_UPDATE_PHASE_FILE);

    assert.equal(await svc.readSupervisorPhase(), null, "missing phase.json yields null");

    // Only allowlisted supervisor phases pass; anything else is dropped.
    const valid: Array<[string, string]> = [
      ['{"operationId":"sysop-1","phase":"snapshotting"}', "snapshotting"],
      ['{"operationId":"sysop-1","phase":"migrating"}', "migrating"],
      ['{"operationId":"sysop-1","phase":"health-gating"}', "health-gating"],
      ['{"operationId":"sysop-1","phase":"stabilizing"}', "stabilizing"]
    ];
    for (const [raw, phase] of valid) {
      writeFileSync(file, raw);
      assert.deepEqual(await svc.readSupervisorPhase(), { operationId: "sysop-1", phase });
    }
    for (const raw of [
      '{"operationId":"sysop-1","phase":"downloading"}', // app-only phase: not supervisor-reportable
      '{"operationId":"sysop-1","phase":"custom-stage"}',
      '{"operationId":"sysop-1","phase":null}',
      '{"phase":"migrating"}',
      '{"operationId":"","phase":"migrating"}',
      'not json',
      "[]"
    ]) {
      writeFileSync(file, raw);
      assert.equal(await svc.readSupervisorPhase(), null, `must reject ${raw}`);
    }
    rmSync(file, { force: true });
    mkdirSync(file); // EISDIR: any read failure is null, never a throw
    assert.equal(await svc.readSupervisorPhase(), null);
    rmSync(file, { recursive: true });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

async function getOperationAppliesPhaseToMatchingRunningRow() {
  const state = mkdtempSync(path.join(tmpdir(), "chordv-getop-"));
  const updates: unknown[] = [];
  let row: Record<string, unknown>;
  const service = buildService({
    systemUpdateOperation: {
      update: async (args: unknown) => { updates.push(args); return undefined; },
      findUnique: async () => row
    }
  });
  (service as unknown as { config: { stateDir: string } }).config.stateDir = state;
  const svc = service as unknown as { getOperation(id: string): Promise<unknown> };
  const consume = service as unknown as { consumeResultMarker(): Promise<void> };
  consume.consumeResultMarker = async () => undefined;
  try {
    const file = path.join(state, SYSTEM_UPDATE_PHASE_FILE);

    // Matching operation + running row: supervisor phase wins over the stale row phase.
    row = { id: "r1", operationId: "sysop-2", kind: "update", status: "running", phase: "draining",
      progress: null, actorLabel: null, fromVersion: "1.0.0", toVersion: "1.2.0", failureReason: null,
      migrationApplied: false, startedAt: new Date(), finishedAt: null };
    writeFileSync(file, '{"operationId":"sysop-2","phase":"migrating"}');
    assert.equal((await svc.getOperation("sysop-2") as { phase: string }).phase, "migrating");

    // Non-matching operation: the phase.json belongs to another in-flight op.
    writeFileSync(file, '{"operationId":"sysop-other","phase":"migrating"}');
    assert.equal((await svc.getOperation("sysop-2") as { phase: string }).phase, "draining");

    // Terminal row: no phase is surfaced even if a stale one lingers in the DB.
    row = { ...row, status: "succeeded" };
    assert.equal((await svc.getOperation("sysop-2") as { phase: string }).phase, null);

    // progress only travels with the downloading phase.
    row = { ...row, status: "running", phase: "downloading", progress: 42 };
    assert.equal((await svc.getOperation("sysop-2") as { progress: number }).progress, 42);
    row = { ...row, phase: "extracting" };
    assert.equal((await svc.getOperation("sysop-2") as { progress: number | null }).progress, null);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

async function progressWriterThrottleAndDrainGuard() {
  const writes: Array<Record<string, unknown>> = [];
  const service = buildService({
    systemUpdateOperation: { update: async (args: unknown) => { writes.push((args as { data: Record<string, unknown> }).data); } }
  });
  const svc = service as unknown as {
    downloadProgressWriter(op: string): (progress: { downloadedBytes: number; totalBytes: number | null }) => boolean;
    markPhase(op: string, phase: string, progress?: number): Promise<void>;
  };

  const writer = svc.downloadProgressWriter("sysop-3");
  // First chunk writes immediately; subsequent chunks within the throttle window do not.
  assert.equal(writer({ downloadedBytes: 1_000_000, totalBytes: 10_000_000 }), true);
  assert.equal(writer({ downloadedBytes: 5_000_000, totalBytes: 10_000_000 }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1, "throttle window collapses burst writes");
  assert.equal(writes[0].phase, "downloading");
  assert.equal(writes[0].progress, 10);

  // No content-length: no percent progress is ever written.
  const unknownTotal = svc.downloadProgressWriter("sysop-4");
  unknownTotal({ downloadedBytes: 5, totalBytes: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1, "unknown total must not produce progress writes");

  // markPhase is best-effort: a DB failure is swallowed, never thrown.
  const failing = buildService({
    systemUpdateOperation: { update: async () => { throw new Error("db gone"); } }
  });
  await (failing as unknown as { markPhase(op: string, phase: string): Promise<void> }).markPhase("sysop-5", "extracting");
}

async function downloadCallbackPlumbing() {
  // The mirror-first download path must forward progress callbacks and survive an
  // observer that throws (best-effort reporting). Uses a local HTTP server; the
  // private-address SSRF guard is relaxed for the test process (same as
  // dev-data.service.regression.ts).
  const previousAllowPrivate = process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS;
  process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS = "true";
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-length": "300000", "content-type": "application/octet-stream" });
    for (let i = 0; i < 3; i += 1) res.write(Buffer.alloc(100_000));
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const events: Array<{ downloadedBytes: number; totalBytes: number | null }> = [];
  try {
    const url = `http://127.0.0.1:${port}/artifact.bin`;
    let threw = false;
    const result = await downloadExternalReleaseArtifactFile(url, null, (progress) => {
      events.push(progress);
      if (events.length === 2) { threw = true; throw new Error("observer exploded"); }
      return true;
    });
    assert.ok(threw, "observer exception path exercised");
    assert.equal(events.length, 3, "one progress event per chunk");
    assert.equal(events[0].totalBytes, 300000);
    assert.equal(events.at(-1)?.downloadedBytes, 300000);
    assert.equal(result.fileSizeBytes, 300000n);
    await result.cleanup();
  } finally {
    server.close();
    if (previousAllowPrivate === undefined) delete process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS;
    else process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS = previousAllowPrivate;
  }
}

async function markRunningResetsThrottle() {
  const writes: Array<Record<string, unknown>> = [];
  const service = buildService({
    systemUpdateOperation: { update: async (args: unknown) => { writes.push((args as { data: Record<string, unknown> }).data); } }
  });
  const svc = service as unknown as {
    markRunning(op: string, version: string): Promise<void>;
    downloadProgressWriter(op: string): (progress: { downloadedBytes: number; totalBytes: number }) => boolean;
  };
  await svc.markRunning("sysop-6", "1.2.0");
  assert.deepEqual(writes[0], { status: "running", toVersion: "1.2.0", phase: "checking", progress: null },
    "markRunning resets the row to a clean checking state");
  // After a fresh markRunning the throttle allows an immediate first write.
  svc.downloadProgressWriter("sysop-6")({ downloadedBytes: 100, totalBytes: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].phase, "downloading");
  assert.equal(writes[1].progress, 10);
  void performance;
}

async function main() {
  await phasePassthrough();
  await getOperationAppliesPhaseToMatchingRunningRow();
  await progressWriterThrottleAndDrainGuard();
  await downloadCallbackPlumbing();
  await markRunningResetsThrottle();
  console.log("system-update-progress.regression.ts passed (phase passthrough, throttle, download callback, reset)");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
