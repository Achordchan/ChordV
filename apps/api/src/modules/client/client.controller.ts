import { Body, Controller, Get, Headers, Post, UseGuards } from "@nestjs/common";
import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { ConnectionMode } from "@chordv/shared";
import { ClientAuthGuard } from "../common/client-auth.guard";
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

class SessionLeaseDto {
  @IsString()
  @IsNotEmpty()
  sessionId!: string;
}

@Controller("client")
@UseGuards(ClientAuthGuard)
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
  getNodes(@Headers("authorization") authorization?: string) {
    return this.clientService.getNodes(authorization);
  }

  @Get("policies")
  getPolicies() {
    return this.clientService.getPolicies();
  }

  @Get("announcements")
  getAnnouncements(@Headers("authorization") authorization?: string) {
    return this.clientService.getBootstrap(authorization).then((result) => result.announcements);
  }

  @Get("version")
  getVersion(@Headers("authorization") authorization?: string) {
    return this.clientService.getVersion(authorization);
  }

  @Get("runtime")
  getRuntime() {
    return this.clientService.getRuntime();
  }

  @Post("session/connect")
  connect(@Body() body: ConnectDto, @Headers("authorization") authorization?: string) {
    return this.clientService.connect(body.nodeId, body.mode, body.strategyGroupId, authorization);
  }

  @Post("session/heartbeat")
  heartbeat(@Body() body: SessionLeaseDto, @Headers("authorization") authorization?: string) {
    return this.clientService.heartbeat(body.sessionId, authorization);
  }

  @Post("session/disconnect")
  disconnect(@Body() body: SessionLeaseDto, @Headers("authorization") authorization?: string) {
    return this.clientService.disconnect(body.sessionId, authorization);
  }
}
