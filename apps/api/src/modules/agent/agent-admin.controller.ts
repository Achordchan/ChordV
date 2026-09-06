import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { CreateAgentCredentialDto, QueueAgentCommandDto, SwitchNodeControlModeDto } from "./agent.dto";
import { AgentControlModeService } from "./agent-control-mode.service";
import { AgentService } from "./agent.service";

@Controller("admin/nodes")
@UseGuards(AdminAuthGuard)
export class AgentAdminController {
  constructor(private readonly service: AgentService, private readonly controlModeService: AgentControlModeService) {}

  @Get(":nodeId/agents")
  listAgents(@Param("nodeId") nodeId: string) {
    return this.service.listAgents(nodeId);
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
