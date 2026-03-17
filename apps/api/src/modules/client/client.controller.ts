import { Body, Controller, Get, Headers, Post } from "@nestjs/common";
import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { ConnectionMode } from "@chordv/shared";
import { ClientService } from "./client.service";

class ConnectDto {
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @IsString()
  @IsIn(["global", "rule", "direct"])
  mode!: ConnectionMode;

  @IsString()
  @IsOptional()
  strategyGroupId?: string;
}

@Controller("client")
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  @Get("bootstrap")
  getBootstrap(@Headers("authorization") authorization?: string) {
    return this.clientService.getBootstrap(authorization);
  }

  @Get("subscription")
  getSubscription(@Headers("authorization") authorization?: string) {
    return this.clientService.getSubscription(authorization);
  }

  @Get("nodes")
  getNodes() {
    return this.clientService.getNodes();
  }

  @Get("policies")
  getPolicies() {
    return this.clientService.getPolicies();
  }

  @Get("announcements")
  getAnnouncements() {
    return this.clientService.getBootstrap().then((result) => result.announcements);
  }

  @Get("version")
  getVersion() {
    return this.clientService.getVersion();
  }

  @Get("runtime")
  getRuntime() {
    return this.clientService.getRuntime();
  }

  @Post("session/connect")
  connect(@Body() body: ConnectDto) {
    return this.clientService.connect(body.nodeId, body.mode, body.strategyGroupId);
  }

  @Post("session/disconnect")
  disconnect() {
    return this.clientService.disconnect();
  }
}
