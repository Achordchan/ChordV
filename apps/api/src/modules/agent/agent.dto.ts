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

const DECIMAL_INTEGER = /^(0|[1-9]\d*)$/;

export interface AgentRegisterResultDto {
  accepted: boolean;
  agentId: string;
  nodeId: string;
}

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

export class AgentRegisterDto {
  // One-time registration token from the install command.
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  registerToken!: string;

  // CLIENT-GENERATED persistent credential (chordv_agent_ prefix, >=32 bytes of
  // entropy). The agent already holds the plaintext; the server stores only its
  // hash. Replaying the same registration (response lost between commit and the
  // agent's local persistence) is then IDEMPOTENT: the hash already exists, so
  // the retry returns the same identity instead of bricking the node.
  @IsString()
  @Matches(/^chordv_agent_[A-Za-z0-9_-]{43,128}$/)
  agentToken!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  hostname!: string;

  @IsIn(["linux-x64", "linux-arm64"])
  arch!: "linux-x64" | "linux-arm64";

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  agentVersion!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  xrayVersion?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  bootId!: string;
}

export class CreateAgentCredentialDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  agentId?: string;
}

export class QueueAgentCommandDto {
  @IsIn(["ENSURE_USER", "ENABLE_USER", "DISABLE_USER", "REMOVE_USER", "RECONCILE_USERS", "REFRESH_QUOTA", "ENSURE_INBOUND"])
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

  /**
   * Compare-and-swap guard for ENSURE_INBOUND: the applied revision the
   * submitting form was built from. A client-side comparison cannot prevent
   * the race — an idle open form never learns that another administrator's
   * deployment completed — so the server rejects the enqueue when the node's
   * applied revision has moved past it, atomically inside the same Node-row
   * lock that serializes completions.
   */
  @IsOptional()
  @IsString()
  @Matches(DECIMAL_INTEGER)
  expectedInboundAppliedRevision?: string;
}

