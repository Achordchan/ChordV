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

/**
 * A newer command supersedes a retry-exhausted (cancelled) failure ONLY when
 * it actually replaces that operation:
 * - binding-scoped commands resolve exhausted rows of the SAME commandType on
 *   that binding — a REFRESH_QUOTA updates quota but never installs the user,
 *   so it must not clear a failed ENSURE_USER. REMOVE_USER is the exception:
 *   teardown of the binding makes every earlier provisioning failure moot.
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
      ...(scope.commandType === "REMOVE_USER"
        ? { bindingId: scope.bindingId }
        : { bindingId: scope.bindingId, commandType: scope.commandType })
    };
  } else if (scope.nodeId && scope.commandType) {
    where = { nodeId: scope.nodeId, commandType: scope.commandType, status: "cancelled" as const, resolvedAt: null };
  }
  if (!where) {
    return;
  }
  await writer.nodeCommandJob.updateMany({ where, data: { resolvedAt: new Date() } });
}
