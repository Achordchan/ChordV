import { Module } from "@nestjs/common";
import { DevDataModule } from "../common/dev-data.module";
import { AchordConnectWebhookController, AdminSupportIntegrationController, ClientSupportController } from "./support.controller";
import { SupportIntegrationService } from "./support-integration.service";
import { SupportContactContextService } from "./support-contact-context.service";

/** 新工单系统（Achord Connect）接入：后台设置、客户端入口与 Webhook。 */
@Module({
  // DevDataModule 是全局模块，这里显式导入，写明 SupportIntegrationService 依赖它导出的 SiteAddressService、ClientEventsPublisher。
  imports: [DevDataModule],
  controllers: [AdminSupportIntegrationController, ClientSupportController, AchordConnectWebhookController],
  providers: [SupportIntegrationService, SupportContactContextService]
})
export class SupportModule {}
