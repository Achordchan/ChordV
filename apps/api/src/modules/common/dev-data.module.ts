import { AdminAuthGuard } from "./admin-auth.guard";
import { AuthSessionService } from "./auth-session.service";
import { ClientAuthGuard } from "./client-auth.guard";
import { Global, Module } from "@nestjs/common";
import { DevDataService } from "./dev-data.service";
import { EdgeGatewayModule } from "../edge-gateway/edge-gateway.module";
import { MeteringIncidentService } from "./metering-incident.service";

@Global()
@Module({
  imports: [EdgeGatewayModule],
  providers: [DevDataService, MeteringIncidentService, AuthSessionService, ClientAuthGuard, AdminAuthGuard],
  exports: [DevDataService, MeteringIncidentService, AuthSessionService, ClientAuthGuard, AdminAuthGuard]
})
export class DevDataModule {}
