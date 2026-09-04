import { Controller, Get } from "@nestjs/common";
import { SystemUpdateService } from "../common/system-update.service";

/**
 * Public, dependency-free liveness endpoint.
 *
 * The self-update supervisor (entrypoint) polls this to decide whether a freshly
 * promoted version booted successfully. It must NOT touch the database so a
 * transient DB blip cannot trigger an unnecessary code rollback.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly systemUpdateService: SystemUpdateService) {}

  @Get()
  health() {
    return { status: "ok", version: this.systemUpdateService.getCurrentVersion() };
  }
}
