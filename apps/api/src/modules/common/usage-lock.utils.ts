import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { ConflictException } from "@nestjs/common";
import { Client as PgClient } from "pg";

const SUBSCRIPTION_USAGE_LOCK_KEY_1 = 420_704;
const SUBSCRIPTION_OWNER_LOCK_KEY_1 = 420_705;
const DEFAULT_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = 100;
const localSubscriptionLocks = new Map<string, Promise<void>>();
const heldSubscriptionLocks = new AsyncLocalStorage<Set<string>>();

export async function runWithSubscriptionUsageLock<T>(subscriptionId: string, task: () => Promise<T>) {
  const lockKey = `usage:${subscriptionId}`;
  if (heldSubscriptionLocks.getStore()?.has(lockKey)) {
    return task();
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return runWithLocalSubscriptionLock(lockKey, task);
  }

  const lockClient = new PgClient({
    connectionString,
    connectionTimeoutMillis: readPositiveIntegerEnv(
      "CHORDV_SUBSCRIPTION_LOCK_CONNECT_TIMEOUT_MS",
      readSubscriptionLockWaitTimeoutMs()
    )
  });
  let locked = false;
  try {
    await lockClient.connect();
    await acquirePgSubscriptionLock(lockClient, "subscription usage", [
      SUBSCRIPTION_USAGE_LOCK_KEY_1,
      deriveSubscriptionAdvisoryLockKey(subscriptionId)
    ]);
    locked = true;
    return await runWithinHeldSubscriptionLock(lockKey, task);
  } finally {
    if (locked) {
      await lockClient
        .query("select pg_advisory_unlock($1, $2)", [
          SUBSCRIPTION_USAGE_LOCK_KEY_1,
          deriveSubscriptionAdvisoryLockKey(subscriptionId)
        ])
        .catch(() => undefined);
    }
    await lockClient.end().catch(() => undefined);
  }
}

function deriveSubscriptionAdvisoryLockKey(subscriptionId: string) {
  return createHash("sha256").update(subscriptionId).digest().readInt32BE(0);
}

export async function runWithSubscriptionOwnerLock<T>(ownerKey: string, task: () => Promise<T>) {
  const lockKey = `owner:${ownerKey}`;
  if (heldSubscriptionLocks.getStore()?.has(lockKey)) {
    return task();
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return runWithLocalSubscriptionLock(lockKey, task);
  }

  const lockClient = new PgClient({
    connectionString,
    connectionTimeoutMillis: readPositiveIntegerEnv(
      "CHORDV_SUBSCRIPTION_LOCK_CONNECT_TIMEOUT_MS",
      readSubscriptionLockWaitTimeoutMs()
    )
  });
  let locked = false;
  try {
    await lockClient.connect();
    await acquirePgSubscriptionLock(lockClient, "subscription owner", [
      SUBSCRIPTION_OWNER_LOCK_KEY_1,
      deriveSubscriptionAdvisoryLockKey(ownerKey)
    ]);
    locked = true;
    return await runWithinHeldSubscriptionLock(lockKey, task);
  } finally {
    if (locked) {
      await lockClient
        .query("select pg_advisory_unlock($1, $2)", [
          SUBSCRIPTION_OWNER_LOCK_KEY_1,
          deriveSubscriptionAdvisoryLockKey(ownerKey)
        ])
        .catch(() => undefined);
    }
    await lockClient.end().catch(() => undefined);
  }
}

async function runWithLocalSubscriptionLock<T>(key: string, task: () => Promise<T>) {
  if (heldSubscriptionLocks.getStore()?.has(key)) {
    return task();
  }

  const previous = localSubscriptionLocks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  localSubscriptionLocks.set(key, tail);
  try {
    await waitForLocalSubscriptionLock(previous, key);
  } catch (error) {
    releaseCurrent();
    if (localSubscriptionLocks.get(key) === tail) {
      localSubscriptionLocks.delete(key);
    }
    throw error;
  }
  try {
    return await runWithinHeldSubscriptionLock(key, task);
  } finally {
    releaseCurrent();
    if (localSubscriptionLocks.get(key) === tail) {
      localSubscriptionLocks.delete(key);
    }
  }
}

function runWithinHeldSubscriptionLock<T>(key: string, task: () => Promise<T>) {
  const parentLocks = heldSubscriptionLocks.getStore();
  const nextLocks = new Set(parentLocks ?? []);
  nextLocks.add(key);
  return heldSubscriptionLocks.run(nextLocks, task);
}

async function acquirePgSubscriptionLock(
  client: PgClient,
  label: string,
  args: [number, number]
) {
  const timeoutMs = readSubscriptionLockWaitTimeoutMs();
  const retryIntervalMs = readSubscriptionLockRetryIntervalMs();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await client.query("select pg_try_advisory_lock($1, $2) as locked", args);
    if (result.rows[0]?.locked === true) {
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ConflictException(`${label} is still being processed; please retry shortly.`);
    }
    await delay(Math.min(retryIntervalMs, remainingMs));
  }
}

async function waitForLocalSubscriptionLock(previous: Promise<void>, key: string) {
  const timeoutMs = readSubscriptionLockWaitTimeoutMs();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new ConflictException(`${key} is still being processed; please retry shortly.`));
    }, timeoutMs);
  });

  try {
    await Promise.race([previous.catch(() => undefined), timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function readSubscriptionLockWaitTimeoutMs() {
  return readPositiveIntegerEnv("CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS", DEFAULT_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS);
}

function readSubscriptionLockRetryIntervalMs() {
  return readPositiveIntegerEnv("CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS", DEFAULT_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS);
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
