import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { DevDataService } from "../common/dev-data.service";

@Controller("downloads")
export class DownloadsController {
  constructor(private readonly devDataService: DevDataService) {}

  @Get("releases/:artifactId")
  async downloadReleaseArtifact(@Param("artifactId") artifactId: string, @Res() response: Response) {
    const descriptor = await this.devDataService.getReleaseArtifactDownloadDescriptor(artifactId);
    return response.download(descriptor.absolutePath, descriptor.fileName);
  }
}
