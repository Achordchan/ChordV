import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { AgentRegisterDto, CreateAgentCredentialDto, QueueAgentCommandDto } from "./agent.dto";
import { AgentRegisterService } from "./agent-register.service";
import { AgentService } from "./agent.service";
import { parsePanelLink } from "./panel-inbound";

// A runtime class (not a TS interface): the global ValidationPipe only validates
// class-decorated bodies — an interface-only DTO reaches the service as an
// unvalidated Object.
class CreateAgentNodeDto {
  @IsObject()
  panelInbound!: Record<string, unknown>;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  countryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  provider?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  tags?: string[];

  @IsOptional()
  @IsIn([true, false])
  isActive?: boolean;

  @IsOptional()
  @IsIn([true, false])
  recommended?: boolean;
}

class ParsePanelLinkDto {
  @IsString()
  @MaxLength(4096)
  link!: string;

  @IsString()
  @MaxLength(32)
  panelVersion!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  inboundTag?: string;

  @IsOptional()
  @IsBoolean()
  tagOverrideConfirmed?: boolean;
}

@Controller("admin/nodes")
@UseGuards(AdminAuthGuard)
export class AgentAdminController {
  constructor(
    private readonly service: AgentService,
    private readonly registerService: AgentRegisterService
  ) {}

  // Agent-native onboarding: create a pending_register node and mint the
  // one-time registration token the install command carries.
  @Post("agent-native")
  createAgentNode(@Body() body: CreateAgentNodeDto) {
    return this.registerService.createAgentNode(body);
  }

  @Get(":nodeId/onboarding")
  getOnboarding(@Param("nodeId") nodeId: string) {
    return this.registerService.getOnboarding(nodeId);
  }

  @Post(":nodeId/onboarding/retry")
  async retryOnboarding(@Param("nodeId") nodeId: string) {
    const status = await this.registerService.getOnboarding(nodeId);
    if (!status.spec) return this.registerService.requireOnboardingSpec();
    return this.service.queueCommand(nodeId, {
      type: "ENSURE_INBOUND", payload: { ...status.spec },
      expectedInboundAppliedRevision: status.node.inboundAppliedRevision ?? "0"
    });
  }

  @Post("panel-inbound/parse")
  parsePanelInbound(@Body() body: ParsePanelLinkDto) {
    return parsePanelLink(body.link, body.panelVersion, body.inboundTag, body.tagOverrideConfirmed);
  }

  @Get(":nodeId/agents")
  listAgents(@Param("nodeId") nodeId: string) {
    return this.service.listAgents(nodeId);
  }

  // The complete spec of the currently applied ENSURE_INBOUND deployment; the
  // admin reissue flow preserves the fields its form does not edit from it.
  @Get(":nodeId/inbound-spec")
  getInboundSpec(@Param("nodeId") nodeId: string) {
    return this.service.getInboundSpec(nodeId);
  }

  // Agent-native onboarding: mint (or re-mint, while still pending) the
  // one-time registration token that the install command carries. The
  // plaintext token is returned exactly once and never stored.
  @Post(":nodeId/register-token")
  issueRegisterToken(@Param("nodeId") nodeId: string) {
    return this.registerService.issueRegisterToken(nodeId);
  }

  @Post(":nodeId/agents/credentials")
  createCredential(@Param("nodeId") nodeId: string, @Body() body: CreateAgentCredentialDto) {
    return this.service.createCredential(nodeId, body.agentId);
  }

  @Delete(":nodeId/agents/:agentId/credentials")
  revokeCredential(@Param("nodeId") nodeId: string, @Param("agentId") agentId: string) {
    return this.service.revokeCredential(nodeId, agentId);
  }

  @Post(":nodeId/agent-commands")
  queueCommand(@Param("nodeId") nodeId: string, @Body() body: QueueAgentCommandDto) {
    return this.service.queueCommand(nodeId, body);
  }

  // The terminal outcome of one queued command; the admin deploy poll
  // distinguishes "this command succeeded" from "a later deployment moved the
  // node past it".
  @Get(":nodeId/agent-commands/:commandId/outcome")
  getCommandOutcome(@Param("nodeId") nodeId: string, @Param("commandId") commandId: string) {
    return this.service.getCommandOutcome(nodeId, commandId);
  }

}
