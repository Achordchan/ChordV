import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { AdminDomesticProbeStateDto, AdminDomesticProbeTokenDto } from "@chordv/shared";
import { PrismaService } from "../common/prisma.service";
import { readEffectiveControlStatus } from "../common/node-import.utils";
import {
  DOMESTIC_MAX_TARGETS,
  DOMESTIC_PROBE_INTERVAL_SECONDS,
  currentEndpointState,
  domesticEndpointKey,
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
  results: Array<DomesticObservation & { nodeId: string; host: string; port: number }>;
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

  /**
   * Nodes the probe should check: active nodes with a registered agent (or
   * legacy nodes without onboarding), least recently handed out first, capped
   * at the report limit. Handing a node out stamps domesticScheduledAt
   * whether or not the round is later accepted, so which nodes are handed out
   * rotates once the fleet exceeds the cap, even when rounds are ignored.
   * Within a round the probe shuffles its work order, so the nodes its
   * deadline cuts off differ from round to round. Reachability state itself
   * only changes through accepted reports.
   */
  async listTargets(now = new Date()) {
    const where = { isActive: true, OR: [{ registrationStatus: "agent_ready" as const }, { registrationStatus: null }] };
    const nodes = await this.prisma.node.findMany({
      where,
      select: { id: true, name: true, serverHost: true, serverPort: true },
      // Ties (a whole batch shares one domesticScheduledAt) break on the last
      // accepted observation, so nodes the probe did not finish last time,
      // whose domesticCheckedAt did not advance, come first.
      orderBy: [
        { domesticScheduledAt: { sort: "asc", nulls: "first" } },
        { domesticCheckedAt: { sort: "asc", nulls: "first" } },
        { name: "asc" }
      ],
      take: DOMESTIC_MAX_TARGETS
    });
    if (nodes.length === DOMESTIC_MAX_TARGETS && (await this.prisma.node.count({ where })) > DOMESTIC_MAX_TARGETS) {
      this.logger.warn(`More than ${DOMESTIC_MAX_TARGETS} nodes are eligible; the domestic probe now rotates and some results will read as unknown between visits.`);
    }
    if (nodes.length > 0) {
      await this.prisma.node.updateMany({ where: { id: { in: nodes.map((node) => node.id) } }, data: { domesticScheduledAt: now } });
    }
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
          select: { id: true, serverHost: true, serverPort: true, domesticEndpoint: true, domesticStatus: true, domesticFailStreak: true, controlStatus: true, agentLastSeenAt: true }
        });
        const byId = new Map(nodes.map((node) => [node.id, node]));
        for (const result of report.results) {
          const node = byId.get(result.nodeId);
          if (!node) continue;
          // The node's address or port changed after the probe got its list:
          // this observation is about an endpoint the node no longer has.
          if (node.serverHost !== result.host || node.serverPort !== result.port) continue;
          byId.delete(result.nodeId); // one observation per node per round
          const agentOnline = node.agentLastSeenAt !== null
            && readEffectiveControlStatus(node.controlStatus, node.agentLastSeenAt, now) !== "offline";
          const next = nextDomesticState(currentEndpointState(node), result, agentOnline);
          // Conditional on the endpoint still matching, so an address edit
          // committed after the read above is never stamped with this result.
          const written = await tx.node.updateMany({
            where: { id: node.id, serverHost: result.host, serverPort: result.port },
            data: { ...next, domesticCheckedAt: now, domesticEndpoint: domesticEndpointKey(result.host, result.port) }
          });
          if (written.count === 0) continue;
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
