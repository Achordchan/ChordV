import { Body, Controller, Post } from "@nestjs/common";
import { AgentRegisterDto } from "./agent.dto";
import { AgentRegisterService } from "./agent-register.service";

/**
 * UNAUTHENTICATED registration endpoint: the agent-to-be holds no credentials
 * yet — the one-time register token IS the credential. Mounted beside (not
 * under) AgentAuthGuard. Everything else an agent can do still requires the
 * persistent credentials this route mints.
 */
@Controller("agent/v1")
export class AgentRegisterController {
  constructor(private readonly registerService: AgentRegisterService) {}

  @Post("register")
  register(@Body() body: AgentRegisterDto) {
    return this.registerService.register(body);
  }
}
