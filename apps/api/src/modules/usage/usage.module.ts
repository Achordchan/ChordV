import { Module } from "@nestjs/common";
import { UsageSyncService } from "./usage-sync.service";

@Module({
  providers: [UsageSyncService],
  exports: [UsageSyncService]
})
export class UsageModule {}
