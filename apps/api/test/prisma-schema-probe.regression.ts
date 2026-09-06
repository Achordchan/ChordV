import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { assertPrismaSchemaCompatible, buildPrismaSchemaProbes } from "../src/modules/common/prisma-schema-probe";
import { SystemUpdateService } from "../src/modules/common/system-update.service";
import { HealthController } from "../src/modules/system/health.controller";

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
const models = Prisma.dmmf.datamodel.models;

function serviceWith(prisma: unknown) {
  const service = new SystemUpdateService(prisma as never, {} as never);
  // Keep migration-history success independent of the structural probe: this is
  // exactly the fallback case where all old migrations are marked finished.
  const internals = service as unknown as { detectPendingMigrations(): Promise<string[]>; logger: { warn(message: string): void } };
  internals.detectPendingMigrations = async () => [];
  internals.logger = { warn: () => undefined };
  return { service, internals };
}

async function genericUnavailable(work: () => Promise<void>) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof ServiceUnavailableException);
    assert.equal(error.getStatus(), 503);
    assert.deepEqual(error.getResponse(), { message: "service not ready", error: "Service Unavailable", statusCode: 503 });
    return true;
  });
}

async function unitTests() {
  const probes = buildPrismaSchemaProbes();
  assert.equal(probes.length, models.length);
  assert.ok(probes.length > 30, "cover the entire generated release, not a handpicked table");
  for (const [index, probe] of probes.entries()) {
    const model = models[index];
    const fields = model.fields.filter((field) => field.kind === "scalar" || field.kind === "enum");
    const table = [model.schema, model.dbName ?? model.name].filter((name): name is string => name != null).map(quote).join(".");
    assert.equal(probe.sql, `SELECT ${fields.map((field) => quote(field.dbName ?? field.name)).join(", ")} FROM ${table} LIMIT 0`);
    assert.deepEqual(probe.values, [], "no business values or externally supplied query text");
  }
  const mapped: Prisma.DMMF.Model = {
    ...models[0], name: "LogicalModel", dbName: 'mapped"table', schema: 'mapped"schema',
    fields: [
      { ...models[0].fields[0], name: "logicalId", dbName: 'mapped"id' },
      { ...models[0].fields[0], name: "role", kind: "enum" },
      { ...models[0].fields[0], name: "related", kind: "object" }
    ]
  };
  assert.equal(buildPrismaSchemaProbes([mapped])[0].sql,
    'SELECT "mapped""id", "role" FROM "mapped""schema"."mapped""table" LIMIT 0');
  assert.throws(() => buildPrismaSchemaProbes([]), /Missing generated/);
  assert.throws(() => buildPrismaSchemaProbes([{ ...mapped, fields: [] }]), /Missing Prisma scalar/);

  const seen: string[] = [];
  const emptyPrisma = {
    $queryRaw: async (query: Prisma.Sql) => { seen.push(query.sql); return []; },
    $queryRawUnsafe: async (query: string) => { assert.equal(query, "SELECT 1"); return [{ "?column?": 1 }]; }
  };
  await serviceWith(emptyPrisma).service.assertReady();
  assert.deepEqual(seen, probes.map((query) => query.sql), "empty tables must still execute every SELECT");
  for (const detail of ['column "passwordHash" does not exist', 'relation "User" does not exist', "permission denied for table RefreshToken"]) {
    await genericUnavailable(() => serviceWith({ ...emptyPrisma, $queryRaw: async () => { throw new Error(detail); } }).service.assertReady());
  }
  const pending = serviceWith(emptyPrisma);
  pending.internals.detectPendingMigrations = async () => ["new_migration"];
  await genericUnavailable(() => pending.service.assertReady());
  console.log("prisma-schema-probe unit regressions passed");
}

async function readinessCacheTests() {
  let now = 10_000;
  const clock = mock.method(performance, "now", () => now);
  try {
    for (const failure of [null, "connectivity", "migration-error", "pending", "schema"] as const) {
      let broken = failure !== null;
      let connections = 0;
      let migrations = 0;
      let schemaQueries = 0;
      let warnings = 0;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const { service, internals } = serviceWith({
        $queryRawUnsafe: async (query: string) => {
          assert.equal(query, "SELECT 1");
          connections++;
          entered();
          await gate;
          if (broken && failure === "connectivity") throw new Error("secret database address");
          return [];
        },
        $queryRaw: async () => {
          schemaQueries++;
          // Fail at the END of the sweep to exercise worst-case request amplification.
          if (broken && failure === "schema" && schemaQueries % models.length === 0) {
            throw new Error('column "secretColumn" does not exist');
          }
          return [];
        }
      });
      internals.logger = { warn: () => { warnings++; } };
      internals.detectPendingMigrations = async () => {
        migrations++;
        if (broken && failure === "migration-error") throw new Error("secret migration history error");
        return broken && failure === "pending" ? ["secret_migration"] : [];
      };
      const request = () => broken ? genericUnavailable(() => service.assertReady()) : service.assertReady();
      const flood = () => Promise.all(Array.from({ length: 100 }, request));
      const firstWave = flood();
      await started;
      assert.equal(connections, 1, "concurrent requests share connectivity work");
      now += 6_000;
      const slowWave = flood();
      await Promise.resolve();
      assert.equal(connections, 1, "an in-flight sweep must not expire, even after 5 seconds");
      release();
      await Promise.all([firstWave, slowWave]);
      const firstCounts = {
        connections: 1,
        migrations: failure === "connectivity" ? 0 : 1,
        schemaQueries: failure === null || failure === "schema" ? models.length : 0,
        warnings: failure === null ? 0 : 1
      };
      const counts = () => ({ connections, migrations, schemaQueries, warnings });
      assert.deepEqual(counts(), firstCounts, `${failure}: exactly one full check or failing prefix`);
      for (let repeat = 0; repeat < 3; repeat++) await flood();
      now += 4_999;
      await flood();
      assert.deepEqual(counts(), firstCounts, "both success and failure cache for 5s AFTER completion");
      // A cached result does not suppress revalidation forever. Failure recovers and
      // successful readiness still reruns connectivity, migrations and every table.
      broken = false;
      now += 1;
      await flood();
      assert.deepEqual(counts(), {
        connections: firstCounts.connections + 1,
        migrations: firstCounts.migrations + 1,
        schemaQueries: firstCounts.schemaQueries + models.length,
        warnings: firstCounts.warnings
      }, "expiry shares exactly one fresh complete check and can recover");
      const healthyCounts = counts();
      const health = new HealthController(service);
      for (let repeat = 0; repeat < 100; repeat++) assert.equal(health.health().status, "ok");
      assert.deepEqual(counts(), healthyCounts, "liveness never queries the database");
      if (failure === "schema") {
        broken = true;
        now += 5_000;
        await flood();
        assert.equal(schemaQueries, healthyCounts.schemaQueries + models.length);
        assert.equal(warnings, healthyCounts.warnings + 1, "schema drift is noticed after cached success expires");
        await flood();
        assert.equal(connections, healthyCounts.connections + 1, "new failure is cached too");
      }
    }
    // A different process/release has no inherited success, even before TTL expiry.
    const healthy = serviceWith({ $queryRawUnsafe: async () => [], $queryRaw: async () => [] });
    await healthy.service.assertReady();
    let fallbackQueries = 0;
    const fallback = serviceWith({
      $queryRawUnsafe: async () => [],
      $queryRaw: async () => { fallbackQueries++; throw new Error('column "oldColumn" does not exist'); }
    });
    await genericUnavailable(() => fallback.service.assertReady());
    assert.equal(fallbackQueries, 1, "fresh fallback checks actual schema despite complete migration history");
    console.log("readiness cache regressions passed (5s TTL; singleflight; cached failures; recovery; fresh fallback; cheap liveness)");
  } finally {
    clock.mock.restore();
  }
}

async function postgresTests() {
  // Explicit opt-in only: never borrow the application's DATABASE_URL. Every DDL
  // statement targets a new random schema, which is removed in finally.
  const databaseUrl = process.env.CHORDV_SCHEMA_PROBE_TEST_DATABASE_URL;
  if (!databaseUrl) {
    console.log("SKIP prisma-schema-probe PostgreSQL integration: set CHORDV_SCHEMA_PROBE_TEST_DATABASE_URL");
    return;
  }
  const schema = `schema_probe_${randomUUID().replace(/-/g, "")}`;
  const pg = new Client({ connectionString: databaseUrl });
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("schema", schema);
  const prisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
  let created = false;
  await pg.connect();
  try {
    await pg.query(`CREATE SCHEMA ${quote(schema)}`);
    created = true;
    const { internals } = serviceWith(prisma);
    // Each DDL scenario models a fresh boot/cache; TTL behaviour is covered above
    // with stubs rather than issuing repeated requests against a live database.
    const freshReady = () => {
      const fresh = serviceWith(prisma);
      fresh.internals.detectPendingMigrations = internals.detectPendingMigrations;
      return fresh.service.assertReady();
    };
    // No tables at all fails, even with old migration history declared complete.
    await genericUnavailable(freshReady);
    // Deliberately schema-only fixtures. TEXT columns are sufficient for this
    // structural gate; this does not assert real scalar types/business validity.
    for (const model of models) {
      assert.equal(model.schema, null, "fixture must be adapted if release introduces explicit schemas");
      const columns = model.fields.filter((field) => field.kind === "scalar" || field.kind === "enum")
        .map((field) => `${quote(field.dbName ?? field.name)} TEXT`).join(", ");
      await pg.query(`CREATE TABLE ${quote(schema)}.${quote(model.dbName ?? model.name)} (${columns})`);
    }
    await freshReady();
    // Use the REAL migration-history code too, with all of this release's bundled
    // migrations finished. A subsequent rename must still veto readiness.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.resolve(__dirname, "../prisma/migrations"), { withFileTypes: true });
    await pg.query(`CREATE TABLE ${quote(schema)}."_prisma_migrations" (migration_name TEXT, finished_at TIMESTAMPTZ)`);
    for (const entry of entries.filter((entry) => entry.isDirectory())) {
      await pg.query(`INSERT INTO ${quote(schema)}."_prisma_migrations" VALUES ($1, now())`, [entry.name]);
    }
    const real = new SystemUpdateService(prisma as never, {} as never);
    internals.detectPendingMigrations = () => (real as unknown as { detectPendingMigrations(dir: string): Promise<string[]> })
      .detectPendingMigrations(path.resolve(__dirname, "../../.."));
    await freshReady();
    await pg.query(`ALTER TABLE ${quote(schema)}."User" RENAME COLUMN "passwordHash" TO "renamedPasswordHash"`);
    await genericUnavailable(freshReady);
    await pg.query(`ALTER TABLE ${quote(schema)}."User" RENAME COLUMN "renamedPasswordHash" TO "passwordHash"`);
    await freshReady();
    await pg.query(`ALTER TABLE ${quote(schema)}."Node" DROP COLUMN "panelPassword"`);
    await genericUnavailable(freshReady);
    await pg.query(`ALTER TABLE ${quote(schema)}."Node" ADD COLUMN "panelPassword" TEXT`);
    await pg.query(`DROP TABLE ${quote(schema)}."RefreshToken"`);
    await genericUnavailable(freshReady);
    await pg.query(`CREATE TABLE ${quote(schema)}."RefreshToken" (${models.find((model) => model.name === "RefreshToken")!.fields
      .filter((field) => field.kind === "scalar" || field.kind === "enum").map((field) => `${quote(field.dbName ?? field.name)} TEXT`).join(", ")})`);
    await pg.query(`INSERT INTO ${quote(schema)}."User" ("passwordHash") VALUES ('sensitive-fixture-never-returned')`);
    await assertPrismaSchemaCompatible(prisma);
    for (const query of buildPrismaSchemaProbes()) assert.deepEqual(await prisma.$queryRaw(query), []);
    const mapped: Prisma.DMMF.Model = {
      ...models[0], dbName: 'mapped"table', schema,
      fields: [{ ...models[0].fields[0], dbName: 'mapped"column' }]
    };
    await pg.query(`CREATE TABLE ${quote(schema)}.${quote(mapped.dbName!)} (${quote('mapped"column')} TEXT)`);
    assert.deepEqual(await prisma.$queryRaw(buildPrismaSchemaProbes([mapped])[0]), []);
    console.log("prisma-schema-probe PostgreSQL regressions passed (isolated schema; empty/missing/renamed/mapped columns and tables)");
  } finally {
    await prisma.$disconnect();
    try { if (created) await pg.query(`DROP SCHEMA ${quote(schema)} CASCADE`); }
    finally { await pg.end(); }
  }
}

async function main() { await unitTests(); await readinessCacheTests(); await postgresTests(); }
void main().catch((error) => { console.error(error); process.exitCode = 1; });
