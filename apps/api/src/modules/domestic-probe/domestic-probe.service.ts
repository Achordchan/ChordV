import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { AdminDomesticProbeStateDto, AdminDomesticProbeTokenDto } from "@chordv/shared";
import { PrismaService } from "../common/prisma.service";
import { readEffectiveControlStatus } from "../common/node-import.utils";
import {
  DOMESTIC_PROBE_INTERVAL_SECONDS,
  nextDomesticState,
  shouldIgnoreRound,
  type DomesticObservation
} from "./domestic-probe.policy";

/** SystemSetting row holding the probe token hash and the last round's outcome. The token itself is never stored. */
export const DOMESTIC_PROBE_SETTING_KEY = "domestic-probe";
const TOKEN_PREFIX = "cvdp_";

type StoredDomesticProbeConfig = {
  tokenHash: string | null;
  tokenPrefix: string | null;
  tokenCreatedAt: string | null;
  lastReportAt: string | null;
  lastRoundIgnored: boolean;
  lastRoundReason: string | null;
};

export type DomesticProbeReport = {
  controlOk: boolean;
  results: Array<DomesticObservation & { nodeId: string }>;
};

export function hashDomesticProbeToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseDomesticProbeConfig(value: unknown): StoredDomesticProbeConfig {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const text = (key: string) => (typeof record[key] === "string" && record[key] ? (record[key] as string) : null);
  return {
    tokenHash: text("tokenHash"),
    tokenPrefix: text("tokenPrefix"),
    tokenCreatedAt: text("tokenCreatedAt"),
    lastReportAt: text("lastReportAt"),
    lastRoundIgnored: record.lastRoundIgnored === true,
    lastRoundReason: text("lastRoundReason")
  };
}

function toStateDto(config: StoredDomesticProbeConfig): AdminDomesticProbeStateDto {
  return {
    configured: config.tokenHash !== null,
    tokenPrefix: config.tokenPrefix,
    tokenCreatedAt: config.tokenCreatedAt,
    lastReportAt: config.lastReportAt,
    lastRoundIgnored: config.lastRoundIgnored,
    lastRoundReason: config.lastRoundReason
  };
}

@Injectable()
export class DomesticProbeService {
  private readonly logger = new Logger(DomesticProbeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getState(): Promise<AdminDomesticProbeStateDto> {
    return toStateDto(await this.readConfig());
  }

  /** Issues a new token and invalidates the previous one. The plain token is returned only here. */
  async rotateToken(now = new Date()): Promise<AdminDomesticProbeTokenDto> {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const config = await this.writeConfig((current) => ({
      ...current,
      tokenHash: hashDomesticProbeToken(token),
      tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6),
      tokenCreatedAt: now.toISOString()
    }));
    return { ...toStateDto(config), token };
  }

  async revokeToken(): Promise<AdminDomesticProbeStateDto> {
    return toStateDto(await this.writeConfig((current) => ({ ...current, tokenHash: null, tokenPrefix: null, tokenCreatedAt: null })));
  }

  async authenticate(authorization: string | undefined): Promise<boolean> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (!match) return false;
    const config = await this.readConfig();
    if (!config.tokenHash) return false;
    const expected = Buffer.from(config.tokenHash, "hex");
    const actual = Buffer.from(hashDomesticProbeToken(match[1]), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Nodes the probe should check: active nodes with a registered agent (or legacy nodes without onboarding). */
  async listTargets() {
    const nodes = await this.prisma.node.findMany({
      where: { isActive: true, OR: [{ registrationStatus: "agent_ready" }, { registrationStatus: null }] },
      select: { id: true, name: true, serverHost: true, serverPort: true },
      orderBy: { name: "asc" }
    });
    return {
      intervalSeconds: DOMESTIC_PROBE_INTERVAL_SECONDS,
      targets: nodes.map((node) => ({ nodeId: node.id, name: node.name, host: node.serverHost, port: node.serverPort }))
    };
  }

  /**
   * Applies one probe round. The whole round runs under the same advisory lock
   * as the settings row, so two overlapping reports cannot interleave their
   * read-modify-write of a node's failure streak.
   */
  async report(report: DomesticProbeReport, now = new Date()) {
    const ignoredReason = shouldIgnoreRound(report.controlOk, report.results);
    if (ignoredReason) {
      this.logger.warn(`Domestic probe round ignored: ${ignoredReason}`);
    }
    return this.prisma.$transaction(async (tx) => {
      await lockSetting(tx);
      let accepted = 0;
      if (!ignoredReason) {
        const ids = [...new Set(report.results.map((item) => item.nodeId))];
        const nodes = await tx.node.findMany({
          where: { id: { in: ids } },
          select: { id: true, domesticStatus: true, domesticFailStreak: true, controlStatus: true, agentLastSeenAt: true }
        });
        const byId = new Map(nodes.map((node) => [node.id, node]));
        for (const result of report.results) {
          const node = byId.get(result.nodeId);
          if (!node) continue;
          byId.delete(result.nodeId); // one observation per node per round
          const agentOnline = node.agentLastSeenAt !== null
            && readEffectiveControlStatus(node.controlStatus, node.agentLastSeenAt, now) !== "offline";
          const next = nextDomesticState(node, result, agentOnline);
          await tx.node.update({ where: { id: node.id }, data: { ...next, domesticCheckedAt: now } });
          accepted += 1;
        }
      }
      await writeSetting(tx, (current) => ({
        ...current,
        lastReportAt: now.toISOString(),
        lastRoundIgnored: ignoredReason !== null,
        lastRoundReason: ignoredReason
      }));
      return { accepted, ignored: ignoredReason !== null, reason: ignoredReason };
    });
  }

  private async readConfig() {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: DOMESTIC_PROBE_SETTING_KEY } });
    return parseDomesticProbeConfig(row?.value);
  }

  private async writeConfig(update: (current: StoredDomesticProbeConfig) => StoredDomesticProbeConfig) {
    return this.prisma.$transaction(async (tx) => {
      await lockSetting(tx);
      return writeSetting(tx, update);
    });
  }
}

type SettingTx = Pick<PrismaService, "$executeRaw" | "systemSetting">;

async function lockSetting(tx: Pick<PrismaService, "$executeRaw">) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${DOMESTIC_PROBE_SETTING_KEY}))`;
}

async function writeSetting(tx: SettingTx, update: (current: StoredDomesticProbeConfig) => StoredDomesticProbeConfig) {
  const row = await tx.systemSetting.findUnique({ where: { key: DOMESTIC_PROBE_SETTING_KEY } });
  const next = update(parseDomesticProbeConfig(row?.value));
  await tx.systemSetting.upsert({
    where: { key: DOMESTIC_PROBE_SETTING_KEY },
    create: { key: DOMESTIC_PROBE_SETTING_KEY, value: next },
    update: { value: next }
  });
  return next;
}
