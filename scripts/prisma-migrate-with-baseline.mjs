#!/usr/bin/env node
/**
 * Run before / instead of bare `prisma migrate deploy` on production.
 *
 * Auto-baseline is intentionally strict and two-path:
 * - live DB matches FINAL schema.prisma  -> baseline ALL local migrations, then deploy
 * - live DB matches INIT schema snapshot (schema.init.prisma) -> baseline ONLY init, then deploy
 * - anything else                        -> refuse (unless CHORDV_PRISMA_FORCE_BASELINE=true, which
 *                                           only baselines INIT, never later migrations)
 *
 * Init comparison uses --to-schema-datamodel against schema.init.prisma so a shadow database
 * is NOT required (unlike --to-migrations).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const INIT_MIGRATION = process.env.CHORDV_PRISMA_BASELINE_MIGRATION || "20260717000000_init";
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const forceBaseline = (process.env.CHORDV_PRISMA_FORCE_BASELINE || "").toLowerCase() === "true";
const skip = (process.env.CHORDV_SKIP_MIGRATION_BASELINE_CHECK || "").toLowerCase() === "true";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const migrationsDir = resolve(repoRoot, "apps/api/prisma/migrations");
const schemaPath = resolve(repoRoot, "apps/api/prisma/schema.prisma");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
    cwd: repoRoot,
    ...options
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCapture(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: process.env,
    cwd: repoRoot,
    ...options
  });
}

export function listMigrationNames(dir = migrationsDir) {
  return readdirSync(dir)
    .filter((name) => {
      if (name === "migration_lock.toml") return false;
      try {
        return statSync(resolve(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Full structural comparison helpers.
 * Prisma exit codes: 0 = no diff, 2 = diff present, other = tool error.
 */
export function interpretDiffResult(result) {
  const stdout = String(result?.stdout || "").trim();
  const stderr = String(result?.stderr || "").trim();
  const status = result?.status;
  if (status === 0) {
    return { ok: true, identical: true, stdout, stderr, status };
  }
  if (status === 2) {
    return { ok: true, identical: false, stdout, stderr, status };
  }
  return {
    ok: false,
    identical: false,
    error: stderr || stdout || `prisma migrate diff failed with status ${status}`,
    status,
    stdout,
    stderr
  };
}

export function diffDatabaseToDatamodel({
  databaseUrl = DATABASE_URL,
  schema = schemaPath,
  runner = runCapture
} = {}) {
  if (!databaseUrl) {
    return { ok: false, identical: false, error: "DATABASE_URL missing" };
  }
  const result = runner(
    "pnpm",
    [
      "--filter",
      "@chordv/api",
      "exec",
      "prisma",
      "migrate",
      "diff",
      "--from-url",
      databaseUrl,
      "--to-schema-datamodel",
      schema,
      "--exit-code"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  return interpretDiffResult(result);
}

export function resolveInitSchemaPath({
  initSchema = resolve(repoRoot, "apps/api/prisma/schema.init.prisma"),
  schema = schemaPath
} = {}) {
  if (existsSync(initSchema)) {
    return initSchema;
  }
  return null;
}

/**
 * Compare live DB to the INIT schema snapshot via --to-schema-datamodel.
 * Avoids Prisma --to-migrations shadow-database requirement.
 */
export function diffDatabaseToInitMigration({
  databaseUrl = DATABASE_URL,
  initSchema = resolve(repoRoot, "apps/api/prisma/schema.init.prisma"),
  schema = schemaPath,
  runner = runCapture
} = {}) {
  if (!databaseUrl) {
    return { ok: false, identical: false, error: "DATABASE_URL missing" };
  }
  let tempDir = null;
  try {
    let targetSchema = initSchema;
    if (!existsSync(targetSchema)) {
      // Derive init schema from current schema by removing post-init models.
      const current = readFileSync(schema, "utf8");
      const stripped = current.replace(
        /\nmodel SupportTicketPendingAttachment \{[\s\S]*?\n\}\n/,
        "\n"
      );
      if (stripped === current) {
        return {
          ok: false,
          identical: false,
          error: `Init schema snapshot missing at ${initSchema} and could not derive it from ${schema}`
        };
      }
      tempDir = mkdtempSync(join(tmpdir(), "chordv-init-schema-"));
      targetSchema = join(tempDir, "schema.init.prisma");
      writeFileSync(targetSchema, stripped);
    }
    const result = runner(
      "pnpm",
      [
        "--filter",
        "@chordv/api",
        "exec",
        "prisma",
        "migrate",
        "diff",
        "--from-url",
        databaseUrl,
        "--to-schema-datamodel",
        targetSchema,
        "--exit-code"
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    return interpretDiffResult(result);
  } catch (error) {
    return {
      ok: false,
      identical: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Classify how much of the migration history should be baselined.
 * Returns: { mode: "none"|"init"|"all", reason, blocked? }
 */
export function classifyBaselineFromDiffs({ finalDiff, initDiff } = {}) {
  if (finalDiff?.ok && finalDiff.identical) {
    return {
      mode: "all",
      reason: "live database fully matches current Prisma schema"
    };
  }
  if (initDiff?.ok && initDiff.identical) {
    return {
      mode: "init",
      reason: `live database matches init migration ${INIT_MIGRATION}; later migrations must still run`
    };
  }
  if (finalDiff && !finalDiff.ok) {
    return {
      mode: "none",
      blocked: true,
      reason: `unable to diff against final schema (${finalDiff.error})`
    };
  }
  if (initDiff && !initDiff.ok) {
    return {
      mode: "none",
      blocked: true,
      reason: `unable to diff against init migration (${initDiff.error})`
    };
  }
  const snippet = (finalDiff?.stdout || finalDiff?.stderr || initDiff?.stdout || initDiff?.stderr || "non-empty diff").slice(0, 500);
  return {
    mode: "none",
    blocked: true,
    reason: `schema matches neither init migration nor final Prisma schema: ${snippet}`
  };
}

async function inspectBusinessTables(prisma) {
  const tables = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const names = new Set(tables.map((row) => String(row.table_name)));
  const requiredBusinessTables = ["User", "Node", "Subscription"];
  const presentBusinessTables = requiredBusinessTables.filter((name) => names.has(name));
  return {
    names,
    presentBusinessTables,
    hasMigrationHistory: names.has("_prisma_migrations"),
    hasAnyBusinessTable: presentBusinessTables.length > 0,
    hasAllBusinessTables: presentBusinessTables.length === requiredBusinessTables.length
  };
}

export async function inspectBaselineNeedForTests(prisma, options = {}) {
  const state = await inspectBusinessTables(prisma);
  if (!state.hasAnyBusinessTable || state.hasMigrationHistory) {
    return {
      mode: "none",
      shouldBaseline: false,
      migrations: [],
      reason: state.hasMigrationHistory ? "migration history present" : "no business tables detected"
    };
  }
  if (!state.hasAllBusinessTables) {
    return {
      mode: "none",
      shouldBaseline: false,
      blocked: true,
      migrations: [],
      reason: `partial business schema detected (${state.presentBusinessTables.join(",") || "none"}); refusing auto-baseline`
    };
  }

  const finalDiff =
    options.finalDiff ??
    diffDatabaseToDatamodel({
      databaseUrl: options.databaseUrl,
      schema: options.schema,
      runner: options.runner
    });
  const initDiff =
    options.initDiff ??
    diffDatabaseToInitMigration({
      databaseUrl: options.databaseUrl,
      initSchema: options.initSchema,
      schema: options.schema,
      runner: options.runner
    });
  const classified = classifyBaselineFromDiffs({ finalDiff, initDiff });
  if (classified.mode === "all") {
    return {
      mode: "all",
      shouldBaseline: true,
      migrations: options.allMigrations ?? listMigrationNames(),
      reason: classified.reason
    };
  }
  if (classified.mode === "init") {
    return {
      mode: "init",
      shouldBaseline: true,
      migrations: [options.initMigration || INIT_MIGRATION],
      reason: classified.reason
    };
  }
  return {
    mode: "none",
    shouldBaseline: false,
    blocked: Boolean(classified.blocked),
    migrations: [],
    reason: classified.reason
  };
}

async function needsBaseline() {
  if (!DATABASE_URL) {
    console.log("DATABASE_URL missing; skipping baseline inspection.");
    return { baseline: false, migrations: [] };
  }
  if (skip) {
    console.log("CHORDV_SKIP_MIGRATION_BASELINE_CHECK=true; skipping baseline inspection.");
    return { baseline: false, migrations: [] };
  }

  const allMigrations = listMigrationNames();
  const candidates = [
    createRequire(import.meta.url),
    createRequire(new URL("../apps/api/package.json", import.meta.url)),
    createRequire(new URL("../node_modules/@prisma/client/package.json", import.meta.url))
  ];
  let PrismaClient;
  let lastError = null;
  for (const require of candidates) {
    try {
      ({ PrismaClient } = require("@prisma/client"));
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!PrismaClient) {
    if (forceBaseline) {
      console.warn(
        `Prisma client unavailable (${lastError instanceof Error ? lastError.message : String(lastError)}). ` +
          "CHORDV_PRISMA_FORCE_BASELINE=true falls back to baselining ONLY the init migration."
      );
      return { baseline: true, migrations: [INIT_MIGRATION] };
    }
    console.warn(
      `Prisma client unavailable for baseline check: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
    return { baseline: false, migrations: [] };
  }

  const prisma = new PrismaClient();
  try {
    const result = await inspectBaselineNeedForTests(prisma, {
      allMigrations,
      initMigration: INIT_MIGRATION
    });
    if (result.blocked) {
      if (forceBaseline) {
        console.warn(
          `Schema classification blocked (${result.reason}). ` +
            "CHORDV_PRISMA_FORCE_BASELINE=true baselines ONLY init, then migrate deploy will apply later migrations."
        );
        return { baseline: true, migrations: [INIT_MIGRATION] };
      }
      console.error(
        [
          `ChordV refused automatic Prisma baseline: ${result.reason}.`,
          "If the DB matches an older complete init schema, fix connectivity/diff first; do not force-mark later migrations applied.",
          "Emergency: CHORDV_PRISMA_FORCE_BASELINE=true baselines ONLY init.",
          "Temporary skip only: CHORDV_SKIP_MIGRATION_BASELINE_CHECK=true"
        ].join("\n")
      );
      process.exit(1);
    }
    if (result.shouldBaseline) {
      console.warn(
        `Baseline mode=${result.mode}: ${result.reason}. Will mark applied: ${result.migrations.join(", ")}`
      );
      return { baseline: true, migrations: result.migrations };
    }
    console.log(`Baseline not required (${result.reason}).`);
    return { baseline: false, migrations: [] };
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function main() {
  const decision = await needsBaseline();
  if (decision.baseline) {
    for (const migration of decision.migrations) {
      console.log(`Marking migration applied as baseline: ${migration}`);
      run("pnpm", ["--filter", "@chordv/api", "exec", "prisma", "migrate", "resolve", "--applied", migration]);
    }
  }
  console.log("Running prisma migrate deploy...");
  run("pnpm", ["--filter", "@chordv/api", "exec", "prisma", "migrate", "deploy"]);
  console.log("Prisma migrate with baseline finished.");
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  await main();
}

