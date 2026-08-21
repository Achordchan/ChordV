import { Global, Module } from "@nestjs/common";
import { AgentAdminController } from "./agent-admin.controller";
import { AgentControlModeService } from "./agent-control-mode.service";
import { AgentAuthGuard } from "./agent-auth.guard";
import { AgentController } from "./agent.controller";
import { AgentEventsService } from "./agent-events.service";
import { AgentService } from "./agent.service";
import { XuiModule } from "../xui/xui.module";
import { UsageModule } from "../usage/usage.module";

@Global()
@Module({
  imports: [XuiModule, UsageModule],
  controllers: [AgentController, AgentAdminController],
  providers: [AgentService, AgentControlModeService, AgentEventsService, AgentAuthGuard],
  exports: [AgentService, AgentEventsService]
})
export class AgentModule {}
