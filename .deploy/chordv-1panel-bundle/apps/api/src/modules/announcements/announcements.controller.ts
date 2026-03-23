import { Controller, Get } from "@nestjs/common";
import { DevDataService } from "../common/dev-data.service";

@Controller("announcements")
export class AnnouncementsController {
  constructor(private readonly devDataService: DevDataService) {}

  @Get()
  getAll() {
    return this.devDataService.getAnnouncements();
  }
}
