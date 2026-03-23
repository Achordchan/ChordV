import { BadGatewayException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import type { EdgeSessionCloseInputDto, EdgeSessionOpenInputDto } from "@chordv/shared";
import { PrismaService } from "../common/prisma.service";
import { UsageSyncService } from "../usage/usage-sync.service";

const EDGE_INTERNAL_BASE_URL = (process.env.CHORDV_EDGE_INTERNAL_BASE_URL ?? "http://127.0.0.1:3011").replace(/\/$/, "");
const EDGE_INTERNAL_TOKEN = process.env.CHORDV_EDGE_INTERNAL_TOKEN?.trim() || "chordv-edge-internal";
const EDGE_REQUEST_TIMEOUT_MS = Number(process.env.CHORDV_EDGE_REQUEST_TIMEOUT_MS ?? 15000);
const EDGE_REALITY_STATE_PATH = path.resolve(__dirname, "../../../../edge-gateway/.runtime/reality.json");

@Injectable()
export class EdgeGatewayService {
  private readonly logger = new Logger(EdgeGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usageSyncService: UsageSyncService
  ) {}

  getPublicRuntimeConfig() {
    const fallbackRealityState = this.readRealityState();
    return {
      server: process.env.CHORDV_EDGE_PUBLIC_HOST?.trim() || "127.0.0.1",
      port: Number(process.env.CHORDV_EDGE_PUBLIC_PORT ?? 8443),
      flow: process.env.CHORDV_EDGE_PUBLIC_FLOW?.trim() || "xtls-rprx-vision",
      realityPublicKey: process.env.CHORDV_EDGE_REALITY_PUBLIC_KEY?.trim() || fallbackRealityState.publicKey,
      shortId: process.env.CHORDV_EDGE_REALITY_SHORT_ID?.trim() || fallbackRealityState.shortId,
      serverName: process.env.CHORDV_EDGE_SERVER_NAME?.trim() || "edge.chordv.app",
      fingerprint: process.env.CHORDV_EDGE_FINGERPRINT?.trim() || "chrome",
      spiderX: process.env.CHORDV_EDGE_SPIDER_X?.trim() || "/"
    };
  }

  assertInternalToken(authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== EDGE_INTERNAL_TOKEN) {
      throw new UnauthorizedException("缺少访问令牌");
    }
  }

  async openSession(input: EdgeSessionOpenInputDto) {
    await this.postInternal("/internal/sessions/open", input);
    await this.prisma.node.update({
      where: { id: input.node.nodeId },
      data: { gatewayStatus: "online" }
    });
  }

  async closeSession(input: EdgeSessionCloseInputDto) {
    await this.postInternal("/internal/sessions/close", input);
  }

  async ingestTrafficReport(nodeId: string, reportedAt: string, records: unknown) {
    await this.usageSyncService.ingestUsageReport(nodeId, records, reportedAt);
    await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        gatewayStatus: "online",
        statsLastSyncedAt: new Date(reportedAt)
      }
    });
    return { ok: true };
  }

  async markNodeUnavailable(nodeId: string, detail: string) {
    this.logger.warn(`节点 ${nodeId} 中转网关不可用: ${detail}`);
    await this.prisma.node.update({
      where: { id: nodeId },
      data: { gatewayStatus: "degraded" }
    });
  }

  async getGatewayStatus() {
    try {
      await this.requestInternal("/health", "GET");
      return "online" as const;
    } catch {
      return "offline" as const;
    }
  }

  private async postInternal(pathName: string, payload: unknown) {
    return this.requestInternal(pathName, "POST", payload);
  }

  private readRealityState() {
    if (!fs.existsSync(EDGE_REALITY_STATE_PATH)) {
      return {
        publicKey: "replace-with-edge-public-key",
        shortId: "0123abcd"
      };
    }

    try {
      const payload = JSON.parse(fs.readFileSync(EDGE_REALITY_STATE_PATH, "utf8")) as {
        publicKey?: string;
        shortId?: string;
      };
      return {
        publicKey: payload.publicKey?.trim() || "replace-with-edge-public-key",
        shortId: payload.shortId?.trim() || "0123abcd"
      };
    } catch {
      return {
        publicKey: "replace-with-edge-public-key",
        shortId: "0123abcd"
      };
    }
  }

  private async requestInternal(pathName: string, method: "GET" | "POST", payload?: unknown) {
    let response: UndiciResponse;
    try {
      response = await undiciFetch(`${EDGE_INTERNAL_BASE_URL}${pathName}`, {
        method,
        headers: {
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${EDGE_INTERNAL_TOKEN}`
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(EDGE_REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "fetch failed";
      throw new BadGatewayException(`中心中转服务未启动或无法访问：${detail}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new BadGatewayException(`中心中转服务异常：HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }

    return response.json().catch(() => ({ ok: true }));
  }
}
