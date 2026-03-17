import { Module } from "@nestjs/common";
import { AdminModule } from "./modules/admin/admin.module";
import { AnnouncementsModule } from "./modules/announcements/announcements.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ClientModule } from "./modules/client/client.module";
import { DevDataModule } from "./modules/common/dev-data.module";
import { PrismaModule } from "./modules/common/prisma.module";
import { PanelsModule } from "./modules/panels/panels.module";

@Module({
  imports: [PrismaModule, DevDataModule, AuthModule, ClientModule, AnnouncementsModule, PanelsModule, AdminModule]
})
export class AppModule {}
