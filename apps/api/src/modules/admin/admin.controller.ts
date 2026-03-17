import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import type { UpdatePanelInputDto, UpdateSubscriptionInputDto } from "@chordv/shared";
import { DevDataService } from "../common/dev-data.service";

@Controller("admin")
export class AdminController {
  constructor(private readonly devDataService: DevDataService) {}

  @Get("snapshot")
  getSnapshot() {
    return this.devDataService.getAdminSnapshot();
  }

  @Get("users")
  getUsers() {
    return this.devDataService.getUsers();
  }

  @Get("subscriptions")
  getSubscriptions() {
    return this.devDataService.getAdminSubscriptions();
  }

  @Patch("subscriptions/:id")
  updateSubscription(@Param("id") id: string, @Body() input: UpdateSubscriptionInputDto) {
    return this.devDataService.updateSubscription(id, input);
  }

  @Get("panels")
  getPanels() {
    return this.devDataService.getAdminPanels();
  }

  @Patch("panels/:id")
  updatePanel(@Param("id") id: string, @Body() input: UpdatePanelInputDto) {
    return this.devDataService.updatePanel(id, input);
  }

  @Post("panels/sync")
  synchronizePanels() {
    return this.devDataService.synchronizePanels();
  }

  @Post("panels/:id/sync")
  synchronizePanel(@Param("id") id: string) {
    return this.devDataService.synchronizePanel(id);
  }
}
