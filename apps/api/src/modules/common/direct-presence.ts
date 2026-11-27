import type { Prisma, PrismaClient } from "@prisma/client";

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

type BindingWriter = Pick<PrismaClient, "panelClientBinding"> | Prisma.TransactionClient;

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

/** 按一次心跳的在线报告更新本节点的绑定。只写属于该节点的绑定。 */
export async function recordDirectOnline(prisma: BindingWriter, nodeId: string, reports: DirectOnlineReport[], now: Date) {
  const counts = normalizeDirectOnline(reports);
  const ids = [...counts.keys()];
  if (ids.length) {
    // 先重置本次在线的开始时间（从未在线、或距上次在线已超过窗口），再推进最近在线时间。
    await prisma.panelClientBinding.updateMany({
      where: {
        nodeId,
        id: { in: ids },
        OR: [{ directOnlineSince: null }, { directLastOnlineAt: null }, { directLastOnlineAt: { lt: directOnlineCutoff(now) } }]
      },
      data: { directOnlineSince: now }
    });
    const byCount = new Map<number, string[]>();
    for (const [id, count] of counts) byCount.set(count, [...(byCount.get(count) ?? []), id]);
    for (const [count, group] of byCount) {
      await prisma.panelClientBinding.updateMany({
        where: { nodeId, id: { in: group } },
        data: { directLastOnlineAt: now, directOnlineIpCount: count }
      });
    }
  }
  await prisma.panelClientBinding.updateMany({
    where: { nodeId, directOnlineIpCount: { gt: 0 }, ...(ids.length ? { id: { notIn: ids } } : {}) },
    data: { directOnlineIpCount: 0 }
  });
  return ids.length;
}
