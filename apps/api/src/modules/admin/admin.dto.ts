import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested, registerDecorator } from "class-validator";
import type {
  ClientRuntimeComponentFailureReportInputDto,
  AnnouncementDisplayMode,
  AnnouncementLevel,
  ConnectionMode,
  PlanScope,
  PlatformTarget,
  ReleaseArtifactType,
  ReleaseChannel,
  ReleaseStatus,
  RuntimeComponentArchitecture,
  RuntimeComponentKind,
  RuntimeComponentSource,
  RuntimeDownloadFailureReason,
  SubscriptionState,
  TeamMemberRole,
  TeamStatus,
  UpdateDeliveryMode,
  UserRole,
  UserStatus
} from "@chordv/shared";

function transformOptionalBoolean(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return value;
}

function transformTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : value;
}

function transformBlankStringToNull(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @IsNotEmpty()
  displayName!: string;

  @IsIn(["user", "admin"])
  role!: UserRole;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxConcurrentSessionsOverride?: number | null;
}

export class UpdateCurrentAdminSecurityDto {
  @IsString()
  @MinLength(8)
  currentPassword!: string;

  @IsEmail()
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  newPassword?: string;
}

export class UpdateUserDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  displayName?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["user", "admin"])
  role?: UserRole;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["active", "disabled"])
  status?: UserStatus;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxConcurrentSessionsOverride?: number | null;
}

export class CreatePlanDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(["personal", "team"])
  scope!: PlanScope;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalTrafficGb!: number;

  @IsBoolean()
  renewable!: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxConcurrentSessions?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePlanDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["personal", "team"])
  scope?: PlanScope;

  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalTrafficGb?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  renewable?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxConcurrentSessions?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePlanSecurityDto {
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxConcurrentSessions!: number;
}

export class UpdateUserSecurityDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxConcurrentSessionsOverride?: number | null;
}

export class UpdateImageBedConfigDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  baseUrl?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(512)
  apiToken?: string | null;

  @ValidateIf((_object, value) => value !== undefined)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(160)
  uploadFolder?: string | null;

  @ValidateIf((_object, value) => value !== undefined)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(40)
  uploadChannel?: string | null;

  @ValidateIf((_object, value) => value !== undefined)
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(80)
  channelName?: string | null;
}

export class ListImageBedFilesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  start?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  count?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  dir?: string;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  recursive?: boolean;
}

export class DeleteImageBedFileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  path!: string;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  folder?: boolean;
}

export class CreateSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  planId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalTrafficGb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  usedTrafficGb?: number;

  @IsString()
  @IsNotEmpty()
  @IsDateString()
  expireAt!: string;

  @IsOptional()
  @IsIn(["active", "expired", "exhausted", "paused"])
  state?: SubscriptionState;
}

export class RenewSubscriptionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsDateString()
  expireAt?: string;

  @IsOptional()
  @IsBoolean()
  resetTraffic?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalTrafficGb?: number;
}

export class ChangeSubscriptionPlanDto {
  @IsString()
  @IsNotEmpty()
  planId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalTrafficGb?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsDateString()
  expireAt?: string;
}

export class UpdateSubscriptionDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalTrafficGb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  usedTrafficGb?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsDateString()
  expireAt?: string;

  @IsOptional()
  @IsIn(["active", "expired", "exhausted", "paused"])
  state?: SubscriptionState;
}

export class ConvertSubscriptionToTeamDto {
  @IsString()
  @IsNotEmpty()
  targetTeamId!: string;
}

export class UpdateSubscriptionNodeAccessDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Transform(({ value }) => (Array.isArray(value) ? value.map((item) => transformTrimmedString(item)) : value))
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(64, { each: true })
  nodeIds!: string[];
}

export class CreateTeamDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  ownerUserId!: string;

  @IsOptional()
  @IsIn(["active", "disabled"])
  status?: TeamStatus;
}

export class UpdateTeamDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  ownerUserId?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["active", "disabled"])
  status?: TeamStatus;
}

export class CreateTeamMemberDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsOptional()
  @IsIn(["owner", "member"])
  role?: TeamMemberRole;
}

export class UpdateTeamMemberDto {
  @IsOptional()
  @IsIn(["owner", "member"])
  role?: TeamMemberRole;
}

export class KickTeamMemberDto {
  @IsOptional()
  @IsBoolean()
  disableAccount?: boolean;
}

export class CreateTeamSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  planId!: string;

  @IsString()
  @IsNotEmpty()
  @IsDateString()
  expireAt!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalTrafficGb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  usedTrafficGb?: number;

}

export class ImportNodeDto {
  @IsOptional()
  @IsUrl({
    require_tld: false
  })
  subscriptionUrl?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{2}$/i)
  countryCode?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  region?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  provider?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  recommended?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformBlankStringToNull(value))
  @IsUrl({
    require_tld: false
  })
  panelBaseUrl?: string;

  @IsOptional()
  @IsString()
  panelApiBasePath?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  panelUsername?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  panelPassword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  panelInboundId?: number;

  @IsOptional()
  @IsBoolean()
  panelEnabled?: boolean;
}

export class UpdateNodeDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{2}$/i)
  countryCode?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  region?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  provider?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  recommended?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsUrl({
    require_tld: false
  })
  subscriptionUrl?: string;

  @IsOptional()
  @Transform(({ value }) => transformBlankStringToNull(value))
  @IsUrl({
    require_tld: false
  })
  panelBaseUrl?: string | null;

  @IsOptional()
  @IsString()
  panelApiBasePath?: string | null;

  @IsOptional()
  @IsString()
  panelUsername?: string | null;

  @IsOptional()
  @IsString()
  panelPassword?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  panelInboundId?: number | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  panelEnabled?: boolean;
}

export class ReadNodePanelInboundsDto {
  @IsUrl({
    require_tld: false
  })
  panelBaseUrl!: string;

  @IsOptional()
  @IsString()
  panelApiBasePath?: string;

  @IsString()
  @IsNotEmpty()
  panelUsername!: string;

  @IsString()
  @IsNotEmpty()
  panelPassword!: string;
}

export class CreateAnnouncementDto {
  @Transform(({ value }) => transformTrimmedString(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @Transform(({ value }) => transformTrimmedString(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;

  @IsIn(["info", "warning", "success"])
  level!: AnnouncementLevel;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @IsDateString()
  publishedAt?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsIn(["passive", "modal_confirm", "modal_countdown"])
  displayMode?: AnnouncementDisplayMode;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(0)
  countdownSeconds?: number;
}

export class UpdateAnnouncementDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => transformTrimmedString(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => transformTrimmedString(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["info", "warning", "success"])
  level?: AnnouncementLevel;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @IsDateString()
  publishedAt?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["passive", "modal_confirm", "modal_countdown"])
  displayMode?: AnnouncementDisplayMode;

  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(0)
  countdownSeconds?: number;
}

export class ResetSubscriptionTrafficDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => transformTrimmedString(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  userId?: string;
}

export class ListRuntimeComponentFailuresDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ReplySupportTicketDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class ReplySupportTicketAttachmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  body?: string | null;
}

export class CreateReleaseDto {
  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsIn(["stable"])
  channel!: ReleaseChannel;

  @IsString()
  @IsNotEmpty()
  @Matches(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  version!: string;

  @IsOptional()
  @IsString()
  displayTitle?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  changelog?: string[];

  @IsString()
  @IsNotEmpty()
  @Matches(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  minimumVersion!: string;

  @IsOptional()
  @IsBoolean()
  forceUpgrade?: boolean;

  @IsOptional()
  @IsIn(["draft", "published"])
  status?: Extract<ReleaseStatus, "draft" | "published">;

  @IsOptional()
  @IsString()
  @IsDateString()
  publishedAt?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateReleaseArtifactDto)
  initialArtifact?: CreateReleaseArtifactDto | null;
}

export class UpdateReleaseDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  displayTitle?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  changelog?: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @Matches(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  minimumVersion?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  forceUpgrade?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["draft", "published"])
  status?: Extract<ReleaseStatus, "draft" | "published">;

  @IsOptional()
  @IsString()
  @IsDateString()
  publishedAt?: string | null;
}

export class ListReleasesDto {
  @IsOptional()
  @IsIn(["macos", "windows", "android", "ios"])
  platform?: PlatformTarget;

  @IsOptional()
  @IsIn(["draft", "published", "archived"])
  status?: ReleaseStatus;
}

export class CreateReleaseArtifactDto {
  @IsOptional()
  @IsIn(["external"])
  source?: "external";

  @IsIn(["dmg", "app", "exe", "setup.exe", "zip", "apk", "ipa", "external"])
  type!: ReleaseArtifactType;

  @IsOptional()
  @IsIn(["desktop_installer_download", "desktop_full_replace", "apk_download", "external_download", "none"])
  deliveryMode?: UpdateDeliveryMode;

  @IsUrl({
    require_tld: false
  })
  downloadUrl!: string;

  @IsOptional()
  @IsString()
  defaultMirrorPrefix?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "allowClientMirror must be a boolean value"
  })
  allowClientMirror?: boolean;

  @IsOptional()
  @IsString()
  fileName?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "isPrimary must be a boolean value"
  })
  isPrimary?: boolean;

}

export class UpdateReleaseArtifactDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["uploaded", "external"])
  source?: "uploaded" | "external";

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["dmg", "app", "exe", "setup.exe", "zip", "apk", "ipa", "external"])
  type?: ReleaseArtifactType;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["desktop_installer_download", "desktop_full_replace", "apk_download", "external_download", "none"])
  deliveryMode?: UpdateDeliveryMode;

  @ValidateIf((_object, value) => value !== undefined)
  @IsUrl({
    require_tld: false
  })
  downloadUrl?: string;

  @IsOptional()
  @IsString()
  defaultMirrorPrefix?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "allowClientMirror must be a boolean value"
  })
  allowClientMirror?: boolean;

  @IsOptional()
  @IsString()
  fileName?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "isPrimary must be a boolean value"
  })
  isPrimary?: boolean;

}

export class UploadReleaseArtifactDto {
  @IsOptional()
  @IsIn(["uploaded"])
  source?: "uploaded";

  @IsIn(["dmg", "app", "exe", "setup.exe", "zip", "apk", "ipa", "external"])
  type!: ReleaseArtifactType;

  @IsOptional()
  @IsIn(["desktop_installer_download", "desktop_full_replace", "apk_download", "external_download", "none"])
  deliveryMode?: UpdateDeliveryMode;

  @IsOptional()
  @IsString()
  defaultMirrorPrefix?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "allowClientMirror must be a boolean value"
  })
  allowClientMirror?: boolean;

  @IsOptional()
  @IsString()
  fileName?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "isPrimary must be a boolean value"
  })
  isPrimary?: boolean;

}

export class CreateRuntimeComponentDto {
  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsIn(["x64", "arm64"])
  architecture!: RuntimeComponentArchitecture;

  @IsIn(["xray", "geoip", "geosite"])
  kind!: RuntimeComponentKind;

  @IsOptional()
  @IsIn(["github_remote", "custom_remote"])
  source?: Exclude<RuntimeComponentSource, "uploaded">;

  @IsOptional()
  @IsUrl({
    require_tld: false
  })
  originUrl?: string;

  @IsOptional()
  @IsString()
  defaultMirrorPrefix?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "allowClientMirror must be a boolean value"
  })
  allowClientMirror?: boolean;

  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @IsOptional()
  @IsString()
  archiveEntryName?: string | null;

  @IsOptional()
  @IsString()
  expectedHash?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "enabled must be a boolean value"
  })
  enabled?: boolean;
}

export class UpdateRuntimeComponentDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["uploaded", "github_remote", "custom_remote"])
  source?: RuntimeComponentSource;

  @IsOptional()
  @IsUrl({
    require_tld: false
  })
  originUrl?: string;

  @IsOptional()
  @IsString()
  defaultMirrorPrefix?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "allowClientMirror must be a boolean value"
  })
  allowClientMirror?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  fileName?: string;

  @IsOptional()
  @IsString()
  archiveEntryName?: string | null;

  @IsOptional()
  @IsString()
  expectedHash?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "enabled must be a boolean value"
  })
  enabled?: boolean;
}

export class UploadRuntimeComponentDto {
  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsIn(["x64", "arm64"])
  architecture!: RuntimeComponentArchitecture;

  @IsIn(["xray", "geoip", "geosite"])
  kind!: RuntimeComponentKind;

  @IsOptional()
  @IsString()
  fileName?: string | null;

  @IsOptional()
  @IsString()
  expectedHash?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "enabled must be a boolean value"
  })
  enabled?: boolean;
}

export class RuntimeComponentsPlanQueryDto {
  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsIn(["x64", "arm64"])
  architecture!: RuntimeComponentArchitecture;

  @IsOptional()
  @IsString()
  clientMirrorPrefix?: string | null;
}

export class ReportRuntimeComponentFailureDto implements ClientRuntimeComponentFailureReportInputDto {
  @IsOptional()
  @IsString()
  componentId?: string | null;

  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsIn(["x64", "arm64"])
  architecture!: RuntimeComponentArchitecture;

  @IsIn(["xray", "geoip", "geosite"])
  kind!: RuntimeComponentKind;

  @IsString()
  @IsNotEmpty()
  reason!: RuntimeDownloadFailureReason | string;

  @IsOptional()
  @IsString()
  message?: string | null;

  @IsOptional()
  @IsString()
  effectiveUrl?: string | null;

  @IsOptional()
  @IsString()
  appVersion?: string | null;
}

export class UpdatePolicyDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["global", "rule", "direct"])
  @IsDefaultModeInModes()
  defaultMode?: ConnectionMode;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(["global", "rule", "direct"], { each: true })
  modes?: ConnectionMode[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  blockAds?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  chinaDirect?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  aiServicesProxy?: boolean;
}

function IsDefaultModeInModes() {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isDefaultModeInModes",
      target: object.constructor,
      propertyName,
      options: {
        message: "defaultMode must be included in modes"
      },
      validator: {
        validate(value: unknown, args) {
          const modes = (args?.object as { modes?: unknown } | undefined)?.modes;
          if (!Array.isArray(modes) || typeof value !== "string") {
            return true;
          }
          return modes.includes(value);
        }
      }
    });
  };
}
