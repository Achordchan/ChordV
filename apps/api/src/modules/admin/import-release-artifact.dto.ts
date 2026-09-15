import { IsBoolean, IsOptional, IsString, IsUrl, MaxLength } from "class-validator";
export class ImportReleaseArtifactDto {
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @MaxLength(4096)
  sourceUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  artifactId?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
