type CreateOrRefreshJobInput = {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

export async function createOrRefreshPanelSyncJob(writer: any, dedupeKey: string, input: CreateOrRefreshJobInput) {
  await createOrRefreshQueuedJob(writer.panelSyncJob, dedupeKey, input);
}

export async function createOrRefreshLeaseRevocationJob(writer: any, dedupeKey: string, input: CreateOrRefreshJobInput) {
  await createOrRefreshQueuedJob(writer.leaseRevocationJob, dedupeKey, input);
}

async function createOrRefreshQueuedJob(model: any, dedupeKey: string, input: CreateOrRefreshJobInput) {
  if (typeof model.updateMany === "function" && typeof model.createMany === "function") {
    const updated = await model.updateMany({
      where: {
        dedupeKey,
        status: { not: "running" }
      },
      data: input.update
    });
    if ((updated?.count ?? 0) > 0) {
      return;
    }
    await model.createMany({
      data: input.create,
      skipDuplicates: true
    });
    return;
  }

  if (typeof model.create !== "function" || typeof model.updateMany !== "function") {
    await model.upsert({
      where: { dedupeKey },
      create: input.create,
      update: input.update
    });
    return;
  }

  try {
    await model.create({ data: input.create });
    return;
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
  }

  await model.updateMany({
    where: {
      dedupeKey,
      status: { not: "running" }
    },
    data: input.update
  });
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}
