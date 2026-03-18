import { Type } from "class-transformer";
import { ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl, Min, MinLength } from "class-validator";
import type {
  AnnouncementDisplayMode,
  AnnouncementLevel,
  ConnectionMode,
  PlanScope,
  SubscriptionState,
  TeamMemberRole,
  TeamStatus,
  UserRole,
  UserStatus
} from "@chordv/shared";

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
  @IsBoolean()
  isActive?: boolean;
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

  @IsOptional()
  @IsBoolean()
  renewable?: boolean;
}

export class RenewSubscriptionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  expireAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  extendDays?: number;

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

  @IsOptional()
  @IsBoolean()
  renewable?: boolean;
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

  @IsOptional()
  @IsBoolean()
  renewable?: boolean;
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

  @IsOptional()
  @IsBoolean()
  renewable?: boolean;
}

export class ImportNodeDto {
  @IsUrl({
    require_tld: false
  })
  subscriptionUrl!: string;

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
  @IsBoolean()
  statsEnabled?: boolean;

  @IsOptional()
  @IsUrl({
    require_tld: false
  })
  statsApiUrl?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  statsApiToken?: string;
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
  @IsBoolean()
  statsEnabled?: boolean;

  @IsOptional()
  @IsUrl({
    require_tld: false
  })
  statsApiUrl?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  statsApiToken?: string;
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

export class UpdatePolicyDto {
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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  currentVersion?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  minimumVersion?: string;

  @IsOptional()
  @IsBoolean()
  forceUpgrade?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  changelog?: string[];

  @IsOptional()
  @IsString()
  downloadUrl?: string;
}
