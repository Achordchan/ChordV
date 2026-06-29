import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  ClientRoutingRuleAction,
  ClientRoutingRuleDto,
  ClientRoutingRuleMatchType,
  CreateClientRoutingRuleInputDto,
  UpdateClientRoutingRuleInputDto
} from "@chordv/shared";
import { AuthSessionService } from "./auth-session.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { PrismaService } from "./prisma.service";
import { createId } from "./release-center.utils";

const MAX_ROUTING_RULES_PER_USER = 100;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KEYWORD_PATTERN = /^[a-z0-9-]{1,64}$/;

type RoutingRuleRow = {
  id: string;
  userId: string;
  name: string | null;
  value: string;
  matchType: string;
  action: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ClientRoutingRuleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService
  ) {}

  async listRules(token?: string): Promise<ClientRoutingRuleDto[]> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    return this.listRulesForUserId(user.id);
  }

  async listRulesForUserId(userId: string): Promise<ClientRoutingRuleDto[]> {
    const rows = await this.prisma.clientRoutingRule.findMany({
      where: { userId },
      orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }]
    });
    return rows.map(toRoutingRuleDto);
  }

  async listEnabledRulesForUserId(userId: string): Promise<ClientRoutingRuleDto[]> {
    const rows = await this.prisma.clientRoutingRule.findMany({
      where: { userId, enabled: true },
      orderBy: [{ updatedAt: "desc" }]
    });
    return rows.map(toRoutingRuleDto);
  }

  async createRule(input: CreateClientRoutingRuleInputDto, token?: string): Promise<ClientRoutingRuleDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const count = await this.prisma.clientRoutingRule.count({ where: { userId: user.id } });
    if (count >= MAX_ROUTING_RULES_PER_USER) {
      throw new BadRequestException("每个账号最多保存 100 条自定义分流规则。");
    }

    const normalized = normalizeRoutingRuleValue(input.value);
    try {
      const row = await this.prisma.clientRoutingRule.create({
        data: {
          id: createId("routing"),
          userId: user.id,
          name: normalizeOptionalName(input.name),
          value: normalized.value,
          matchType: normalized.matchType,
          action: normalizeRoutingRuleAction(input.action),
          enabled: input.enabled ?? true
        }
      });
      this.publishPolicyUpdatedBestEffort(user.id);
      return toRoutingRuleDto(row);
    } catch (error) {
      throwDuplicateAsConflict(error);
    }
  }

  async updateRule(
    ruleId: string,
    input: UpdateClientRoutingRuleInputDto,
    token?: string
  ): Promise<ClientRoutingRuleDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const current = await this.prisma.clientRoutingRule.findFirst({
      where: { id: ruleId, userId: user.id }
    });
    if (!current) {
      throw new NotFoundException("自定义分流规则不存在。");
    }

    const normalized = input.value === undefined ? null : normalizeRoutingRuleValue(input.value);
    try {
      const row = await this.prisma.clientRoutingRule.update({
        where: { id: ruleId },
        data: {
          name: input.name === undefined ? undefined : normalizeOptionalName(input.name),
          value: normalized?.value,
          matchType: normalized?.matchType,
          action: input.action === undefined ? undefined : normalizeRoutingRuleAction(input.action),
          enabled: input.enabled
        }
      });
      this.publishPolicyUpdatedBestEffort(user.id);
      return toRoutingRuleDto(row);
    } catch (error) {
      throwDuplicateAsConflict(error);
    }
  }

  async deleteRule(ruleId: string, token?: string): Promise<{ ok: true; deletedId: string }> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const current = await this.prisma.clientRoutingRule.findFirst({
      where: { id: ruleId, userId: user.id }
    });
    if (!current) {
      throw new NotFoundException("自定义分流规则不存在。");
    }

    await this.prisma.clientRoutingRule.delete({ where: { id: ruleId } });
    this.publishPolicyUpdatedBestEffort(user.id);
    return { ok: true, deletedId: ruleId };
  }

  private publishPolicyUpdatedBestEffort(userId: string) {
    try {
      this.clientRuntimeEventsService.publishToUser(userId, {
        type: "policy_updated",
        occurredAt: new Date().toISOString()
      });
    } catch {
      // 保存结果不能因为 SSE 推送失败而回滚；下次登录和刷新仍会从数据库同步。
    }
  }
}

function normalizeRoutingRuleValue(rawValue: string): {
  value: string;
  matchType: ClientRoutingRuleMatchType;
} {
  const value = String(rawValue ?? "").trim().toLowerCase().replace(/^\.+/, "");
  if (!value) {
    throw new BadRequestException("请输入域名或关键词。");
  }
  if (value.includes("://") || /[/?#\s]/.test(value)) {
    throw new BadRequestException("只支持域名或关键词，不要包含协议、路径或空格。");
  }
  if (value.length > 128) {
    throw new BadRequestException("域名或关键词不能超过 128 个字符。");
  }

  if (value.includes(".")) {
    validateDomainValue(value);
    return { value, matchType: "domain" };
  }

  if (!KEYWORD_PATTERN.test(value)) {
    throw new BadRequestException("关键词只能包含小写字母、数字和短横线。");
  }
  return { value, matchType: "keyword" };
}

function validateDomainValue(value: string) {
  const labels = value.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label))) {
    throw new BadRequestException("请输入有效域名，例如 example.com。");
  }
}

function normalizeOptionalName(name: string | null | undefined) {
  const value = String(name ?? "").trim();
  return value ? value.slice(0, 80) : null;
}

function normalizeRoutingRuleAction(action: ClientRoutingRuleAction): ClientRoutingRuleAction {
  if (action !== "proxy" && action !== "direct") {
    throw new BadRequestException("分流动作只能是强制代理或强制直连。");
  }
  return action;
}

function toRoutingRuleDto(row: RoutingRuleRow): ClientRoutingRuleDto {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    value: row.value,
    matchType: row.matchType as ClientRoutingRuleMatchType,
    action: row.action as ClientRoutingRuleAction,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function throwDuplicateAsConflict(error: unknown): never {
  if (isPrismaUniqueError(error)) {
    throw new ConflictException("这条自定义分流规则已存在。");
  }
  throw error;
}

function isPrismaUniqueError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}
