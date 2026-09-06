import type {
  RestartAwareShadowReport,
  ShadowCounterSample,
  ShadowRebaselineBoundary,
  ShadowSteadyDifference,
  ShadowThresholds
} from "./types.ts";

const DECIMAL_BYTES_PATTERN = /^(0|[1-9]\d*)$/;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeUuid(value: string) {
  return value.trim().toLowerCase();
}

function identityKey(sample: ShadowCounterSample) {
  return `${sample.nodeId.trim()}\u0000${normalizeEmail(sample.email)}\u0000${normalizeUuid(sample.uuid)}`;
}

function parseBytes(value: string, field: string) {
  if (!DECIMAL_BYTES_PATTERN.test(value)) throw new Error(`${field} 必须是非负十进制整数字符串`);
  return BigInt(value);
}

function validateSample(sample: ShadowCounterSample, source: string) {
  if (!sample.nodeId.trim() || !normalizeEmail(sample.email) || !normalizeUuid(sample.uuid)) {
    throw new Error(`${source} 样本身份无效`);
  }
  if (!sample.checkpointId.trim()) throw new Error(`${source} checkpointId 不能为空`);
  if (!sample.counterGeneration.trim()) throw new Error(`${source} counterGeneration 不能为空`);
  if (!Number.isFinite(Date.parse(sample.sampledAt))) throw new Error(`${source} sampledAt 无效：${sample.checkpointId}`);
  parseBytes(sample.uplinkBytes, `${source}.uplinkBytes`);
  parseBytes(sample.downlinkBytes, `${source}.downlinkBytes`);
}

function indexSamples(samples: ShadowCounterSample[], source: string) {
  const identities = new Map<string, Map<string, ShadowCounterSample>>();
  for (const sample of samples) {
    validateSample(sample, source);
    const key = identityKey(sample);
    const checkpoints = identities.get(key) ?? new Map<string, ShadowCounterSample>();
    if (checkpoints.has(sample.checkpointId)) {
      throw new Error(`${source} 存在重复检查点：${sample.nodeId}/${sample.email}/${sample.checkpointId}`);
    }
    checkpoints.set(sample.checkpointId, sample);
    identities.set(key, checkpoints);
  }
  return identities;
}

function counterDelta(current: ShadowCounterSample, previous: ShadowCounterSample, source: string) {
  const currentUp = parseBytes(current.uplinkBytes, `${source}.uplinkBytes`);
  const currentDown = parseBytes(current.downlinkBytes, `${source}.downlinkBytes`);
  const previousUp = parseBytes(previous.uplinkBytes, `${source}.uplinkBytes`);
  const previousDown = parseBytes(previous.downlinkBytes, `${source}.downlinkBytes`);
  if (currentUp < previousUp || currentDown < previousDown) {
    throw new Error(`${source} 同一 counterGeneration 内计数回退：${current.nodeId}/${current.email}/${current.checkpointId}`);
  }
  return currentUp - previousUp + currentDown - previousDown;
}

function percentDifference(difference: bigint, baseline: bigint) {
  if (baseline === 0n) return difference === 0n ? 0 : 100;
  const scaled = (difference * 1_000_000n) / baseline;
  const maximumFiniteScaled = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(scaled > maximumFiniteScaled ? maximumFiniteScaled : scaled) / 10_000;
}

function allowedDifference(xuiBytes: bigint, thresholds: ShadowThresholds) {
  const absolute = parseBytes(thresholds.absoluteBytes, "thresholds.absoluteBytes");
  const relative = (xuiBytes * BigInt(Math.round(thresholds.relativePercent * 10_000))) / 1_000_000n;
  return absolute > relative ? absolute : relative;
}

export function compareRestartAwareShadowUsage(
  xuiSamples: ShadowCounterSample[],
  directSamples: ShadowCounterSample[],
  thresholds: ShadowThresholds,
  minimumSteadyWindows = 1,
  generatedAt = new Date().toISOString()
): RestartAwareShadowReport {
  parseBytes(thresholds.absoluteBytes, "thresholds.absoluteBytes");
  if (!Number.isFinite(thresholds.relativePercent) || thresholds.relativePercent < 0) {
    throw new Error("thresholds.relativePercent 必须是非负有限数字");
  }
  if (!Number.isSafeInteger(minimumSteadyWindows) || minimumSteadyWindows < 1) {
    throw new Error("minimumSteadyWindows 必须是正整数");
  }

  const xui = indexSamples(xuiSamples, "xui");
  const direct = indexSamples(directSamples, "direct");
  const differences: ShadowSteadyDifference[] = [];
  const boundaries: ShadowRebaselineBoundary[] = [];
  const missing: RestartAwareShadowReport["missing"] = [];
  const insufficientSteady: RestartAwareShadowReport["insufficientSteady"] = [];
  let checkpoints = 0;

  for (const [key, xuiCheckpoints] of xui) {
    const directCheckpoints = direct.get(key);
    const first = xuiCheckpoints.values().next().value as ShadowCounterSample;
    if (!directCheckpoints) {
      missing.push({ source: "direct", nodeId: first.nodeId, email: normalizeEmail(first.email), uuid: normalizeUuid(first.uuid) });
      continue;
    }

    for (const sample of xuiCheckpoints.values()) {
      if (!directCheckpoints.has(sample.checkpointId)) {
        missing.push({ source: "direct", nodeId: sample.nodeId, email: normalizeEmail(sample.email), uuid: normalizeUuid(sample.uuid), checkpointId: sample.checkpointId });
      }
    }
    for (const sample of directCheckpoints.values()) {
      if (!xuiCheckpoints.has(sample.checkpointId)) {
        missing.push({ source: "xui", nodeId: sample.nodeId, email: normalizeEmail(sample.email), uuid: normalizeUuid(sample.uuid), checkpointId: sample.checkpointId });
      }
    }

    const aligned = [...xuiCheckpoints.values()]
      .filter((sample) => directCheckpoints.has(sample.checkpointId))
      .map((xuiSample) => ({ xui: xuiSample, direct: directCheckpoints.get(xuiSample.checkpointId)! }))
      .sort((left, right) => Date.parse(left.xui.sampledAt) - Date.parse(right.xui.sampledAt));
    checkpoints += aligned.length;
    if (aligned.length === 0) continue;

    let previousXui = aligned[0]!.xui;
    let previousDirect = aligned[0]!.direct;
    if (previousXui.counterGeneration !== previousDirect.counterGeneration) {
      throw new Error(`检查点 counterGeneration 不一致：${previousXui.nodeId}/${previousXui.email}/${previousXui.checkpointId}`);
    }
    const identitySample = previousXui;
    let generation = previousDirect.counterGeneration;
    let awaitingWarmup = true;
    let steadyWindows = 0;
    let activeBoundary: ShadowRebaselineBoundary = {
      nodeId: previousXui.nodeId,
      email: normalizeEmail(previousXui.email),
      uuid: normalizeUuid(previousXui.uuid),
      counterGeneration: generation,
      reason: "initial",
      detectedAt: previousXui.sampledAt,
      status: "awaiting_warmup"
    };
    boundaries.push(activeBoundary);

    for (const pair of aligned.slice(1)) {
      if (pair.xui.counterGeneration !== pair.direct.counterGeneration) {
        throw new Error(`检查点 counterGeneration 不一致：${pair.xui.nodeId}/${pair.xui.email}/${pair.xui.checkpointId}`);
      }
      if (Date.parse(pair.xui.sampledAt) <= Date.parse(previousXui.sampledAt)
        || Date.parse(pair.direct.sampledAt) <= Date.parse(previousDirect.sampledAt)) {
        throw new Error(`检查点时间未严格递增：${pair.xui.nodeId}/${pair.xui.email}/${pair.xui.checkpointId}`);
      }
      if (pair.direct.counterGeneration !== generation) {
        generation = pair.direct.counterGeneration;
        previousXui = pair.xui;
        previousDirect = pair.direct;
        awaitingWarmup = true;
        steadyWindows = 0;
        activeBoundary = {
          nodeId: pair.xui.nodeId,
          email: normalizeEmail(pair.xui.email),
          uuid: normalizeUuid(pair.xui.uuid),
          counterGeneration: generation,
          reason: "counter_generation_changed",
          detectedAt: pair.xui.sampledAt,
          status: "awaiting_warmup"
        };
        boundaries.push(activeBoundary);
        continue;
      }

      const xuiBytes = counterDelta(pair.xui, previousXui, "xui");
      const directBytes = counterDelta(pair.direct, previousDirect, "direct");
      const difference = xuiBytes >= directBytes ? xuiBytes - directBytes : directBytes - xuiBytes;
      if (awaitingWarmup) {
        activeBoundary.status = "stabilized";
        activeBoundary.stabilizedAt = pair.xui.sampledAt;
        activeBoundary.classification = directBytes > xuiBytes ? "XUI_FIRST_OBSERVATION_GAP" : "REBASELINE_WARMUP";
        activeBoundary.xuiWarmupBytes = xuiBytes.toString();
        activeBoundary.directWarmupBytes = directBytes.toString();
        activeBoundary.gapBytes = difference.toString();
        awaitingWarmup = false;
      } else {
        const allowed = allowedDifference(xuiBytes, thresholds);
        differences.push({
          nodeId: pair.xui.nodeId,
          email: normalizeEmail(pair.xui.email),
          uuid: normalizeUuid(pair.xui.uuid),
          counterGeneration: generation,
          windowStartedAt: previousXui.sampledAt,
          windowEndedAt: pair.xui.sampledAt,
          xuiBytes: xuiBytes.toString(),
          directBytes: directBytes.toString(),
          differenceBytes: difference.toString(),
          differencePercent: percentDifference(difference, xuiBytes),
          allowedDifferenceBytes: allowed.toString(),
          withinThreshold: difference <= allowed
        });
        steadyWindows += 1;
      }
      previousXui = pair.xui;
      previousDirect = pair.direct;
    }

    if (steadyWindows < minimumSteadyWindows) {
      insufficientSteady.push({
        nodeId: identitySample.nodeId,
        email: normalizeEmail(identitySample.email),
        uuid: normalizeUuid(identitySample.uuid),
        steadyWindows,
        requiredWindows: minimumSteadyWindows
      });
    }
  }

  for (const [key, directCheckpoints] of direct) {
    if (!xui.has(key)) {
      const first = directCheckpoints.values().next().value as ShadowCounterSample;
      missing.push({ source: "xui", nodeId: first.nodeId, email: normalizeEmail(first.email), uuid: normalizeUuid(first.uuid) });
    }
  }

  differences.sort((a, b) => [a.nodeId, a.email, a.uuid, a.windowStartedAt].join("|").localeCompare([b.nodeId, b.email, b.uuid, b.windowStartedAt].join("|")));
  boundaries.sort((a, b) => [a.nodeId, a.email, a.uuid, a.detectedAt].join("|").localeCompare([b.nodeId, b.email, b.uuid, b.detectedAt].join("|")));
  missing.sort((a, b) => [a.nodeId, a.email, a.uuid, a.checkpointId ?? "", a.source].join("|").localeCompare([b.nodeId, b.email, b.uuid, b.checkpointId ?? "", b.source].join("|")));
  const unresolvedBoundaries = boundaries.filter((item) => item.status === "awaiting_warmup").length;
  const overThresholdWindows = differences.filter((item) => !item.withinThreshold).length;
  const missingUsers = missing.filter((item) => !item.checkpointId).length;
  const missingCheckpoints = missing.length - missingUsers;
  const identities = new Set([...xui.keys(), ...direct.keys()]).size;

  return {
    generatedAt,
    readyForDirect: identities > 0 && missing.length === 0 && unresolvedBoundaries === 0 && insufficientSteady.length === 0 && overThresholdWindows === 0,
    thresholds: { ...thresholds, minimumSteadyWindows },
    counts: {
      identities,
      checkpoints,
      steadyWindows: differences.length,
      rebaselineBoundaries: boundaries.length,
      unresolvedBoundaries,
      missingUsers,
      missingCheckpoints,
      insufficientSteadyUsers: insufficientSteady.length,
      overThresholdWindows
    },
    differences,
    boundaries,
    insufficientSteady,
    missing
  };
}
