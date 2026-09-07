import { Global, Module } from "@nestjs/common";
import { AgentAdminController } from "./agent-admin.controller";
import { AgentControlModeService } from "./agent-control-mode.service";
import { AgentAuthGuard } from "./agent-auth.guard";
import { AgentController } from "./agent.controller";
import { AgentDownloadController } from "./agent-download.controller";
import { AgentEventsService } from "./agent-events.service";
import { AgentInstallController } from "./agent-install.controller";
import { AgentRegisterController } from "./agent-register.controller";
import { AgentRegisterService } from "./agent-register.service";
import { AgentService } from "./agent.service";
import { XuiModule } from "../xui/xui.module";
import { UsageModule } from "../usage/usage.module";

@Global()
@Module({
  imports: [XuiModule, UsageModule],
  controllers: [AgentController, AgentAdminController, AgentRegisterController, AgentInstallController, AgentDownloadController],
  providers: [AgentService, AgentControlModeService, AgentEventsService, AgentRegisterService, AgentAuthGuard],
  exports: [AgentService, AgentEventsService, AgentRegisterService]
})
export class AgentModule {}
