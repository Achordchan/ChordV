import { Controller, Get } from "@nestjs/common";
import { SystemUpdateService } from "../common/system-update.service";

/**
 * Liveness (`/health`) and readiness (`/health/ready`) endpoints.
 *
 * - Liveness is dependency-free (process is up).
 * - Readiness delegates to SystemUpdateService.assertReady(), which verifies DB
 *   connectivity AND that the running release's schema is present. The self-update
 *   supervisor gates a freshly promoted version on readiness, so a release that
 *   opens its port but has a broken Prisma runtime / missing migration is rolled
 *   back instead of silently becoming last-good. assertReady throws a GENERIC 503
 *   (details only in server logs) — this endpoint is unauthenticated.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly systemUpdateService: SystemUpdateService) {}

  @Get()
  health() {
    return { status: "ok", version: this.systemUpdateService.getCurrentVersion() };
  }

  @Get("ready")
  async ready() {
    await this.systemUpdateService.assertReady();
    return { status: "ready", version: this.systemUpdateService.getCurrentVersion() };
  }
}
