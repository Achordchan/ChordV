import { Transform, Type } from "class-transformer";
import { ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl, Min, MinLength, ValidateNested } from "class-validator";
import type {
  AccessMode,
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

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  displayName?: string;

  @IsOptional()
  @IsIn(["user", "admin"])
  role?: UserRole;

  @IsOptional()
  @IsIn(["active", "disabled"])
  status?: UserStatus;

  @IsOptional()
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
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsIn(["personal", "team"])
  scope?: PlanScope;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalTrafficGb?: number;

  @IsOptional()
  @IsBoolean()
  renewable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxConcurrentSessions?: number;

  @IsOptional()
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
  expireAt!: string;

  @IsOptional()
  @IsIn(["active", "expired", "exhausted", "paused"])
  state?: SubscriptionState;
}

export class RenewSubscriptionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
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
  expireAt?: string;

  @IsOptional()
  @IsIn(["active", "expired", "exhausted", "paused"])
  state?: SubscriptionState;
}

export class UpdateSubscriptionNodeAccessDto {
  @IsArray()
  @IsString({ each: true })
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
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ownerUserId?: string;

  @IsOptional()
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
  recommended?: boolean;

  @IsOptional()
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
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

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
  recommended?: boolean;

  @IsOptional()
  @IsUrl({
    require_tld: false
  })
  subscriptionUrl?: string;

  @IsOptional()
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

  @IsOptional()
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
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  body!: string;

  @IsIn(["info", "warning", "success"])
  level!: AnnouncementLevel;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
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
  @Min(0)
  countdownSeconds?: number;
}

export class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  body?: string;

  @IsOptional()
  @IsIn(["info", "warning", "success"])
  level?: AnnouncementLevel;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
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
  @Min(0)
  countdownSeconds?: number;
}

export class CreateReleaseDto {
  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsIn(["stable"])
  channel!: ReleaseChannel;

  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsString()
  @IsNotEmpty()
  displayTitle!: string;

  @IsOptional()
  @IsString()
  releaseNotes?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  changelog?: string[];

  @IsString()
  @IsNotEmpty()
  minimumVersion!: string;

  @IsOptional()
  @IsBoolean()
  forceUpgrade?: boolean;

  @IsOptional()
  @IsIn(["draft", "published", "archived"])
  status?: ReleaseStatus;

  @IsOptional()
  @IsString()
  publishedAt?: string | null;
}

export class UpdateReleaseDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  displayTitle?: string;

  @IsOptional()
  @IsString()
  releaseNotes?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  changelog?: string[];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  minimumVersion?: string;

  @IsOptional()
  @IsBoolean()
  forceUpgrade?: boolean;

  @IsOptional()
  @IsIn(["draft", "published", "archived"])
  status?: ReleaseStatus;

  @IsOptional()
  @IsString()
  publishedAt?: string | null;
}

export class CreateReleaseArtifactDto {
  @IsOptional()
  @IsIn(["uploaded", "external"])
  source?: "uploaded" | "external";

  @IsIn(["dmg", "app", "exe", "setup.exe", "apk", "ipa", "external"])
  type!: ReleaseArtifactType;

  @IsOptional()
  @IsIn(["desktop_installer_download", "apk_download", "external_download", "none"])
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
  @IsString()
  fileSizeBytes?: string | null;

  @IsOptional()
  @IsString()
  fileHash?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "isPrimary must be a boolean value"
  })
  isPrimary?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "isFullPackage must be a boolean value"
  })
  isFullPackage?: boolean;
}

export class UpdateReleaseArtifactDto {
  @IsOptional()
  @IsIn(["uploaded", "external"])
  source?: "uploaded" | "external";

  @IsOptional()
  @IsIn(["dmg", "app", "exe", "setup.exe", "apk", "ipa", "external"])
  type?: ReleaseArtifactType;

  @IsOptional()
  @IsIn(["desktop_installer_download", "apk_download", "external_download", "none"])
  deliveryMode?: UpdateDeliveryMode;

  @IsOptional()
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
  @IsString()
  fileSizeBytes?: string | null;

  @IsOptional()
  @IsString()
  fileHash?: string | null;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "isPrimary must be a boolean value"
  })
  isPrimary?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "isFullPackage must be a boolean value"
  })
  isFullPackage?: boolean;
}

export class UploadReleaseArtifactDto {
  @IsOptional()
  @IsIn(["uploaded", "external"])
  source?: "uploaded" | "external";

  @IsIn(["dmg", "app", "exe", "setup.exe", "apk", "ipa", "external"])
  type!: ReleaseArtifactType;

  @IsOptional()
  @IsIn(["desktop_installer_download", "apk_download", "external_download", "none"])
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

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsIn([true, false, "true", "false"], {
    message: "isFullPackage must be a boolean value"
  })
  isFullPackage?: boolean;
}

export class CreateRuntimeComponentDto {
  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsIn(["x64", "arm64"])
  architecture!: RuntimeComponentArchitecture;

  @IsIn(["xray", "geoip", "geosite"])
  kind!: RuntimeComponentKind;

  @IsOptional()
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
  @IsOptional()
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

  @IsOptional()
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
  @IsOptional()
  @IsIn(["relay", "xui"])
  accessMode?: AccessMode;

  @IsOptional()
  @IsIn(["global", "rule", "direct"])
  defaultMode?: ConnectionMode;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(["global", "rule", "direct"], { each: true })
  modes?: ConnectionMode[];

  @IsOptional()
  @IsBoolean()
  blockAds?: boolean;

  @IsOptional()
  @IsBoolean()
  chinaDirect?: boolean;

  @IsOptional()
  @IsBoolean()
  aiServicesProxy?: boolean;
}
