import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { NodeAgent } from "@prisma/client";
import { AgentService } from "./agent.service";

export type AgentAuthenticatedRequest = {
  headers: { authorization?: string; "x-chordv-agent-id"?: string; "x-chordv-node-id"?: string };
  agent?: NodeAgent;
};

@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(private readonly agentService: AgentService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AgentAuthenticatedRequest>();
    const agent = await this.agentService.authenticate(request.headers.authorization);
    if (!agent || request.headers["x-chordv-agent-id"] !== agent.agentId || request.headers["x-chordv-node-id"] !== agent.nodeId) {
      throw new UnauthorizedException("Agent 凭据无效或已撤销");
    }
    request.agent = agent;
    return true;
  }
}
