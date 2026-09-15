import { Body, Controller, Delete, Get, Query, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { RuntimeVersionService } from "../common/runtime-version.service";
import { listGithubVersionTags } from "../common/runtime-version-files";
class AcquireDto {
  @IsString() @MaxLength(200) componentId!: string;
  @IsString() @MaxLength(2048) sourceUrl!: string;
  @IsOptional() @IsString() @MaxLength(100) version?: string;
  @IsBoolean() autoLatest!: boolean;
}
class PolicyDto { @IsBoolean() enabled!: boolean; }
class CreateSlotDto {
  @IsIn(["xray", "geoip", "geosite"]) kind!: "xray" | "geoip" | "geosite";
  @IsIn(["macos", "windows", "android", "ios"]) platform!: "macos" | "windows" | "android" | "ios";
  @IsIn(["x64", "arm64"]) architecture!: "x64" | "arm64";
  @IsString() @MaxLength(2048) sourceUrl!: string;
}
@Controller("admin/runtime-versions")
@UseGuards(AdminAuthGuard)
export class RuntimeVersionController {
  constructor(private readonly versions: RuntimeVersionService) {}
  @Get("github-tags") tags(@Query("url") url: string) { return listGithubVersionTags(url); }
  @Get(":id/history") history(@Param("id") id: string, @Query("page") page?: string) { return this.versions.history(id, Math.max(0, Math.min(10000, Math.floor(Number(page)) || 0))); }
  @Delete(":id") remove(@Param("id") id: string) { return this.versions.deleteVersion(id); }
  @Get() list() { return this.versions.list(); }
  @Post("acquire") acquire(@Body() dto: AcquireDto) { return this.versions.acquire(dto); }
  @Patch(":id/auto-latest") policy(@Param("id") id: string, @Body() dto: PolicyDto) { return this.versions.setAutoLatest(id, dto.enabled); }
  @Post(":id/activate") activate(@Param("id") id: string) { return this.versions.activate(id); }
  @Post("slots") create(@Body() dto: CreateSlotDto) {
    return this.versions.createSlot(dto);
  }
}
