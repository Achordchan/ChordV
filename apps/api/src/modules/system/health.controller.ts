import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { SystemUpdateService } from "../common/system-update.service";

/**
 * Liveness (`/health`) and readiness (`/health/ready`) endpoints.
 *
 * - Liveness is dependency-free (process is up).
 * - Readiness exercises the database with a trivial query. The self-update
 *   supervisor health-gates a freshly promoted version on READINESS, so a release
 *   that opens its HTTP port but has a broken Prisma runtime / incompatible client
 *   / unusable schema fails the gate and is rolled back, instead of silently
 *   becoming last-good while every authenticated request fails.
 */
@Controller("health")
export class HealthController {
  constructor(
    private readonly systemUpdateService: SystemUpdateService,
    private readonly prisma: PrismaService
  ) {}

  @Get()
  health() {
    return { status: "ok", version: this.systemUpdateService.getCurrentVersion() };
  }

  @Get("ready")
  async ready() {
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
    } catch (error) {
      throw new ServiceUnavailableException(
        `database not ready: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { status: "ready", version: this.systemUpdateService.getCurrentVersion() };
  }
}
