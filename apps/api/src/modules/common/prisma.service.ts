import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

const DEFAULT_PRISMA_CONNECTION_LIMIT = 10;
const DEFAULT_PRISMA_POOL_TIMEOUT_SECONDS = 20;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      datasources: {
        db: {
          url: resolvePrismaDatasourceUrl()
        }
      }
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

function resolvePrismaDatasourceUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return raw;
  }
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", readPositiveIntegerEnv("CHORDV_PRISMA_CONNECTION_LIMIT", DEFAULT_PRISMA_CONNECTION_LIMIT));
    }
    if (!url.searchParams.has("pool_timeout")) {
      url.searchParams.set("pool_timeout", readPositiveIntegerEnv("CHORDV_PRISMA_POOL_TIMEOUT_SECONDS", DEFAULT_PRISMA_POOL_TIMEOUT_SECONDS));
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return String(fallback);
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? String(value) : String(fallback);
}

