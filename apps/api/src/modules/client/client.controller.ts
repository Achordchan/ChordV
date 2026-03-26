import { Body, Controller, Get, Headers, Param, Post, Query, Sse, UseGuards } from "@nestjs/common";
import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import type {
  ConnectionMode,
  PlatformTarget,
  ReleaseArtifactType,
  ReleaseChannel,
  RuntimeComponentArchitecture,
  RuntimeComponentKind,
  RuntimeDownloadFailureReason
} from "@chordv/shared";
import { ClientAuthGuard } from "../common/client-auth.guard";
import { RuntimeComponentsService } from "../common/runtime-components.service";
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

class RuntimeQueryDto {
  @IsString()
  @IsOptional()
  sessionId?: string;
}

class ProbeNodesDto {
  @IsArray()
  @IsString({ each: true })
  nodeIds!: string[];
}

class UpdateCheckDto {
  @IsString()
  @IsNotEmpty()
  currentVersion!: string;

  @IsString()
  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsString()
  @IsIn(["stable"])
  channel!: ReleaseChannel;

  @IsOptional()
  @IsString()
  @IsIn(["dmg", "app", "exe", "setup.exe", "apk", "ipa", "external"])
  artifactType?: ReleaseArtifactType | null;

  @IsOptional()
  @IsString()
  clientMirrorPrefix?: string | null;
}

class RuntimeComponentsPlanDto {
  @IsString()
  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsString()
  @IsIn(["x64", "arm64"])
  architecture!: RuntimeComponentArchitecture;

  @IsOptional()
  @IsString()
  clientMirrorPrefix?: string | null;
}

class RuntimeComponentFailureDto {
  @IsOptional()
  @IsString()
  componentId?: string | null;

  @IsString()
  @IsIn(["macos", "windows", "android", "ios"])
  platform!: PlatformTarget;

  @IsString()
  @IsIn(["x64", "arm64"])
  architecture!: RuntimeComponentArchitecture;

  @IsString()
  @IsIn(["xray", "geoip", "geosite"])
  kind!: RuntimeComponentKind;

  @IsString()
  @IsNotEmpty()
  reason!: RuntimeDownloadFailureReason | string;

  @IsOptional()
  @IsString()
  message?: string | null;

  @IsOptional()
  @IsString()
  effectiveUrl?: string | null;

  @IsOptional()
  @IsString()
  appVersion?: string | null;
}

class CreateSupportTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}

class ReplySupportTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}

class MarkAnnouncementsReadDto {
  @IsArray()
  @IsString({ each: true })
  announcementIds!: string[];

  @IsString()
  @IsIn(["seen", "ack"])
  action!: "seen" | "ack";
}

@Controller("client")
export class ClientController {
  constructor(
    private readonly clientService: ClientService,
    private readonly runtimeComponentsService: RuntimeComponentsService
  ) {}

  @Get("bootstrap")
  @UseGuards(ClientAuthGuard)
  getBootstrap(@Headers("authorization") authorization?: string) {
    return this.clientService.getBootstrap(authorization);
  }

  @Get("subscription")
  @UseGuards(ClientAuthGuard)
  getSubscription(@Headers("authorization") authorization?: string) {
    return this.clientService.getSubscription(authorization);
  }

  @Get("nodes")
  @UseGuards(ClientAuthGuard)
  getNodes(@Headers("authorization") authorization?: string) {
    return this.clientService.getNodes(authorization);
  }

  @Post("nodes/probe")
  @UseGuards(ClientAuthGuard)
  probeNodes(@Body() body: ProbeNodesDto, @Headers("authorization") authorization?: string) {
    return this.clientService.probeNodes(body.nodeIds ?? [], authorization);
  }

  @Get("policies")
  getPolicies() {
    return this.clientService.getPolicies();
  }

  @Get("announcements")
  @UseGuards(ClientAuthGuard)
  getAnnouncements(@Headers("authorization") authorization?: string) {
    return this.clientService.getAnnouncements(authorization);
  }

  @Post("announcements/read")
  @UseGuards(ClientAuthGuard)
  markAnnouncementsRead(@Body() body: MarkAnnouncementsReadDto, @Headers("authorization") authorization?: string) {
    return this.clientService.markAnnouncementsRead(body, authorization);
  }

  @Get("version")
  getVersion() {
    return this.clientService.getVersion();
  }

  @Get("ping")
  @UseGuards(ClientAuthGuard)
  ping(@Headers("authorization") authorization?: string) {
    return this.clientService.ping(authorization);
  }

  @Post("update/check")
  checkUpdate(@Body() body: UpdateCheckDto) {
    return this.clientService.checkUpdate(body);
  }

  @Get("runtime-components/plan")
  getRuntimeComponentsPlan(@Query() query: RuntimeComponentsPlanDto) {
    return this.runtimeComponentsService.getClientRuntimeComponentsPlan({
      platform: query.platform,
      architecture: query.architecture,
      clientMirrorPrefix: query.clientMirrorPrefix ?? null
    });
  }

  @Post("runtime-components/report-failure")
  reportRuntimeComponentFailure(@Body() body: RuntimeComponentFailureDto, @Headers("authorization") authorization?: string) {
    return this.runtimeComponentsService.reportRuntimeComponentFailure(body, authorization);
  }

  @Get("runtime")
  @UseGuards(ClientAuthGuard)
  getRuntime(@Query() query: RuntimeQueryDto, @Headers("authorization") authorization?: string) {
    return this.clientService.getRuntime(query.sessionId, authorization);
  }

  @Get("tickets")
  @UseGuards(ClientAuthGuard)
  getTickets(@Headers("authorization") authorization?: string) {
    return this.clientService.listSupportTickets(authorization);
  }

  @Get("tickets/:ticketId")
  @UseGuards(ClientAuthGuard)
  getTicket(@Param("ticketId") ticketId: string, @Headers("authorization") authorization?: string) {
    return this.clientService.getSupportTicket(ticketId, authorization);
  }

  @Post("tickets/:ticketId/read")
  @UseGuards(ClientAuthGuard)
  markTicketRead(@Param("ticketId") ticketId: string, @Headers("authorization") authorization?: string) {
    return this.clientService.markSupportTicketRead(ticketId, authorization);
  }

  @Post("tickets")
  @UseGuards(ClientAuthGuard)
  createTicket(@Body() body: CreateSupportTicketDto, @Headers("authorization") authorization?: string) {
    return this.clientService.createSupportTicket(body, authorization);
  }

  @Post("tickets/:ticketId/replies")
  @UseGuards(ClientAuthGuard)
  replyTicket(
    @Param("ticketId") ticketId: string,
    @Body() body: ReplySupportTicketDto,
    @Headers("authorization") authorization?: string
  ) {
    return this.clientService.replySupportTicket(ticketId, body, authorization);
  }

  @Post("session/connect")
  @UseGuards(ClientAuthGuard)
  connect(@Body() body: ConnectDto, @Headers("authorization") authorization?: string) {
    return this.clientService.connect(body.nodeId, body.mode, body.strategyGroupId, authorization);
  }

  @Post("session/heartbeat")
  @UseGuards(ClientAuthGuard)
  heartbeat(@Body() body: SessionLeaseDto, @Headers("authorization") authorization?: string) {
    return this.clientService.heartbeat(body.sessionId, authorization);
  }

  @Post("session/disconnect")
  @UseGuards(ClientAuthGuard)
  disconnect(@Body() body: SessionLeaseDto, @Headers("authorization") authorization?: string) {
    return this.clientService.disconnect(body.sessionId, authorization);
  }

  @Sse("events/stream")
  @UseGuards(ClientAuthGuard)
  streamEvents(@Headers("authorization") authorization?: string) {
    return this.clientService.streamEvents(authorization);
  }

  @Sse("events")
  @UseGuards(ClientAuthGuard)
  streamEventsAlias(@Headers("authorization") authorization?: string) {
    return this.clientService.streamEvents(authorization);
  }
}
