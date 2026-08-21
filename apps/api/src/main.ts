import "dotenv/config";
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { resolveCorsOrigin } from "./cors";
import { forceHttpsMiddleware } from "./https-enforcement";
import { LoggingExceptionFilter } from "./logging-exception.filter";
import { assertAgentTokenPepperReadyForProduction } from "./modules/agent/agent.service";
import {
  assertNoPlaintextPanelPasswordsInProduction,
  assertPanelPasswordCryptoReadyForProduction,
  backfillPlaintextPanelPasswords
} from "./modules/common/panel-password-crypto";

async function bootstrap() {
  await assertPrismaMigrationBaselineOrExit();
  try {
    assertPanelPasswordCryptoReadyForProduction();
    assertAgentTokenPepperReadyForProduction();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  await backfillPanelPasswordsOrExit();
  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: resolveCorsOrigin,
      credentials: true,
      exposedHeaders: ["X-Request-Id"]
    }
  });

  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  const forceHttps = (process.env.CHORDV_API_FORCE_HTTPS ?? "true").toLowerCase() === "true";
  if (process.env.NODE_ENV === "production" && forceHttps) {
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
    app.use(forceHttpsMiddleware);
  }
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true
    })
  );
  app.useGlobalFilters(new LoggingExceptionFilter());

  const port = Number(process.env.CHORDV_API_PORT ?? 3000);
  const host = process.env.CHORDV_API_HOST?.trim();
  if (host) {
    await app.listen(port, host);
  } else {
    await app.listen(port);
  }
  configureHttpServerTimeouts(app.getHttpServer());
  console.log(`ChordV API listening on http://${host || "localhost"}:${port}/api`);
}

function configureHttpServerTimeouts(server: {
  requestTimeout?: number;
  headersTimeout?: number;
  keepAliveTimeout?: number;
}) {
  const requestTimeoutMs = readPositiveIntegerEnv("CHORDV_API_REQUEST_TIMEOUT_MS", 11 * 60 * 1000);
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, Math.max(server.headersTimeout ?? 0, 60 * 1000));
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}


async function backfillPanelPasswordsOrExit() {
  if ((process.env.CHORDV_SKIP_PANEL_PASSWORD_BACKFILL ?? "").toLowerCase() === "true") {
    if (process.env.NODE_ENV === "production" && (process.env.CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD ?? "").toLowerCase() !== "true") {
      console.error(
        "CHORDV_SKIP_PANEL_PASSWORD_BACKFILL=true is not allowed in production unless CHORDV_ALLOW_PLAINTEXT_PANEL_PASSWORD=true."
      );
      process.exit(1);
    }
    return;
  }
  if (!process.env.DATABASE_URL?.trim()) {
    return;
  }
  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      const result = await backfillPlaintextPanelPasswords(prisma);
      if (!result.skipped && (result.nodes > 0 || result.panelSyncJobs > 0)) {
        console.log(
          `Encrypted legacy plaintext panel passwords: nodes=${result.nodes}, panelSyncJobs=${result.panelSyncJobs}`
        );
      }
      await assertNoPlaintextPanelPasswordsInProduction(prisma);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  } catch (error) {
    console.error(
      `Panel password backfill failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

async function assertPrismaMigrationBaselineOrExit() {

  if ((process.env.CHORDV_SKIP_MIGRATION_BASELINE_CHECK ?? "").toLowerCase() === "true") {
    return;
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return;
  }
  type BaselinePrisma = {
    $queryRawUnsafe: (query: string) => Promise<unknown>;
    $disconnect: () => Promise<void>;
  };
  let prisma: BaselinePrisma;
  try {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient() as BaselinePrisma;
  } catch {
    return;
  }
  try {
    const tables = (await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    )) as Array<{ table_name: string }>;
    const names = new Set(tables.map((row) => String(row.table_name)));
    const hasBusinessTables = ["User", "Node", "Subscription"].some((name) => names.has(name));
    const hasMigrationHistory = names.has("_prisma_migrations");
    if (hasBusinessTables && !hasMigrationHistory) {
      console.error(
        [
          "ChordV API refused to start: database already has business tables but no Prisma migration history (_prisma_migrations).",
          "This usually means the database was created with prisma db push and is not ready for prisma migrate deploy.",
          "Run a controlled baseline first, then restart. Temporary bypass: CHORDV_SKIP_MIGRATION_BASELINE_CHECK=true"
        ].join("\n")
      );
      process.exit(1);
    }
  } catch (error) {
    // Do not block boot on transient DB connectivity; Nest/Prisma will fail clearly later if needed.
    console.warn(
      `Prisma migration baseline check skipped due to database error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

bootstrap();
