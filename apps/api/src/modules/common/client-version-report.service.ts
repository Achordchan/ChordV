import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { ClientUpdateCheckDto, PlatformTarget, ReleaseChannel } from "@chordv/shared";
import { workLifecycle } from "../../work-lifecycle";
import { AuthSessionService } from "./auth-session.service";
import { isPrismaCodedError } from "./prisma-error.utils";
import { PrismaService } from "./prisma.service";

/** 版本、构建号、通道都没变时，最近活跃时间最多每 10 分钟写一次，避免检查更新放大写入。 */
export const CLIENT_VERSION_SEEN_REFRESH_MS = 10 * 60_000;

/** 进程内顺序水位最多保留的用户平台数，超出后淘汰最久未上报的。 */
const CLIENT_VERSION_WATERMARK_LIMIT = 10_000;

const CLIENT_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;
const CLIENT_BUILD_MAX = 999_999_999;
const CLIENT_PLATFORMS: ReadonlySet<string> = new Set<PlatformTarget>(["macos", "windows", "android", "ios"]);
const CLIENT_CHANNELS: ReadonlySet<string> = new Set<ReleaseChannel>(["stable", "beta"]);

export type ClientVersionReport = {
  platform: PlatformTarget;
  version: string;
  build: number | null;
  channel: ReleaseChannel;
};

type StoredClientVersion = {
  version: string;
  build: number | null;
  channel: ReleaseChannel;
  lastSeenAt: Date;
};

/** 只接受形如 1.1.10 的版本号与已知平台；其余输入一律不记录，避免把任意字符串写进后台。 */
export function normalizeClientVersionReport(input: Partial<ClientUpdateCheckDto> | null | undefined): ClientVersionReport | null {
  if (!input || typeof input.currentVersion !== "string") return null;
  const [rawVersion, ...metadata] = input.currentVersion.trim().replace(/^v/i, "").split("+");
  if (!CLIENT_VERSION_PATTERN.test(rawVersion) || metadata.length > 1) return null;
  if (typeof input.platform !== "string" || !CLIENT_PLATFORMS.has(input.platform)) return null;
  const channel = typeof input.channel === "string" && CLIENT_CHANNELS.has(input.channel) ? input.channel : "stable";
  const build = readClientBuild(input.currentBuild) ?? readClientBuild(metadata[0]);
  return { platform: input.platform, version: rawVersion, build, channel };
}

export function shouldRecordClientVersion(existing: StoredClientVersion | null, next: ClientVersionReport, now: Date) {
  if (!existing) return true;
  // 晚到的旧上报（比已记录的更早发生）一律不覆盖。
  if (existing.lastSeenAt.getTime() >= now.getTime()) return false;
  if (existing.version !== next.version || (existing.build ?? null) !== next.build || existing.channel !== next.channel) return true;
  return now.getTime() - existing.lastSeenAt.getTime() >= CLIENT_VERSION_SEEN_REFRESH_MS;
}

/**
 * 与 shouldRecordClientVersion 同一规则的数据库条件：只有比已记录的更新，且（内容有变化或已到刷新间隔）才写。
 * 条件随更新语句一起执行，并发上报时由数据库保证不会被更早的上报覆盖。
 */
export function buildClientVersionWriteCondition(userId: string, report: ClientVersionReport, now: Date): Prisma.UserClientVersionWhereInput {
  const buildChanged: Prisma.UserClientVersionWhereInput[] = report.build === null
    ? [{ build: { not: null } }]
    : [{ build: null }, { build: { not: report.build } }];
  return {
    userId,
    platform: report.platform,
    lastSeenAt: { lt: now },
    OR: [
      { version: { not: report.version } },
      { channel: { not: report.channel } },
      ...buildChanged,
      { lastSeenAt: { lte: new Date(now.getTime() - CLIENT_VERSION_SEEN_REFRESH_MS) } }
    ]
  };
}

function readClientBuild(value: unknown) {
  const parsed = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 1 && parsed <= CLIENT_BUILD_MAX ? parsed : null;
}

@Injectable()
export class ClientVersionReportService {
  private readonly logger = new Logger(ClientVersionReportService.name);
  /**
   * 每个用户平台已见过的最新上报时间。节流跳过写库时库里的 lastSeenAt 不会前进，
   * 这里单独记住顺序，让在那之前发生、但更晚才处理完的上报不会把新版本改回旧版本。
   * 后台 API 为单实例部署；重启后水位清空，此时仍由数据库条件兜底（只接受比已记录更新的上报）。
   */
  private readonly reportWatermarks = new Map<string, number>();
  /** 同一用户平台的上报在进程内逐个处理，水位判断、读库和写库之间不会被另一条上报插队。 */
  private readonly reportQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService
  ) {}

  /**
   * 检查更新是公开接口；已登录客户端会带上登录凭证，这里顺带记下它的版本。
   * 记录在后台完成，失败或未登录都不影响检查更新本身的结果与耗时。
   */
  recordInBackground(authorization: string | undefined, input: ClientUpdateCheckDto) {
    if (!authorization?.trim() || workLifecycle.isDraining) return;
    const report = normalizeClientVersionReport(input);
    if (!report) return;
    // 以收到请求的时刻为准，而不是后台写完的时刻，这样慢的旧请求不会被当成更新的上报。
    void workLifecycle.track(this.record(authorization, report, new Date()));
  }

  /** 返回是否实际写库；凭证无效、版本未变且未到刷新间隔、上报比已记录的更早、或数据库异常时返回 false，不抛错。 */
  async record(authorization: string, report: ClientVersionReport, now = new Date()): Promise<boolean> {
    let userId: string;
    try {
      userId = (await this.authSessionService.authenticateAccessToken(authorization)).id;
    } catch {
      return false;
    }
    const key = `${userId}:${report.platform}`;
    return this.runExclusive(key, async () => {
      if (!this.claimReportOrder(key, now)) return false;
      try {
        return await this.writeReport(userId, report, now);
      } catch (error) {
        this.logger.warn(`客户端版本记录失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    });
  }

  private async writeReport(userId: string, report: ClientVersionReport, now: Date) {
    const existing = await this.prisma.userClientVersion.findUnique({
      where: { userId_platform: { userId, platform: report.platform } },
      select: { version: true, build: true, channel: true, lastSeenAt: true }
    });
    if (!shouldRecordClientVersion(existing, report, now)) return false;
    const data = { version: report.version, build: report.build, channel: report.channel, lastSeenAt: now };
    if (!existing) {
      try {
        await this.prisma.userClientVersion.create({ data: { userId, platform: report.platform, ...data } });
        return true;
      } catch (error) {
        // 首次上报与另一实例或重启前的请求同时建行：另一条已先写入，改走下面的条件更新。
        if (!isPrismaCodedError(error) || error.code !== "P2002") throw error;
      }
    }
    const updated = await this.prisma.userClientVersion.updateMany({
      where: buildClientVersionWriteCondition(userId, report, now),
      data
    });
    return updated.count > 0;
  }

  private runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.reportQueues.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(() => undefined, () => undefined);
    this.reportQueues.set(key, tail);
    void tail.then(() => {
      if (this.reportQueues.get(key) === tail) this.reportQueues.delete(key);
    });
    return run;
  }

  /** 记下这次上报的时间；比已见过的更早则返回 false，调用方直接丢弃。 */
  private claimReportOrder(key: string, reportedAt: Date) {
    const time = reportedAt.getTime();
    const current = this.reportWatermarks.get(key);
    if (current !== undefined && current > time) return false;
    this.reportWatermarks.delete(key);
    this.reportWatermarks.set(key, time);
    if (this.reportWatermarks.size > CLIENT_VERSION_WATERMARK_LIMIT) {
      const oldest = this.reportWatermarks.keys().next().value;
      if (oldest !== undefined) this.reportWatermarks.delete(oldest);
    }
    return true;
  }
}
