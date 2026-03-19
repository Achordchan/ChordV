import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsISO8601, IsNotEmpty, IsNumberString, IsObject, IsOptional, IsString, ValidateNested } from "class-validator";

export class EdgeRelayNodeDto {
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @IsString()
  @IsNotEmpty()
  serverHost!: string;

  @Type(() => Number)
  serverPort!: number;

  @IsString()
  @IsNotEmpty()
  uuid!: string;

  @IsString()
  @IsNotEmpty()
  flow!: string;

  @IsString()
  @IsNotEmpty()
  realityPublicKey!: string;

  @IsString()
  @IsNotEmpty()
  shortId!: string;

  @IsString()
  @IsNotEmpty()
  serverName!: string;

  @IsString()
  @IsNotEmpty()
  fingerprint!: string;

  @IsString()
  @IsNotEmpty()
  spiderX!: string;
}

export class EdgeSessionOpenDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @IsString()
  @IsNotEmpty()
  leaseId!: string;

  @IsString()
  @IsNotEmpty()
  subscriptionId!: string;

  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => EdgeRelayNodeDto)
  node!: EdgeRelayNodeDto;

  @IsString()
  @IsNotEmpty()
  xrayUserEmail!: string;

  @IsString()
  @IsNotEmpty()
  xrayUserUuid!: string;

  @IsISO8601()
  expiresAt!: string;
}

export class EdgeSessionCloseDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @IsString()
  @IsNotEmpty()
  leaseId!: string;

  @IsString()
  @IsNotEmpty()
  nodeId!: string;
}

export class EdgeTrafficRecordDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @IsString()
  @IsNotEmpty()
  leaseId!: string;

  @IsString()
  @IsNotEmpty()
  xrayUserEmail!: string;

  @IsString()
  @IsNotEmpty()
  xrayUserUuid!: string;

  @IsNumberString()
  uplinkBytes!: string;

  @IsNumberString()
  downlinkBytes!: string;

  @IsISO8601()
  sampledAt!: string;
}

export class EdgeTrafficReportDto {
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @IsISO8601()
  reportedAt!: string;

  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => EdgeTrafficRecordDto)
  records!: EdgeTrafficRecordDto[];
}

export class EdgeGatewayStatusDto {
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @IsOptional()
  @IsString()
  gatewayStatus?: "online" | "offline" | "degraded";
}
