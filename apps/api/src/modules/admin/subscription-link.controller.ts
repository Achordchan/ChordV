import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { SubscriptionLinkService } from "../common/subscription-link.service";

export class SubscriptionLinkSettingsInput {
  @IsOptional() @IsString() @MaxLength(2048) origin!: string | null;
  @IsOptional() @IsString() @MaxLength(2048) backupOrigin!: string | null;
}

// Every response here carries a subscription link, which is a credential: none
// of them may be cached.
@Controller("admin/users")
@UseGuards(AdminAuthGuard)
export class UserSubscriptionLinkController {
  constructor(private readonly links: SubscriptionLinkService) {}

  @Get(":userId/subscription-link")
  @Header("Cache-Control", "no-store")
  get(@Param("userId") userId: string) {
    return this.links.getForUser(userId);
  }

  @Post(":userId/subscription-link")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  ensure(@Param("userId") userId: string) {
    return this.links.ensureForUser(userId);
  }

  @Post(":userId/subscription-link/reset")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  reset(@Param("userId") userId: string) {
    return this.links.resetForUser(userId);
  }
}

@Controller("admin/subscription-link-settings")
@UseGuards(AdminAuthGuard)
export class SubscriptionLinkSettingsController {
  constructor(private readonly links: SubscriptionLinkService) {}

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
