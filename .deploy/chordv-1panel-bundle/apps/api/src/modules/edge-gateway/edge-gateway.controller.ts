import { Body, Controller, Headers, Post } from "@nestjs/common";
import { EdgeTrafficReportDto } from "./edge-gateway.dto";
import { EdgeGatewayService } from "./edge-gateway.service";

@Controller("internal/edge/sessions")
export class EdgeGatewayController {
  constructor(private readonly edgeGatewayService: EdgeGatewayService) {}

  @Post("report-traffic")
  reportTraffic(@Body() body: EdgeTrafficReportDto, @Headers("authorization") authorization?: string) {
    this.edgeGatewayService.assertInternalToken(authorization);
    return this.edgeGatewayService.ingestTrafficReport(body.nodeId, body.reportedAt, body.records);
  }
}
