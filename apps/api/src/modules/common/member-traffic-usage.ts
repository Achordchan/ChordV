import type { PrismaService } from "./prisma.service";

export async function readMemberUsedTrafficGb(
  prisma: Pick<PrismaService, "trafficLedger">,
  teamId: string,
  userId: string,
  subscriptionId: string
) {
  const aggregate = await prisma.trafficLedger.aggregate({
    where: { teamId, userId, subscriptionId },
    _sum: { usedTrafficGb: true }
  });
  return aggregate._sum.usedTrafficGb ?? 0;
}
