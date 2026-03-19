import { Module } from "@nestjs/common";
import { EdgeGatewayController } from "./edge-gateway.controller";
import { EdgeGatewayService } from "./edge-gateway.service";
import { UsageModule } from "../usage/usage.module";

@Module({
  imports: [UsageModule],
  controllers: [EdgeGatewayController],
  providers: [EdgeGatewayService],
  exports: [EdgeGatewayService]
})
export class EdgeGatewayModule {}
