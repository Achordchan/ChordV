import { Controller, Get, Headers, UseGuards } from "@nestjs/common";
import { DevDataService } from "../common/dev-data.service";
import { ClientAuthGuard } from "../common/client-auth.guard";

@Controller("announcements")
export class AnnouncementsController {
  constructor(private readonly devDataService: DevDataService) {}

  @Get()
  @UseGuards(ClientAuthGuard)
  getAll(@Headers("authorization") authorization?: string) {
    return this.devDataService.getAnnouncements(authorization);
  }
}
