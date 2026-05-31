import { createHash } from "node:crypto";
import { Client as PgClient } from "pg";

const SUBSCRIPTION_USAGE_LOCK_KEY_1 = 420_704;

export async function runWithSubscriptionUsageLock<T>(subscriptionId: string, task: () => Promise<T>) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return task();
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
    return await task();
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
