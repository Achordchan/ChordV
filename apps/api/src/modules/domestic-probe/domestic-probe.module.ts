import { Module } from "@nestjs/common";
import { AdminDomesticProbeController, DomesticProbeAuthGuard, DomesticProbeController } from "./domestic-probe.controller";
import { DomesticProbeService } from "./domestic-probe.service";

@Module({
  controllers: [DomesticProbeController, AdminDomesticProbeController],
  providers: [DomesticProbeService, DomesticProbeAuthGuard]
})
export class DomesticProbeModule {}
