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
 * A newer command for the same target supersedes a retry-exhausted (cancelled)
 * failure: the new row tells the story from now on, so the exhausted row must
 * stop counting as unresolved in the admin queue. Binding-scoped commands are
 * resolved by ANY newer command on the binding (its state was re-managed);
 * target-less commands (ENSURE_INBOUND, RECONCILE_USERS) resolve per
 * node+commandType.
 */
export async function resolveExhaustedCommands(
  writer: any,
  scope: { bindingId?: string | null; nodeId?: string | null; commandType?: string | null }
) {
  const where = scope.bindingId
    ? { bindingId: scope.bindingId, status: "cancelled" as const, resolvedAt: null }
    : scope.nodeId && scope.commandType
      ? { nodeId: scope.nodeId, commandType: scope.commandType, status: "cancelled" as const, resolvedAt: null }
      : null;
  if (!where) {
    return;
  }
  await writer.nodeCommandJob.updateMany({ where, data: { resolvedAt: new Date() } });
}
