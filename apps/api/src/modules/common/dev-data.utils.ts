export function dedupeNodeAccessRows<
  T extends {
    nodeId: string;
  }
>(rows: T[]): T[] {
  const nodeMap = new Map<string, T>();
  for (const row of rows) {
    if (!nodeMap.has(row.nodeId)) {
      nodeMap.set(row.nodeId, row);
    }
  }
  return Array.from(nodeMap.values());
}

export function pickLedgerNodeCandidate(
  leases: Array<{
    nodeId: string;
    issuedAt: Date;
    expiresAt: Date;
    lastHeartbeatAt: Date;
    revokedAt: Date | null;
  }>,
  recordedAt: Date
) {
  const recordedMs = recordedAt.getTime();
  const strict = leases
    .filter((lease) => {
      const start = lease.issuedAt.getTime() - 30_000;
      const end = Math.max(
        lease.expiresAt.getTime(),
        lease.lastHeartbeatAt.getTime(),
        lease.revokedAt?.getTime() ?? 0
      ) + 90_000;
      return recordedMs >= start && recordedMs <= end;
    })
    .sort((left, right) => right.issuedAt.getTime() - left.issuedAt.getTime());

  if (strict[0]) {
    return strict[0];
  }

  const fallback = leases
    .map((lease) => {
      const distance = Math.min(
        Math.abs(recordedMs - lease.issuedAt.getTime()),
        Math.abs(recordedMs - lease.expiresAt.getTime()),
        Math.abs(recordedMs - lease.lastHeartbeatAt.getTime()),
        Math.abs(recordedMs - (lease.revokedAt?.getTime() ?? lease.expiresAt.getTime()))
      );
      return { lease, distance };
    })
    .filter((item) => item.distance <= 10 * 60 * 1000)
    .sort((left, right) => left.distance - right.distance);

  return fallback[0]?.lease;
}
