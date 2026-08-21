import { createHash } from "node:crypto";
import type { UsageBatchFixture } from "./types.ts";

export function createUsageBatchFixture(sequence: number, overrides: Partial<UsageBatchFixture> = {}): UsageBatchFixture {
  const base = {
    nodeId: "node_fixture_1",
    bootId: "boot_fixture_1",
    sequence,
    sampledAt: new Date(Date.UTC(2026, 6, 26, 0, 0, sequence)).toISOString(),
    entries: [
      {
        email: "subscription_1@example.invalid",
        uuid: "123e4567-e89b-42d3-a456-426614174000",
        counterGeneration: 1,
        uplinkBytes: String(sequence * 1024),
        downlinkBytes: String(sequence * 2048)
      }
    ]
  };
  const merged = { ...base, ...overrides };
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ ...merged, payloadHash: undefined }))
    .digest("hex");
  return { ...merged, payloadHash: overrides.payloadHash ?? payloadHash };
}

export function duplicateAndReorderBatches(batches: UsageBatchFixture[]) {
  return [...batches].reverse().flatMap((batch) => [batch, structuredClone(batch)]);
}

export function simulateIdempotentBatchAcceptance(batches: UsageBatchFixture[]) {
  const accepted = new Map<string, UsageBatchFixture>();
  const conflicts: string[] = [];
  for (const batch of batches) {
    const key = `${batch.nodeId}\u0000${batch.bootId}\u0000${batch.sequence}`;
    const existing = accepted.get(key);
    if (!existing) {
      accepted.set(key, batch);
    } else if (existing.payloadHash !== batch.payloadHash) {
      conflicts.push(key);
    }
  }
  return {
    accepted: [...accepted.values()].sort((a, b) => a.sequence - b.sequence),
    conflicts
  };
}
