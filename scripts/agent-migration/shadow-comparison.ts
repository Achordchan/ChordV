import type { ShadowComparisonReport, ShadowThresholds, ShadowUsageDelta } from "./types.ts";

const DECIMAL_BYTES_PATTERN = /^(0|[1-9]\d*)$/;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeUuid(value: string) {
  return value.trim().toLowerCase();
}

function keyOf(record: ShadowUsageDelta) {
  return `${record.nodeId.trim()}\u0000${normalizeEmail(record.email)}\u0000${normalizeUuid(record.uuid)}`;
}

function parseBytes(value: string, field: string) {
  if (!DECIMAL_BYTES_PATTERN.test(value)) throw new Error(`${field} 必须是非负十进制整数字符串`);
  return BigInt(value);
}

function totalBytes(record: ShadowUsageDelta) {
  return parseBytes(record.uplinkBytes, "uplinkBytes") + parseBytes(record.downlinkBytes, "downlinkBytes");
}

function indexUnique(records: ShadowUsageDelta[], source: string) {
  const index = new Map<string, ShadowUsageDelta>();
  for (const record of records) {
    const key = keyOf(record);
    if (index.has(key)) throw new Error(`${source} 存在重复用户：${record.nodeId}/${record.email}/${record.uuid}`);
    const startedAt = Date.parse(record.windowStartedAt);
    const endedAt = Date.parse(record.windowEndedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || startedAt >= endedAt) {
      throw new Error(`${source} 采样窗口无效：${record.nodeId}/${record.email}`);
    }
    totalBytes(record);
    index.set(key, record);
  }
  return index;
}

function percentDifference(difference: bigint, baseline: bigint) {
  if (baseline === 0n) return difference === 0n ? 0 : 100;
  const scaled = (difference * 1_000_000n) / baseline;
  const maximumFiniteScaled = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(scaled > maximumFiniteScaled ? maximumFiniteScaled : scaled) / 10_000;
}

export function compareShadowUsage(
  xuiRecords: ShadowUsageDelta[],
  directRecords: ShadowUsageDelta[],
  thresholds: ShadowThresholds,
  generatedAt = new Date().toISOString()
): ShadowComparisonReport {
  const absoluteThreshold = parseBytes(thresholds.absoluteBytes, "thresholds.absoluteBytes");
  if (!Number.isFinite(thresholds.relativePercent) || thresholds.relativePercent < 0) {
    throw new Error("thresholds.relativePercent 必须是非负有限数字");
  }
  const xui = indexUnique(xuiRecords, "xui");
  const direct = indexUnique(directRecords, "direct");
  const missing: ShadowComparisonReport["missing"] = [];
  const differences: ShadowComparisonReport["differences"] = [];

  for (const [key, xuiRecord] of xui) {
    const directRecord = direct.get(key);
    if (!directRecord) {
      missing.push({ source: "direct", nodeId: xuiRecord.nodeId, email: normalizeEmail(xuiRecord.email), uuid: normalizeUuid(xuiRecord.uuid) });
      continue;
    }
    if (xuiRecord.windowStartedAt !== directRecord.windowStartedAt || xuiRecord.windowEndedAt !== directRecord.windowEndedAt) {
      throw new Error(`采样窗口不一致：${xuiRecord.nodeId}/${xuiRecord.email}`);
    }
    const xuiBytes = totalBytes(xuiRecord);
    const directBytes = totalBytes(directRecord);
    const difference = xuiBytes >= directBytes ? xuiBytes - directBytes : directBytes - xuiBytes;
    const relativeAllowed = (xuiBytes * BigInt(Math.round(thresholds.relativePercent * 10_000))) / 1_000_000n;
    const allowed = absoluteThreshold > relativeAllowed ? absoluteThreshold : relativeAllowed;
    differences.push({
      nodeId: xuiRecord.nodeId,
      email: normalizeEmail(xuiRecord.email),
      uuid: normalizeUuid(xuiRecord.uuid),
      xuiBytes: xuiBytes.toString(),
      directBytes: directBytes.toString(),
      differenceBytes: difference.toString(),
      differencePercent: percentDifference(difference, xuiBytes),
      allowedDifferenceBytes: allowed.toString(),
      withinThreshold: difference <= allowed
    });
  }

  for (const [key, record] of direct) {
    if (!xui.has(key)) {
      missing.push({ source: "xui", nodeId: record.nodeId, email: normalizeEmail(record.email), uuid: normalizeUuid(record.uuid) });
    }
  }

  differences.sort((a, b) => [a.nodeId, a.email, a.uuid].join("|").localeCompare([b.nodeId, b.email, b.uuid].join("|")));
  missing.sort((a, b) => [a.nodeId, a.email, a.uuid, a.source].join("|").localeCompare([b.nodeId, b.email, b.uuid, b.source].join("|")));
  const overThresholdUsers = differences.filter((item) => !item.withinThreshold).length;
  return {
    generatedAt,
    readyForDirect: missing.length === 0 && overThresholdUsers === 0,
    thresholds,
    counts: {
      xuiUsers: xuiRecords.length,
      directUsers: directRecords.length,
      comparedUsers: differences.length,
      missingUsers: missing.length,
      overThresholdUsers
    },
    differences,
    missing
  };
}
