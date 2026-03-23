import { AdminAuthGuard } from "./admin-auth.guard";
import { AuthSessionService } from "./auth-session.service";
import { ClientAuthGuard } from "./client-auth.guard";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { Global, Module } from "@nestjs/common";
import { DevDataService } from "./dev-data.service";
import { RuntimeComponentsService } from "./runtime-components.service";
import { EdgeGatewayModule } from "../edge-gateway/edge-gateway.module";
import { MeteringIncidentService } from "./metering-incident.service";
import { XuiModule } from "../xui/xui.module";

@Global()
@Module({
  imports: [EdgeGatewayModule, XuiModule],
  providers: [
    DevDataService,
    RuntimeComponentsService,
    MeteringIncidentService,
    AuthSessionService,
    ClientRuntimeEventsService,
    ClientAuthGuard,
    AdminAuthGuard
  ],
  exports: [
    DevDataService,
    RuntimeComponentsService,
    MeteringIncidentService,
    AuthSessionService,
    ClientRuntimeEventsService,
    ClientAuthGuard,
    AdminAuthGuard
  ]
})
export class DevDataModule {}
