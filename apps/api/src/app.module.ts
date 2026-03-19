import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AdminModule } from "./modules/admin/admin.module";
import { AnnouncementsModule } from "./modules/announcements/announcements.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ClientModule } from "./modules/client/client.module";
import { DevDataModule } from "./modules/common/dev-data.module";
import { EdgeGatewayModule } from "./modules/edge-gateway/edge-gateway.module";
import { PrismaModule } from "./modules/common/prisma.module";
import { UsageModule } from "./modules/usage/usage.module";

@Module({
  imports: [
    PrismaModule,
    ScheduleModule.forRoot(),
    DevDataModule,
    EdgeGatewayModule,
    AuthModule,
    ClientModule,
    AnnouncementsModule,
    AdminModule,
    UsageModule
  ]
})
export class AppModule {}
