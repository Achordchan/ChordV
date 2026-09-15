import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
import type { Response } from "express";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { FileMaintenanceService } from "../common/file-maintenance.service";
import { StorageCatalogService } from "../common/storage-catalog.service";
import { ReleaseCenterService } from "../common/release-center.service";
export class CleanupDto { @IsArray() @ArrayMaxSize(100) @IsString({each:true}) ids!: string[]; }
export class ReuseDto {
  @IsString() @MaxLength(128) releaseId!: string;
  @IsString() @MaxLength(128) sourceArtifactId!: string;
  @IsOptional() @IsString() @MaxLength(128) artifactId?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}
@Controller("admin/storage")
@UseGuards(AdminAuthGuard)
export class StorageController {
  constructor(private readonly catalog: StorageCatalogService, private readonly files: FileMaintenanceService, private readonly releases: ReleaseCenterService) {}
  @Get() list(@Query("page") page?: string, @Query("search") search?: string, @Query("cleanupPage") cleanupPage?:string) { return this.catalog.list(Math.max(0,Math.min(100000,Math.floor(Number(page)||0))), (search||"").slice(0,200), Math.max(0,Math.min(100000,Math.floor(Number(cleanupPage)||0)))); }
  @Post("cleanup") cleanup(@Body() dto: CleanupDto) { return this.catalog.cleanup(dto.ids); }
  @Post("cleanup/:id/retry") retry(@Param("id") id: string) { return this.files.retry(id); }
  @Post("reuse-release-file") reuse(@Body() dto: ReuseDto) { return this.releases.reuseReleaseArtifact(dto.releaseId,dto.sourceArtifactId,dto.artifactId,dto.isPrimary); }
  @Post("scan") async scan(@Res() response: Response) {
    const abort = new AbortController();
    const close = () => abort.abort();
    response.once("close",close);
    response.setHeader("Content-Type","text/event-stream");
    response.setHeader("Cache-Control","no-cache, no-transform");
    response.setHeader("X-Accel-Buffering","no"); response.flushHeaders();
    const send = (event: unknown) => { if(!response.destroyed&&!response.writableEnded)response.write(`data: ${JSON.stringify(event)}\n\n`); };
    const heartbeat = setInterval(()=>{if(!response.destroyed&&!response.writableEnded)response.write(": keep-alive\n\n");},15000);
    try { send({type:"progress",checked:0,message:"正在读取文件索引"}); send({type:"complete",snapshot:await this.catalog.scan(AbortSignal.any([abort.signal,AbortSignal.timeout(10*60_000)]),value=>send({type:"progress",...value}))}); }
    catch(error) { send({type:"error",message:error instanceof Error?error.message:"扫描失败"}); }
    finally { clearInterval(heartbeat);response.off("close",close);response.end(); }
  }
}
