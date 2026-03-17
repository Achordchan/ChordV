import { Controller, Get } from "@nestjs/common";
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
}
