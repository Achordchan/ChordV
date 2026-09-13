import { UserRoutingRulesController } from "./user-routing-rules.controller";
import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";

@Module({
  controllers: [AdminController, UserRoutingRulesController]
})
export class AdminModule {}
