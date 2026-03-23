import { Module } from "@nestjs/common";
import { UsageSyncService } from "./usage-sync.service";
import { XuiModule } from "../xui/xui.module";

@Module({
  imports: [XuiModule],
  providers: [UsageSyncService],
  exports: [UsageSyncService]
})
export class UsageModule {}
