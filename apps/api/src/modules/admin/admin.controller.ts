import { Body, Controller, Get, Post } from "@nestjs/common";
import type { ImportNodeInputDto } from "@chordv/shared";
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

  @Get("nodes")
  getNodes() {
    return this.devDataService.getAdminNodes();
  }

  @Post("nodes/import")
  importNode(@Body() input: ImportNodeInputDto) {
    return this.devDataService.importNodeFromSubscription(input);
  }
}
