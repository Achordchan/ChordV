import type { PrismaClient } from "@prisma/client";

/**
 * 订阅链接（第三方客户端）的在线状态。
 *
 * 小火箭、v2rayN 这类客户端不会向后台发心跳，后台原本只能显示“暂无在线记录”。节点上的 Xray 自己知道
 * 哪个账号有活动连接（statsUserOnline），Agent 每次心跳（约 15 秒）把本节点在线的账号按绑定报上来，
 * 记在 PanelClientBinding 上：
 * - directLastOnlineAt：最近一次报告在线的时间；
 * - directOnlineSince：本次在线的开始时间，距上次在线超过判定窗口才重置；
 * - directOnlineIpCount：在线来源 IP 数，报告不在线时置 0。
 *
 * 心跳缺少该字段（旧版 Agent、读取失败、尚未绑定入站）时什么也不改，不会把所有人误判为离线；
 * Agent 停止心跳后，最近在线时间不再前进，超过判定窗口自然算离线。
 */
export const DIRECT_ONLINE_WINDOW_SECONDS = 90;

export type DirectOnlineReport = { bindingId: string; ipCount: number };

export function directOnlineCutoff(now: Date) {
  return new Date(now.getTime() - DIRECT_ONLINE_WINDOW_SECONDS * 1000);
}

/** 同一绑定重复出现时取较大的 IP 数；非法条目丢弃。 */
export function normalizeDirectOnline(reports: DirectOnlineReport[]) {
  const counts = new Map<string, number>();
  for (const report of reports) {
    if (!report.bindingId || !Number.isInteger(report.ipCount) || report.ipCount < 1) continue;
    counts.set(report.bindingId, Math.max(counts.get(report.bindingId) ?? 0, report.ipCount));
  }
  return counts;
}

export type DirectOnlineObservation = {
  /** 心跳所属的 NodeAgent 行 id。 */
  agentRowId: string;
  nodeId: string;
  /** Agent 给这次报告的递增序号。 */
  sequence: number;
  reports: DirectOnlineReport[];
};

type PresenceDatabase = Pick<PrismaClient, "$transaction">;

/**
 * 按一次心跳的在线报告更新本节点的绑定。只写属于该节点的绑定。
 *
 * 心跳可能重叠或迟到（Agent 超时重发、请求在服务端排队），所以报告按 Agent 的序号采纳：先在同一事务里把
 * NodeAgent.onlineReportSequence 条件推进到本次序号，推进不了（已有更新的报告）就整份丢弃。这条条件
 * UPDATE 持有该 Agent 行的锁直到提交，跨进程也串行；并发的另一份报告等锁后重新判断条件，旧的自然落空。
 * 写入时间取拿到锁之后的时钟，最近在线时间不会倒退。
 *
 * 返回 null 表示这份报告比已采纳的旧，未写入。
 */
export async function recordDirectOnline(
  prisma: PresenceDatabase,
  observation: DirectOnlineObservation,
  clock: () => Date = () => new Date()
) {
  const counts = normalizeDirectOnline(observation.reports);
  const ids = [...counts.keys()];
  const { agentRowId, nodeId } = observation;
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.nodeAgent.updateMany({
      where: { id: agentRowId, nodeId, onlineReportSequence: { lt: BigInt(observation.sequence) } },
      data: { onlineReportSequence: BigInt(observation.sequence) }
    });
    if (claimed.count === 0) return null;
    const now = clock();
    if (ids.length) {
      // 先重置本次在线的开始时间（从未在线、或距上次在线已超过窗口），再推进最近在线时间。
      await tx.panelClientBinding.updateMany({
        where: {
          nodeId,
          id: { in: ids },
          OR: [{ directOnlineSince: null }, { directLastOnlineAt: null }, { directLastOnlineAt: { lt: directOnlineCutoff(now) } }]
        },
        data: { directOnlineSince: now }
      });
      const byCount = new Map<number, string[]>();
      for (const [id, count] of counts) {
        const group = byCount.get(count);
        if (group) group.push(id);
        else byCount.set(count, [id]);
      }
      for (const [count, group] of byCount) {
        await tx.panelClientBinding.updateMany({
          where: { nodeId, id: { in: group } },
          data: { directLastOnlineAt: now, directOnlineIpCount: count }
        });
      }
    }
    await tx.panelClientBinding.updateMany({
      where: { nodeId, directOnlineIpCount: { gt: 0 }, ...(ids.length ? { id: { notIn: ids } } : {}) },
      data: { directOnlineIpCount: 0 }
    });
    return ids.length;
  });
}
