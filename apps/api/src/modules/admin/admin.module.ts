import { StorageController } from "./storage.controller";
import { UserRoutingRulesController } from "./user-routing-rules.controller";
import { RuntimeVersionController } from "./runtime-version.controller";
import { Module } from "@nestjs/common";
import { SiteAddressController, ClientSiteAddressController } from "./site-address.controller";
import { AdminController } from "./admin.controller";
import { AdminDeletionController } from "./admin-deletion.controller";
import { SubscriptionLinkSettingsController, UserSubscriptionLinkController } from "./subscription-link.controller";

@Module({
  controllers: [StorageController, AdminController, AdminDeletionController, RuntimeVersionController, UserRoutingRulesController, SiteAddressController, ClientSiteAddressController, UserSubscriptionLinkController, SubscriptionLinkSettingsController]
})
export class AdminModule {}
