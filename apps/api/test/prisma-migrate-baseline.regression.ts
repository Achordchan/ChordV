import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function loadBaselineModule() {
  const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/prisma-migrate-with-baseline.mjs");
  return import(pathToFileURL(modulePath).href);
}

async function testListMigrationNames() {
  const mod = await loadBaselineModule();
  const dir = mkdtempSync(path.join(tmpdir(), "chordv-mig-"));
  try {
    mkdirSync(path.join(dir, "20260101000000_init"));
    mkdirSync(path.join(dir, "20260102000000_next"));
    writeFileSync(path.join(dir, "migration_lock.toml"), 'provider = "postgresql"\n');
    writeFileSync(path.join(dir, "notes.txt"), "ignore");
    const names = mod.listMigrationNames(dir);
    assert.deepEqual(names, ["20260101000000_init", "20260102000000_next"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testDiffInterpretsExitCodes() {
  const mod = await loadBaselineModule();
  const identical = mod.diffDatabaseToDatamodel({
    databaseUrl: "postgresql://example",
    runner: () => ({ status: 0, stdout: "", stderr: "" })
  });
  assert.equal(identical.ok, true);
  assert.equal(identical.identical, true);

  const drifted = mod.diffDatabaseToDatamodel({
    databaseUrl: "postgresql://example",
    runner: () => ({ status: 2, stdout: 'ALTER TABLE "User" ALTER COLUMN "email" SET NOT NULL;', stderr: "" })
  });
  assert.equal(drifted.ok, true);
  assert.equal(drifted.identical, false);

  const failed = mod.diffDatabaseToDatamodel({
    databaseUrl: "postgresql://example",
    runner: () => ({ status: 1, stdout: "", stderr: "connection refused" })
  });
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /connection refused|failed/i);
}

async function testInitDiffUsesSchemaDatamodelNotShadow() {
  const mod = await loadBaselineModule();
  const calls: string[][] = [];
  const result = mod.diffDatabaseToInitMigration({
    databaseUrl: "postgresql://example",
    runner: (_cmd: string, args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.identical, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--to-schema-datamodel"), "init diff must use schema datamodel");
  assert.ok(!calls[0].includes("--to-migrations"), "init diff must not require --to-migrations/shadow DB");
  assert.ok(!calls[0].includes("--shadow-database-url"));
  const schemaArgIndex = calls[0].indexOf("--to-schema-datamodel");
  const schemaPath = calls[0][schemaArgIndex + 1];
  assert.ok(String(schemaPath).replace(/\\/g, "/").endsWith("apps/api/prisma/schema.init.prisma"));
  assert.equal(existsSync(schemaPath), true, "schema.init.prisma snapshot must exist in repo");
}

async function testClassifyBaselinePaths() {
  const mod = await loadBaselineModule();

  const all = mod.classifyBaselineFromDiffs({
    finalDiff: { ok: true, identical: true },
    initDiff: { ok: true, identical: false }
  });
  assert.equal(all.mode, "all");

  const initOnly = mod.classifyBaselineFromDiffs({
    finalDiff: { ok: true, identical: false, stdout: 'CREATE TABLE "SupportTicketPendingAttachment"' },
    initDiff: { ok: true, identical: true }
  });
  assert.equal(initOnly.mode, "init");
  assert.match(initOnly.reason, /init/i);

  const blocked = mod.classifyBaselineFromDiffs({
    finalDiff: { ok: true, identical: false, stdout: "ALTER TABLE" },
    initDiff: { ok: true, identical: false, stdout: "ALTER TABLE" }
  });
  assert.equal(blocked.mode, "none");
  assert.equal(blocked.blocked, true);
}

async function testInspectBaselineModes() {
  const mod = await loadBaselineModule();
  const prisma = {
    $queryRawUnsafe: async () => [
      { table_name: "User" },
      { table_name: "Node" },
      { table_name: "Subscription" }
    ]
  };

  const finalMatch = await mod.inspectBaselineNeedForTests(prisma, {
    finalDiff: { ok: true, identical: true, stdout: "", stderr: "" },
    initDiff: { ok: true, identical: false, stdout: "CREATE TABLE", stderr: "" },
    allMigrations: ["20260717000000_init", "20260717120000_pending"]
  });
  assert.equal(finalMatch.shouldBaseline, true);
  assert.equal(finalMatch.mode, "all");
  assert.deepEqual(finalMatch.migrations, ["20260717000000_init", "20260717120000_pending"]);

  const initMatch = await mod.inspectBaselineNeedForTests(prisma, {
    finalDiff: { ok: true, identical: false, stdout: 'CREATE TABLE "SupportTicketPendingAttachment"', stderr: "" },
    initDiff: { ok: true, identical: true, stdout: "", stderr: "" },
    allMigrations: ["20260717000000_init", "20260717120000_pending"],
    initMigration: "20260717000000_init"
  });
  assert.equal(initMatch.shouldBaseline, true);
  assert.equal(initMatch.mode, "init");
  assert.deepEqual(initMatch.migrations, ["20260717000000_init"]);

  const drifted = await mod.inspectBaselineNeedForTests(prisma, {
    finalDiff: { ok: true, identical: false, stdout: "ALTER TABLE", stderr: "" },
    initDiff: { ok: true, identical: false, stdout: "ALTER TABLE", stderr: "" }
  });
  assert.equal(drifted.shouldBaseline, false);
  assert.equal(drifted.blocked, true);
}

async function main() {
  await testListMigrationNames();
  await testDiffInterpretsExitCodes();
  await testInitDiffUsesSchemaDatamodelNotShadow();
  await testClassifyBaselinePaths();
  await testInspectBaselineModes();
  console.log("prisma-migrate-baseline.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});