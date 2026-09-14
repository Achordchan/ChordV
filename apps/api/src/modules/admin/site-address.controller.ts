import { Body, Controller, Get, Header, Put, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsString, MaxLength } from "class-validator";
import { SiteAddressService } from "../common/site-address.service";
import { AdminAuthGuard } from "../common/admin-auth.guard";

export class SiteAddressInput {
  @IsString() @MaxLength(2048) primaryOrigin!: string;
  @IsArray() @ArrayMaxSize(10) @IsString({each:true}) @MaxLength(2048,{each:true}) legacyOrigins!: string[];
}
@Controller("admin/site-address")
@UseGuards(AdminAuthGuard)
export class SiteAddressController {
  constructor(private readonly sites: SiteAddressService) {}
  @Get() @Header("Cache-Control","no-store") get() { return this.sites.get(); }
  @Put() save(@Body() input: SiteAddressInput) { return this.sites.save(input); }
}

// Discovery is public so clients can resolve a migration before authenticating.
// It contains no credentials and does not redirect legacy requests.
@Controller("client/site-address")
export class ClientSiteAddressController {
  constructor(private readonly sites: SiteAddressService) {}
  @Get() @Header("Cache-Control","no-store") get() { return this.sites.get(); }
}
