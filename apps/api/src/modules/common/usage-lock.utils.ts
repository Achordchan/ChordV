import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client as PgClient } from "pg";

const SUBSCRIPTION_USAGE_LOCK_KEY_1 = 420_704;
const SUBSCRIPTION_OWNER_LOCK_KEY_1 = 420_705;
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

  const lockClient = new PgClient({ connectionString });
  let locked = false;
  try {
    await lockClient.connect();
    await lockClient.query("select pg_advisory_lock($1, $2)", [
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

  const lockClient = new PgClient({ connectionString });
  let locked = false;
  try {
    await lockClient.connect();
    await lockClient.query("select pg_advisory_lock($1, $2)", [
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
  await previous.catch(() => undefined);
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
