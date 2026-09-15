import { StorageController } from "./storage.controller";
import { UserRoutingRulesController } from "./user-routing-rules.controller";
import { RuntimeVersionController } from "./runtime-version.controller";
import { Module } from "@nestjs/common";
import { SiteAddressController, ClientSiteAddressController } from "./site-address.controller";
import { AdminController } from "./admin.controller";

@Module({
  controllers: [StorageController, AdminController, RuntimeVersionController, UserRoutingRulesController, SiteAddressController, ClientSiteAddressController]
})
export class AdminModule {}
