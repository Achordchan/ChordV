import { Body, Controller, Get, Headers, Post, Query, Sse, UseGuards } from "@nestjs/common";
import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
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
  @IsIn(["beta", "stable"])
  channel!: ReleaseChannel;

  @IsOptional()
  @IsString()
  @IsIn(["dmg", "app", "exe", "setup.exe", "apk", "ipa", "external"])
  artifactType?: ReleaseArtifactType | null;
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
    return this.clientService.getBootstrap(authorization).then((result) => result.announcements);
  }

  @Get("version")
  getVersion() {
    return this.clientService.getVersion();
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
  getRuntime(@Headers("authorization") authorization?: string) {
    return this.clientService.getRuntime(authorization);
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
