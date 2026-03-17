import { Controller, Get, Post } from "@nestjs/common";
import { DevDataService } from "../common/dev-data.service";

@Controller("panels")
export class PanelsController {
  constructor(private readonly devDataService: DevDataService) {}

  @Get("sync-status")
  getSyncStatus() {
    return this.devDataService.getPanels();
  }

  @Post("sync")
  synchronize() {
    return this.devDataService.synchronizePanels();
  }
}
