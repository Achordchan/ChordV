import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import type { AdminSubscriptionLinkStateDto } from "@chordv/shared";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { SubscriptionLinkPublicationService } from "../common/subscription-link-publication.service";
import { SubscriptionLinkService, type SubscriptionLinkState } from "../common/subscription-link.service";

export class SubscriptionLinkSettingsInput {
  @IsOptional() @IsString() @MaxLength(2048) origin!: string | null;
  @IsOptional() @IsString() @MaxLength(2048) backupOrigin!: string | null;
}

// Every response here carries a subscription link, which is a credential: none
// of them may be cached.
@Controller("admin/users")
@UseGuards(AdminAuthGuard)
export class UserSubscriptionLinkController {
  constructor(
    private readonly links: SubscriptionLinkService,
    private readonly publication: SubscriptionLinkPublicationService
  ) {}

  @Get(":userId/subscription-link")
  @Header("Cache-Control", "no-store")
  async get(@Param("userId") userId: string) {
    return this.withDistribution(userId, await this.links.getForUser(userId));
  }

  @Post(":userId/subscription-link")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async ensure(@Param("userId") userId: string) {
    const state = await this.links.ensureForUser(userId);
    this.publication.kick();
    return this.withDistribution(userId, state);
  }

  @Post(":userId/subscription-link/reset")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async reset(@Param("userId") userId: string) {
    const state = await this.links.resetForUser(userId);
    // The old link has to stop being served; do not leave that to the next
    // scheduled pass.
    this.publication.kick();
    return this.withDistribution(userId, state);
  }

  private async withDistribution(userId: string, state: SubscriptionLinkState): Promise<AdminSubscriptionLinkStateDto> {
    return { ...state, distribution: await this.publication.describeForUser(userId) };
  }
}

@Controller("admin/subscription-link-settings")
@UseGuards(AdminAuthGuard)
export class SubscriptionLinkSettingsController {
  constructor(
    private readonly links: SubscriptionLinkService,
    private readonly publication: SubscriptionLinkPublicationService
  ) {}

  /** Whether distribution is on and keeping up — the figure to watch for "links are going stale". */
  @Get("distribution")
  @Header("Cache-Control", "no-store")
  distribution() {
    return this.publication.getStatus();
  }

  @Get()
  @Header("Cache-Control", "no-store")
  get() {
    return this.links.getSettings();
  }

  @Put()
  save(@Body() input: SubscriptionLinkSettingsInput) {
    return this.links.saveSettings({ origin: input.origin ?? null, backupOrigin: input.backupOrigin ?? null });
  }
}
