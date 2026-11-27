import { Body, CanActivate, Controller, Delete, ExecutionContext, Get, Header, HttpCode, Injectable, Post, UnauthorizedException, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { DomesticProbeReportDto } from "./domestic-probe.dto";
import { DomesticProbeService } from "./domestic-probe.service";

@Injectable()
export class DomesticProbeAuthGuard implements CanActivate {
  constructor(private readonly service: DomesticProbeService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    if (!(await this.service.authenticate(request.headers.authorization))) {
      throw new UnauthorizedException("国内探针令牌无效或已撤销");
    }
    return true;
  }
}

/** Used by the probe script running on a server in mainland China. Its token can only read targets and write results. */
@Controller("domestic-probe")
@UseGuards(DomesticProbeAuthGuard)
export class DomesticProbeController {
  constructor(private readonly service: DomesticProbeService) {}

  @Get("targets")
  @Header("Cache-Control", "no-store")
  targets() {
    return this.service.listTargets();
  }

  @Post("report")
  @HttpCode(200)
  report(@Body() body: DomesticProbeReportDto) {
    return this.service.report({
      controlOk: body.controlOk,
      results: body.results.map((item) => ({
        nodeId: item.nodeId,
        tcpOk: item.tcpOk,
        tcpLatencyMs: item.tcpLatencyMs ?? null,
        error: item.error ?? null
      }))
    });
  }
}

@Controller("admin/domestic-probe")
@UseGuards(AdminAuthGuard)
export class AdminDomesticProbeController {
  constructor(private readonly service: DomesticProbeService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  state() {
    return this.service.getState();
  }

  @Post("token")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  rotate() {
    return this.service.rotateToken();
  }

  @Delete("token")
  @Header("Cache-Control", "no-store")
  revoke() {
    return this.service.revokeToken();
  }
}
