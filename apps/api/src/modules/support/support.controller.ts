import { Body, Controller, Get, Header, Headers, HttpCode, Logger, Post, Put, Req, UseGuards } from "@nestjs/common";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
import type { UserProfileDto } from "@chordv/shared";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { ClientAuthGuard } from "../common/client-auth.guard";
import { SupportIntegrationService } from "./support-integration.service";
import { parseSupportLaunchContext } from "./support-contact-context";

export class UpdateSupportIntegrationConfigDto {
  @IsOptional() @IsString() @MaxLength(2048) baseUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(256) clientId?: string | null;
  @IsOptional() @IsString() @MaxLength(1024) clientSecret?: string | null;
  @IsOptional() @IsString() @MaxLength(1024) webhookSecret?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/** 后台“工单系统接入”设置。密钥只写不读。 */
@Controller("admin/support-integration")
@UseGuards(AdminAuthGuard)
export class AdminSupportIntegrationController {
  constructor(private readonly support: SupportIntegrationService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  get() {
    return this.support.getAdminConfig();
  }

  @Put()
  @Header("Cache-Control", "no-store")
  save(@Body() body: UpdateSupportIntegrationConfigDto) {
    return this.support.updateAdminConfig(body);
  }

  @Post("test")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  test() {
    return this.support.testConnection();
  }
}

/** 新版客户端的工单入口：查询状态与未读数、创建一次性打开地址。 */
@Controller("client/support")
@UseGuards(ClientAuthGuard)
export class ClientSupportController {
  private readonly logger = new Logger(ClientSupportController.name);

  constructor(private readonly support: SupportIntegrationService) {}

  @Get("status")
  @Header("Cache-Control", "no-store")
  status(@Req() request: { authUser: UserProfileDto }) {
    return this.support.getClientStatus(request.authUser.id);
  }

  /**
   * 请求体 { context } 是新版客户端附带的诊断信息（可选，旧版客户端没有请求体）。这里不交给全局校验管道：
   * 由 parseSupportLaunchContext 按白名单逐项校验，不合格的字段只丢弃该项，诊断信息永远不会让打开工单失败。
   */
  @Post("launch")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  launch(@Req() request: { authUser: UserProfileDto }, @Body() body: unknown) {
    const user = request.authUser;
    const parsed = parseSupportLaunchContext(body);
    if (parsed.oversized || parsed.dropped.length > 0) {
      this.logger.warn(`工单诊断信息不合格（用户 ${user.id}）：${parsed.oversized ? "超过 4 KB，整体丢弃" : `丢弃字段 ${parsed.dropped.join("、")}`}`);
    }
    return this.support.launchForClient({ id: user.id, email: user.email, displayName: user.displayName }, parsed.context);
  }
}

/**
 * Achord Connect Webhook 接收端（公开，靠签名认证）。
 * 请求体由 main.ts 为这条路径单独挂的原始正文解析器读成 Buffer，验签必须用原始字节。
 */
@Controller("integrations/achord-connect")
export class AchordConnectWebhookController {
  constructor(private readonly support: SupportIntegrationService) {}

  @Post("webhook")
  @HttpCode(200)
  async webhook(
    @Req() request: { body?: unknown },
    @Headers("x-achord-event-id") eventId?: string,
    @Headers("x-achord-timestamp") timestamp?: string,
    @Headers("x-achord-signature") signature?: string
  ) {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const result = await this.support.handleWebhook({ rawBody, eventId, timestamp, signature });
    return { ok: true, result };
  }
}
