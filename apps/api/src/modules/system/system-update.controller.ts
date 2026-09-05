import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { IsIn, IsOptional, IsString, Matches } from "class-validator";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { SystemUpdateService } from "../common/system-update.service";

class RollbackBodyDto {
  @IsOptional()
  @IsString()
  version?: string;
}

class UpdateBodyDto {
  // The version the admin reviewed in the UI. The service refuses to install a
  // different (e.g. newer, just-published) release than this, so unreviewed changes
  // are never applied silently.
  @IsOptional()
  @IsString()
  expectedVersion?: string;
}

class OperationsQueryDto {
  // A bare digit string only — rejects `?limit=abc` with a 400 rather than letting
  // NaN reach Prisma's `take` and surface as an internal server error.
  @IsOptional()
  @Matches(/^\d{1,4}$/, { message: "limit 必须是 1-4 位数字。" })
  limit?: string;
}

class CheckUpdateQueryDto {
  @IsOptional()
  @IsIn(["true", "false"])
  force?: string;
}

type AuthedRequest = { authUser?: { id?: string; email?: string; displayName?: string } };

function actorFrom(request: AuthedRequest) {
  const user = request.authUser;
  const label = user?.email || user?.displayName || null;
  return { actorLabel: label, actorUserId: user?.id ?? null };
}

@Controller("admin/system")
@UseGuards(AdminAuthGuard)
export class SystemUpdateController {
  constructor(private readonly systemUpdateService: SystemUpdateService) {}

  @Get("version")
  getVersion() {
    return this.systemUpdateService.getRuntimeStatus();
  }

  @Get("check-update")
  checkUpdate(@Query() query: CheckUpdateQueryDto) {
    return this.systemUpdateService.checkUpdate(query.force === "true");
  }

  @Get("rollback-versions")
  async rollbackVersions() {
    return { versions: await this.systemUpdateService.listRollbackVersions() };
  }

  @Get("operations")
  async operations(@Query() query: OperationsQueryDto) {
    const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
    return { operations: await this.systemUpdateService.listOperations(limit) };
  }

  @Get("update-status")
  async updateStatus(@Query("operationId") operationId?: string) {
    if (!operationId) {
      return { operation: null };
    }
    return { operation: await this.systemUpdateService.getOperation(operationId) };
  }

  @Post("update")
  update(@Body() body: UpdateBodyDto, @Req() request: AuthedRequest) {
    const actor = actorFrom(request);
    return this.systemUpdateService.startUpdate(actor.actorLabel, actor.actorUserId, body.expectedVersion);
  }

  @Post("rollback")
  rollback(@Body() body: RollbackBodyDto, @Req() request: AuthedRequest) {
    const actor = actorFrom(request);
    return this.systemUpdateService.startRollback(actor.actorLabel, actor.actorUserId, body.version);
  }

  @Post("restart")
  restart(@Req() request: AuthedRequest) {
    const actor = actorFrom(request);
    return this.systemUpdateService.startRestart(actor.actorLabel, actor.actorUserId);
  }
}
