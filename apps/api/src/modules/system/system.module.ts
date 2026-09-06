import { Module } from "@nestjs/common";
import { DevDataModule } from "../common/dev-data.module";
import { SystemUpdateService } from "../common/system-update.service";
import { HealthController } from "./health.controller";
import { SystemUpdateController } from "./system-update.controller";

// DevDataModule (@Global) owns and exports DownloadMirrorService, which
// SystemUpdateService injects. Import it explicitly so the dependency is visible
// here rather than relying on the global registration as an implicit side effect.
@Module({
  imports: [DevDataModule],
  controllers: [HealthController, SystemUpdateController],
  providers: [SystemUpdateService],
  exports: [SystemUpdateService]
})
export class SystemModule {}
