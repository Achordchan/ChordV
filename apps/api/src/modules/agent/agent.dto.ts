import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested
} from "class-validator";
import type { NodeAgentCommandType } from "@chordv/shared";
import type { NodeControlMode } from "@chordv/shared";

const DECIMAL_INTEGER = /^(0|[1-9]\d*)$/;

export class AgentHeartbeatDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  bootId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  version!: string;

  @IsString()
  @Matches(DECIMAL_INTEGER)
  configRevision!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  queueDepth!: number;

  @IsIn(["unknown", "healthy", "degraded", "offline"])
  xrayStatus!: "unknown" | "healthy" | "degraded" | "offline";
}

export class AgentUsageSampleInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  bindingId!: string;

  @IsString()
  @Matches(DECIMAL_INTEGER)
  counterGeneration!: string;

  @IsString()
  @Matches(DECIMAL_INTEGER)
  @MaxLength(30)
  uplinkBytes!: string;

  @IsString()
  @Matches(DECIMAL_INTEGER)
  @MaxLength(30)
  downlinkBytes!: string;

  @IsString()
  @Matches(DECIMAL_INTEGER)
  @MaxLength(30)
  uplinkDeltaBytes!: string;

  @IsString()
  @Matches(DECIMAL_INTEGER)
  @MaxLength(30)
  downlinkDeltaBytes!: string;
}

export class AgentUsageBatchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  bootId!: string;

  @IsString()
  @Matches(/^[1-9]\d*$/)
  sequence!: string;

  @IsDateString()
  sampledAt!: string;

  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => AgentUsageSampleInputDto)
  samples!: AgentUsageSampleInputDto[];
}

export class AgentCommandResultDto {
  @IsIn(["completed", "failed"])
  status!: "completed" | "failed";

  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  error?: string;
}

export class CreateAgentCredentialDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  agentId?: string;
}

export class QueueAgentCommandDto {
  @IsIn(["ENSURE_USER", "ENABLE_USER", "DISABLE_USER", "REMOVE_USER", "RECONCILE_USERS", "REFRESH_QUOTA"])
  type!: NodeAgentCommandType;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_INTEGER)
  targetRevision?: string;

  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  dedupeKey?: string;
}

export class SwitchNodeControlModeDto {
  @IsIn(["xui_primary", "shadow_direct", "direct_primary", "rollback_pending"])
  targetMode!: NodeControlMode;

  @IsOptional()
  @IsIn([true, false])
  confirmDirect?: boolean;

  @IsOptional()
  @IsIn([true, false])
  confirmRollback?: boolean;

  @IsOptional()
  @IsIn([true, false])
  confirmXuiCalibrated?: boolean;
}
