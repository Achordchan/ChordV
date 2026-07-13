import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminNodeService } from "./admin-node.service";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { AdminSubscriptionService } from "./admin-subscription.service";
import { AnnouncementPolicyService } from "./announcement-policy.service";
import { AuthSessionService } from "./auth-session.service";
import { ClientAccessService } from "./client-access.service";
import { ClientAuthGuard } from "./client-auth.guard";
import { ClientEventsPublisher } from "./client-events.publisher";
import { ClientRoutingRuleService } from "./client-routing-rule.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { ClientTicketService } from "./client-ticket.service";
import { DevDataBootstrapService } from "./dev-data-bootstrap.service";
import { Global, Module } from "@nestjs/common";
import { DevDataService } from "./dev-data.service";
import { ImageBedService } from "./image-bed.service";
import { DownloadMirrorService } from "./download-mirror.service";
import { ReleaseCenterService } from "./release-center.service";
import { RuntimeComponentsService } from "./runtime-components.service";
import { RuntimeSessionService } from "./runtime-session.service";
import { MeteringIncidentService } from "./metering-incident.service";
import { XuiModule } from "../xui/xui.module";

@Global()
@Module({
  imports: [XuiModule],
  providers: [
    DevDataService,
    AdminRuntimeEventsService,
    AdminNodeService,
    AdminSubscriptionService,
    AnnouncementPolicyService,
    RuntimeComponentsService,
    ClientAccessService,
    ClientEventsPublisher,
    ClientRoutingRuleService,
    MeteringIncidentService,
    AuthSessionService,
    ClientRuntimeEventsService,
    ClientTicketService,
    DevDataBootstrapService,
    ImageBedService,
    DownloadMirrorService,
    ReleaseCenterService,
    RuntimeSessionService,
    ClientAuthGuard,
    AdminAuthGuard
  ],
  exports: [
    DevDataService,
    AdminRuntimeEventsService,
    AdminNodeService,
    AdminSubscriptionService,
    AnnouncementPolicyService,
    RuntimeComponentsService,
    ClientAccessService,
    ClientEventsPublisher,
    ClientRoutingRuleService,
    MeteringIncidentService,
    AuthSessionService,
    ClientRuntimeEventsService,
    ClientTicketService,
    DevDataBootstrapService,
    ImageBedService,
    DownloadMirrorService,
    ReleaseCenterService,
    RuntimeSessionService,
    ClientAuthGuard,
    AdminAuthGuard
  ]
})
export class DevDataModule {}
