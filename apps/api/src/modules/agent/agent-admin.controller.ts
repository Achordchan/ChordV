import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { CreateAgentNodeInputDto } from "@chordv/shared";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { AgentRegisterDto, CreateAgentCredentialDto, QueueAgentCommandDto, SwitchNodeControlModeDto } from "./agent.dto";
import { AgentControlModeService } from "./agent-control-mode.service";
import { AgentRegisterService } from "./agent-register.service";
import { AgentService } from "./agent.service";

@Controller("admin/nodes")
@UseGuards(AdminAuthGuard)
export class AgentAdminController {
  constructor(
    private readonly service: AgentService,
    private readonly controlModeService: AgentControlModeService,
    private readonly registerService: AgentRegisterService
  ) {}

  // Agent-native onboarding: create a pending_register node and mint the
  // one-time registration token the install command carries.
  @Post("agent-native")
  createAgentNode(@Body() body: CreateAgentNodeInputDto) {
    return this.registerService.createAgentNode(body);
  }

  @Get(":nodeId/agents")
  listAgents(@Param("nodeId") nodeId: string) {
    return this.service.listAgents(nodeId);
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

  @Post(":nodeId/control-mode")
  switchControlMode(@Param("nodeId") nodeId: string, @Body() body: SwitchNodeControlModeDto) {
    return this.controlModeService.switchMode(nodeId, body);
  }
}
