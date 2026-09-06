type CreateOrRefreshNodeCommandInput = {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

export async function createOrRefreshNodeCommandJob(
  writer: any,
  dedupeKey: string,
  input: CreateOrRefreshNodeCommandInput
) {
  return writer.nodeCommandJob.upsert({
    where: { dedupeKey },
    create: input.create,
    update: input.update
  });
}
