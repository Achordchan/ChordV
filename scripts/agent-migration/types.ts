export type DecimalBytes = string;

export type BindingRecord = {
  nodeId: string;
  email: string;
  uuid: string;
  status?: "active" | "disabled" | "deleted" | string;
};

export type RemoteUserRecord = {
  nodeId: string;
  email: string;
  uuid: string;
  enabled: boolean;
  inboundId?: number;
};

export type ReconciliationInput = {
  bindings: BindingRecord[];
  xuiUsers: RemoteUserRecord[];
  xrayUsers: RemoteUserRecord[];
};

export type ReconciliationIssueCode =
  | "INVALID_IDENTITY"
  | "DUPLICATE_EMAIL"
  | "DUPLICATE_UUID"
  | "MISSING_IN_XUI"
  | "MISSING_IN_XRAY"
  | "UNKNOWN_IN_XUI"
  | "UNKNOWN_IN_XRAY"
  | "UUID_MISMATCH"
  | "EMAIL_MISMATCH"
  | "ENABLED_STATE_MISMATCH";

export type ReconciliationIssue = {
  code: ReconciliationIssueCode;
  source: "binding" | "xui" | "xray" | "cross-source";
  nodeId: string;
  email?: string;
  uuid?: string;
  detail: string;
};

export type ReconciliationReport = {
  generatedAt: string;
  readyForShadow: boolean;
  counts: {
    bindings: number;
    xuiUsers: number;
    xrayUsers: number;
    issues: number;
  };
  issues: ReconciliationIssue[];
};

export type ShadowUsageDelta = {
  nodeId: string;
  email: string;
  uuid: string;
  uplinkBytes: DecimalBytes;
  downlinkBytes: DecimalBytes;
  windowStartedAt: string;
  windowEndedAt: string;
};

export type ShadowThresholds = {
  absoluteBytes: DecimalBytes;
  relativePercent: number;
};

export type ShadowDifference = {
  nodeId: string;
  email: string;
  uuid: string;
  xuiBytes: DecimalBytes;
  directBytes: DecimalBytes;
  differenceBytes: DecimalBytes;
  differencePercent: number;
  allowedDifferenceBytes: DecimalBytes;
  withinThreshold: boolean;
};

export type ShadowComparisonReport = {
  generatedAt: string;
  readyForDirect: boolean;
  thresholds: ShadowThresholds;
  counts: {
    xuiUsers: number;
    directUsers: number;
    comparedUsers: number;
    missingUsers: number;
    overThresholdUsers: number;
  };
  differences: ShadowDifference[];
  missing: Array<{
    source: "xui" | "direct";
    nodeId: string;
    email: string;
    uuid: string;
  }>;
};

export type ShadowCounterSample = {
  nodeId: string;
  email: string;
  uuid: string;
  checkpointId: string;
  counterGeneration: string;
  uplinkBytes: DecimalBytes;
  downlinkBytes: DecimalBytes;
  sampledAt: string;
};

export type ShadowRebaselineBoundary = {
  nodeId: string;
  email: string;
  uuid: string;
  counterGeneration: string;
  reason: "initial" | "counter_generation_changed";
  detectedAt: string;
  stabilizedAt?: string;
  status: "awaiting_warmup" | "stabilized";
  classification?: "XUI_FIRST_OBSERVATION_GAP" | "REBASELINE_WARMUP";
  xuiWarmupBytes?: DecimalBytes;
  directWarmupBytes?: DecimalBytes;
  gapBytes?: DecimalBytes;
};

export type ShadowSteadyDifference = ShadowDifference & {
  counterGeneration: string;
  windowStartedAt: string;
  windowEndedAt: string;
};

export type RestartAwareShadowReport = {
  generatedAt: string;
  readyForDirect: boolean;
  thresholds: ShadowThresholds & { minimumSteadyWindows: number };
  counts: {
    identities: number;
    checkpoints: number;
    steadyWindows: number;
    rebaselineBoundaries: number;
    unresolvedBoundaries: number;
    missingUsers: number;
    missingCheckpoints: number;
    insufficientSteadyUsers: number;
    overThresholdWindows: number;
  };
  differences: ShadowSteadyDifference[];
  boundaries: ShadowRebaselineBoundary[];
  insufficientSteady: Array<{
    nodeId: string;
    email: string;
    uuid: string;
    steadyWindows: number;
    requiredWindows: number;
  }>;
  missing: Array<{
    source: "xui" | "direct";
    nodeId: string;
    email: string;
    uuid: string;
    checkpointId?: string;
  }>;
};

export type UsageBatchFixture = {
  nodeId: string;
  bootId: string;
  sequence: number;
  payloadHash: string;
  sampledAt: string;
  entries: Array<{
    email: string;
    uuid: string;
    counterGeneration: number;
    uplinkBytes: DecimalBytes;
    downlinkBytes: DecimalBytes;
  }>;
};
