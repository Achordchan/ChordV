import { Body, Controller, Get, Headers, Param, Post, Req, Sse, UseGuards } from "@nestjs/common";
import type { NodeAgent } from "@prisma/client";
import { AgentAuthGuard, AgentAuthenticatedRequest } from "./agent-auth.guard";
import { AgentCommandResultDto, AgentHeartbeatDto, AgentUsageBatchDto } from "./agent.dto";
import { AgentEventsService } from "./agent-events.service";
import { AgentService } from "./agent.service";

@Controller("agent/v1")
@UseGuards(AgentAuthGuard)
export class AgentController {
  constructor(private readonly service: AgentService, private readonly events: AgentEventsService) {}

  @Sse("events")
  streamEvents(@Req() request: AgentAuthenticatedRequest, @Headers("authorization") authorization?: string) {
    const agent = requireAgent(request.agent);
    return this.events.stream(agent.id, async () => {
      const current = await this.service.authenticate(authorization);
      if (!current || current.id !== agent.id) throw new Error("Agent 凭据已失效");
    });
  }

  @Post("heartbeat")
  heartbeat(@Req() request: AgentAuthenticatedRequest, @Body() body: AgentHeartbeatDto) {
    return this.service.heartbeat(requireAgent(request.agent), body);
  }

  @Post("usage-batches")
  usageBatches(@Req() request: AgentAuthenticatedRequest, @Body() body: AgentUsageBatchDto) {
    return this.service.ingestUsageBatch(requireAgent(request.agent), body);
  }

  @Get("config")
  getConfig(@Req() request: AgentAuthenticatedRequest) {
    return this.service.getConfig(requireAgent(request.agent));
  }

  @Post("commands/:commandId/result")
  commandResult(@Req() request: AgentAuthenticatedRequest, @Param("commandId") commandId: string, @Body() body: AgentCommandResultDto) {
    return this.service.completeCommand(requireAgent(request.agent), commandId, body);
  }
}

function requireAgent(agent?: NodeAgent) {
  if (!agent) throw new Error("Agent 认证上下文缺失");
  return agent;
}
