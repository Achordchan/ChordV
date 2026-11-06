type CreateOrRefreshNodeCommandInput = {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

export async function createOrRefreshNodeCommandJob(
  writer: any,
  dedupeKey: string,
  input: CreateOrRefreshNodeCommandInput
) {
  await resolveExhaustedCommands(writer, {
    bindingId: Reflect.get(input.create, "bindingId") as string | null | undefined,
    nodeId: Reflect.get(input.create, "nodeId") as string,
    commandType: Reflect.get(input.create, "commandType") as string
  });
  return writer.nodeCommandJob.upsert({
    where: { dedupeKey },
    create: input.create,
    update: input.update
  });
}

// Binding commands that make an earlier exhausted failure of another type
// moot. Taking the user OUT of service (disable, remove) means a failed
// install/enable/quota update no longer has anything to deliver; the next
// re-enable orders a fresh ENSURE_USER anyway. The reverse does not hold, and
// a REFRESH_QUOTA never installs a user, so it resolves only its own type.
// The agent-events exhaust sweep uses the SAME table, so enqueue-time and
// sweep-time resolution never disagree on what "superseded" means.
const MOOTED_BY: Record<string, readonly string[]> = {
  DISABLE_USER: ["ENSURE_USER", "ENABLE_USER", "REFRESH_QUOTA"]
};

/** Command types whose exhausted failures `commandType` resolves on the same binding (null = all). */
export function bindingCommandTypesResolvedBy(commandType: string): string[] | null {
  if (commandType === "REMOVE_USER") return null;
  return [commandType, ...(MOOTED_BY[commandType] ?? [])];
}

/** Newer binding command types that supersede an exhausted `commandType` row. */
export function bindingCommandTypesSuperseding(commandType: string): string[] {
  return [
    commandType,
    "REMOVE_USER",
    ...Object.entries(MOOTED_BY).filter(([, mooted]) => mooted.includes(commandType)).map(([type]) => type)
  ];
}

/**
 * A newer command supersedes a retry-exhausted (cancelled) failure ONLY when
 * it actually replaces that operation:
 * - binding-scoped commands resolve exhausted rows of the SAME commandType on
 *   that binding — a REFRESH_QUOTA updates quota but never installs the user,
 *   so it must not clear a failed ENSURE_USER. REMOVE_USER resolves every
 *   earlier failure (teardown makes provisioning moot) and DISABLE_USER
 *   resolves failed ENSURE/ENABLE/REFRESH_QUOTA (see MOOTED_BY).
 * - target-less commands (ENSURE_INBOUND, RECONCILE_USERS, ...) resolve per
 *   node+commandType.
 * Callers must only invoke this when a genuinely NEW command is being created
 * (see the replay guards at the enqueue sites).
 */
export async function resolveExhaustedCommands(
  writer: any,
  scope: { bindingId?: string | null; nodeId?: string | null; commandType?: string | null }
) {
  let where: Record<string, unknown> | null = null;
  if (scope.bindingId && scope.commandType) {
    where = {
      status: "cancelled" as const,
      resolvedAt: null,
      ...(() => {
        const types = bindingCommandTypesResolvedBy(scope.commandType);
        if (types === null) return { bindingId: scope.bindingId };
        return { bindingId: scope.bindingId, commandType: types.length === 1 ? types[0] : { in: types } };
      })()
    };
  } else if (scope.nodeId && scope.commandType) {
    where = { nodeId: scope.nodeId, commandType: scope.commandType, status: "cancelled" as const, resolvedAt: null };
  }
  if (!where) {
    return;
  }
  await writer.nodeCommandJob.updateMany({ where, data: { resolvedAt: new Date() } });
}
