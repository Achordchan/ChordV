import type {
  BindingRecord,
  ReconciliationInput,
  ReconciliationIssue,
  ReconciliationReport,
  RemoteUserRecord
} from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeUuid(value: string) {
  return value.trim().toLowerCase();
}

function identityKey(record: Pick<BindingRecord, "nodeId" | "email">) {
  return `${record.nodeId.trim()}\u0000${normalizeEmail(record.email)}`;
}

function expectedEnabled(binding: BindingRecord) {
  return binding.status !== "disabled" && binding.status !== "deleted";
}

function inspectSourceDuplicates(
  source: "binding" | "xui" | "xray",
  records: Array<BindingRecord | RemoteUserRecord>,
  issues: ReconciliationIssue[]
) {
  const emails = new Map<string, number>();
  const uuids = new Map<string, number>();
  for (const record of records) {
    const nodeId = record.nodeId.trim();
    const email = normalizeEmail(record.email);
    const uuid = normalizeUuid(record.uuid);
    if (!nodeId || !email || !UUID_PATTERN.test(uuid)) {
      issues.push({
        code: "INVALID_IDENTITY",
        source,
        nodeId,
        email,
        uuid,
        detail: "nodeId、email 或 UUID 无效"
      });
      continue;
    }
    const emailKey = `${nodeId}\u0000${email}`;
    const uuidKey = `${nodeId}\u0000${uuid}`;
    emails.set(emailKey, (emails.get(emailKey) ?? 0) + 1);
    uuids.set(uuidKey, (uuids.get(uuidKey) ?? 0) + 1);
  }

  for (const [key, count] of emails) {
    if (count < 2) continue;
    const [nodeId, email] = key.split("\u0000");
    issues.push({ code: "DUPLICATE_EMAIL", source, nodeId, email, detail: `同一节点出现 ${count} 条相同 email` });
  }
  for (const [key, count] of uuids) {
    if (count < 2) continue;
    const [nodeId, uuid] = key.split("\u0000");
    issues.push({ code: "DUPLICATE_UUID", source, nodeId, uuid, detail: `同一节点出现 ${count} 条相同 UUID` });
  }
}

function uniqueByEmail<T extends BindingRecord | RemoteUserRecord>(records: T[]) {
  const result = new Map<string, T>();
  for (const record of records) {
    const key = identityKey(record);
    if (!result.has(key)) result.set(key, record);
  }
  return result;
}

export function reconcileNodeUsers(input: ReconciliationInput, generatedAt = new Date().toISOString()): ReconciliationReport {
  const issues: ReconciliationIssue[] = [];
  inspectSourceDuplicates("binding", input.bindings, issues);
  inspectSourceDuplicates("xui", input.xuiUsers, issues);
  inspectSourceDuplicates("xray", input.xrayUsers, issues);

  const bindings = uniqueByEmail(input.bindings);
  const xui = uniqueByEmail(input.xuiUsers);
  const xray = uniqueByEmail(input.xrayUsers);

  for (const [key, binding] of bindings) {
    const email = normalizeEmail(binding.email);
    const uuid = normalizeUuid(binding.uuid);
    const xuiUser = xui.get(key);
    const xrayUser = xray.get(key);

    for (const [source, user, missingCode] of [
      ["xui", xuiUser, "MISSING_IN_XUI"],
      ["xray", xrayUser, "MISSING_IN_XRAY"]
    ] as const) {
      if (!user) {
        issues.push({
          code: missingCode,
          source: "cross-source",
          nodeId: binding.nodeId,
          email,
          uuid,
          detail: `ChordV binding 在 ${source} 中不存在`
        });
        continue;
      }
      if (normalizeUuid(user.uuid) !== uuid) {
        issues.push({
          code: "UUID_MISMATCH",
          source: "cross-source",
          nodeId: binding.nodeId,
          email,
          uuid,
          detail: `${source} UUID 为 ${normalizeUuid(user.uuid)}`
        });
      }
      if (user.enabled !== expectedEnabled(binding)) {
        issues.push({
          code: "ENABLED_STATE_MISMATCH",
          source: "cross-source",
          nodeId: binding.nodeId,
          email,
          uuid,
          detail: `${source} enabled=${user.enabled}，binding status=${binding.status ?? "active"}`
        });
      }
    }
  }

  for (const [source, users, unknownCode] of [
    ["xui", xui, "UNKNOWN_IN_XUI"],
    ["xray", xray, "UNKNOWN_IN_XRAY"]
  ] as const) {
    for (const [key, user] of users) {
      if (bindings.has(key)) continue;
      const uuidBinding = input.bindings.find(
        (binding) => binding.nodeId.trim() === user.nodeId.trim() && normalizeUuid(binding.uuid) === normalizeUuid(user.uuid)
      );
      issues.push({
        code: uuidBinding ? "EMAIL_MISMATCH" : unknownCode,
        source: "cross-source",
        nodeId: user.nodeId,
        email: normalizeEmail(user.email),
        uuid: normalizeUuid(user.uuid),
        detail: uuidBinding
          ? `${source} email 与相同 UUID 的 binding 不一致（binding=${normalizeEmail(uuidBinding.email)}）`
          : `${source} 用户没有对应的 ChordV binding`
      });
    }
  }

  issues.sort((a, b) =>
    [a.nodeId, a.email ?? "", a.uuid ?? "", a.code, a.source].join("|").localeCompare(
      [b.nodeId, b.email ?? "", b.uuid ?? "", b.code, b.source].join("|")
    )
  );

  return {
    generatedAt,
    readyForShadow: issues.length === 0,
    counts: {
      bindings: input.bindings.length,
      xuiUsers: input.xuiUsers.length,
      xrayUsers: input.xrayUsers.length,
      issues: issues.length
    },
    issues
  };
}
