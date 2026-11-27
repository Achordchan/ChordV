import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";

export class DomesticProbeResultDto {
  @IsString() @MaxLength(128) nodeId!: string;
  @IsBoolean() tcpOk!: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(60000) tcpLatencyMs!: number | null;
  @IsOptional() @IsString() @MaxLength(300) error!: string | null;
}

export class DomesticProbeReportDto {
  /** Whether the probe's own control target (a well-known domestic site) answered this round. */
  @IsBoolean() controlOk!: boolean;
  @IsArray() @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => DomesticProbeResultDto)
  results!: DomesticProbeResultDto[];
}
