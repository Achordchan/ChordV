import { Module } from "@nestjs/common";
import { AchordConnectWebhookController, AdminSupportIntegrationController, ClientSupportController } from "./support.controller";
import { SupportIntegrationService } from "./support-integration.service";

/** 新工单系统（Achord Connect）接入：后台设置、客户端入口与 Webhook。 */
@Module({
  controllers: [AdminSupportIntegrationController, ClientSupportController, AchordConnectWebhookController],
  providers: [SupportIntegrationService]
})
export class SupportModule {}
