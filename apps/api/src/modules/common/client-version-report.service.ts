import { Injectable, Logger } from "@nestjs/common";
import type { ClientUpdateCheckDto, PlatformTarget, ReleaseChannel } from "@chordv/shared";
import { workLifecycle } from "../../work-lifecycle";
import { AuthSessionService } from "./auth-session.service";
import { PrismaService } from "./prisma.service";

/** 版本、构建号、通道都没变时，最近活跃时间最多每 10 分钟写一次，避免检查更新放大写入。 */
export const CLIENT_VERSION_SEEN_REFRESH_MS = 10 * 60_000;

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
  if (existing.version !== next.version || (existing.build ?? null) !== next.build || existing.channel !== next.channel) return true;
  return now.getTime() - existing.lastSeenAt.getTime() >= CLIENT_VERSION_SEEN_REFRESH_MS;
}

function readClientBuild(value: unknown) {
  const parsed = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 1 && parsed <= CLIENT_BUILD_MAX ? parsed : null;
}

@Injectable()
export class ClientVersionReportService {
  private readonly logger = new Logger(ClientVersionReportService.name);

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
    void workLifecycle.track(this.record(authorization, report));
  }

  /** 返回是否实际写库；凭证无效、版本未变且未到刷新间隔、或数据库异常时返回 false，不抛错。 */
  async record(authorization: string, report: ClientVersionReport, now = new Date()): Promise<boolean> {
    let userId: string;
    try {
      userId = (await this.authSessionService.authenticateAccessToken(authorization)).id;
    } catch {
      return false;
    }
    try {
      const where = { userId_platform: { userId, platform: report.platform } };
      const existing = await this.prisma.userClientVersion.findUnique({
        where,
        select: { version: true, build: true, channel: true, lastSeenAt: true }
      });
      if (!shouldRecordClientVersion(existing, report, now)) return false;
      const data = { version: report.version, build: report.build, channel: report.channel, lastSeenAt: now };
      await this.prisma.userClientVersion.upsert({
        where,
        create: { userId, platform: report.platform, ...data },
        update: data
      });
      return true;
    } catch (error) {
      this.logger.warn(`客户端版本记录失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
