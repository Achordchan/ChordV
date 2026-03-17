import { Module } from "@nestjs/common";
import { PanelsController } from "./panels.controller";
import { PanelSyncScheduler } from "./panel-sync.scheduler";

@Module({
  controllers: [PanelsController],
  providers: [PanelSyncScheduler]
})
export class PanelsModule {}
