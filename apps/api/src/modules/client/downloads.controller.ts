import { Controller, Get, NotFoundException, Param, Res, ServiceUnavailableException } from "@nestjs/common";
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
    return sendDownloadFile(response, descriptor.absolutePath, descriptor.fileName, "安装包文件暂不可用");
  }

  @Get("runtime-components/:componentId")
  async downloadRuntimeComponent(@Param("componentId") componentId: string, @Res() response: Response) {
    const descriptor = await this.runtimeComponentsService.getRuntimeComponentDownloadDescriptor(componentId);
    return sendDownloadFile(response, descriptor.absolutePath, descriptor.fileName, "内核组件文件暂不可用");
  }
}

function sendDownloadFile(response: Response, absolutePath: string, fileName: string, unavailableMessage: string) {
  return new Promise<void>((resolve, reject) => {
    response.download(absolutePath, fileName, (error) => {
      if (!error) {
        resolve();
        return;
      }
      if (response.headersSent) {
        resolve();
        return;
      }
      reject(mapDownloadError(error, unavailableMessage));
    });
  });
}

function mapDownloadError(error: Error & { code?: string }, unavailableMessage: string) {
  if (error.code === "ENOENT") {
    return new NotFoundException(unavailableMessage);
  }
  return new ServiceUnavailableException(`${unavailableMessage}，请稍后重试。`);
}
