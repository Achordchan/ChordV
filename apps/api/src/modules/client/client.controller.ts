import { Body, Controller, Get, Headers, Post, Sse, UseGuards } from "@nestjs/common";
import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
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

class ProbeNodesDto {
  @IsArray()
  @IsString({ each: true })
  nodeIds!: string[];
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

  @Post("nodes/probe")
  probeNodes(@Body() body: ProbeNodesDto, @Headers("authorization") authorization?: string) {
    return this.clientService.probeNodes(body.nodeIds ?? [], authorization);
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
  getRuntime(@Headers("authorization") authorization?: string) {
    return this.clientService.getRuntime(authorization);
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

  @Sse("events/stream")
  streamEvents(@Headers("authorization") authorization?: string) {
    return this.clientService.streamEvents(authorization);
  }

  @Sse("events")
  streamEventsAlias(@Headers("authorization") authorization?: string) {
    return this.clientService.streamEvents(authorization);
  }
}
