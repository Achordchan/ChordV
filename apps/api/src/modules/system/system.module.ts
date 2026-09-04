import { Module } from "@nestjs/common";
import { SystemUpdateService } from "../common/system-update.service";
import { HealthController } from "./health.controller";
import { SystemUpdateController } from "./system-update.controller";

@Module({
  controllers: [HealthController, SystemUpdateController],
  providers: [SystemUpdateService],
  exports: [SystemUpdateService]
})
export class SystemModule {}
