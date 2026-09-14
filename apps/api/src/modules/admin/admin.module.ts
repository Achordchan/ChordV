import { UserRoutingRulesController } from "./user-routing-rules.controller";
import { RuntimeVersionController } from "./runtime-version.controller";
import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";

@Module({
  controllers: [AdminController, RuntimeVersionController, UserRoutingRulesController]
})
export class AdminModule {}
