import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { DevDataService } from "../common/dev-data.service";
import { RuntimeComponentsService } from "../common/runtime-components.service";

@Controller("downloads")
export class DownloadsController {
  constructor(
    private readonly devDataService: DevDataService,
    private readonly runtimeComponentsService: RuntimeComponentsService
  ) {}

  @Get("releases/:artifactId")
  async downloadReleaseArtifact(@Param("artifactId") artifactId: string, @Res() response: Response) {
    const descriptor = await this.devDataService.getReleaseArtifactDownloadDescriptor(artifactId);
    return response.download(descriptor.absolutePath, descriptor.fileName);
  }

  @Get("runtime-components/:componentId")
  async downloadRuntimeComponent(@Param("componentId") componentId: string, @Res() response: Response) {
    const descriptor = await this.runtimeComponentsService.getRuntimeComponentDownloadDescriptor(componentId);
    return response.download(descriptor.absolutePath, descriptor.fileName);
  }
}
