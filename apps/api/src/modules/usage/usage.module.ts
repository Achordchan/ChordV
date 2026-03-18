import { Module } from "@nestjs/common";
import { UsageSyncService } from "./usage-sync.service";

@Module({
  providers: [UsageSyncService]
})
export class UsageModule {}
