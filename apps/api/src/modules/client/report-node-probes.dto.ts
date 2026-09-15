import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";

export class NodeProbeObservationDto {
  @IsString() @MaxLength(128) nodeId!: string;
  @IsIn(["healthy", "offline"]) status!: "healthy" | "offline";
  @IsOptional() @IsInt() @Min(1) @Max(60000) latencyMs!: number | null;
}
export class ReportNodeProbesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(32)
  @ValidateNested({ each: true }) @Type(() => NodeProbeObservationDto)
  results!: NodeProbeObservationDto[];
}
