import { Body, Controller, Get, Headers, Param, Post, Query, Sse, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { diskStorage } from "multer";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
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

type UploadedTicketAttachmentFile = {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
};

type MulterCallback = (error: Error | null, filename: string) => void;
const SUPPORT_TICKET_ATTACHMENT_MAX_BYTES = Number(process.env.CHORDV_SUPPORT_TICKET_ATTACHMENT_MAX_BYTES ?? 10 * 1024 * 1024);

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
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
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
  @IsIn(["dmg", "app", "exe", "setup.exe", "zip", "apk", "ipa", "external"])
  artifactType?: ReleaseArtifactType | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  clientMirrorPrefix?: string | null;
}

class VersionQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(["macos", "windows", "android", "ios"])
  platform?: PlatformTarget;
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
  @MaxLength(512)
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
  @MaxLength(80)
  reason!: RuntimeDownloadFailureReason | string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  effectiveUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
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

class ReplySupportTicketAttachmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  body?: string | null;
}

class MarkAnnouncementsReadDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
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
  getBootstrap(@Query() query: VersionQueryDto, @Headers("authorization") authorization?: string) {
    return this.clientService.getBootstrap(authorization, query.platform);
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
  @UseGuards(ClientAuthGuard)
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
  getVersion(@Query() query: VersionQueryDto) {
    return this.clientService.getVersion(query.platform);
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
  @UseGuards(ClientAuthGuard)
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

  @Post("tickets/:ticketId/attachments")
  @UseGuards(ClientAuthGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req: unknown, file: { originalname: string }, callback: MulterCallback) => {
          callback(null, `${randomUUID()}${path.extname(file.originalname || "")}`);
        }
      }),
      limits: {
        fileSize: SUPPORT_TICKET_ATTACHMENT_MAX_BYTES
      }
    })
  )
  replyTicketWithAttachment(
    @Param("ticketId") ticketId: string,
    @Body() body: ReplySupportTicketAttachmentDto,
    @UploadedFile() file: UploadedTicketAttachmentFile | undefined,
    @Headers("authorization") authorization?: string
  ) {
    return this.clientService.replySupportTicketWithAttachment(ticketId, body, file, authorization);
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
  streamEvents(@Headers("authorization") authorization?: string, @Headers("last-event-id") lastEventId?: string) {
    return this.clientService.streamEvents(authorization, lastEventId);
  }

  @Sse("events")
  @UseGuards(ClientAuthGuard)
  streamEventsAlias(@Headers("authorization") authorization?: string, @Headers("last-event-id") lastEventId?: string) {
    return this.clientService.streamEvents(authorization, lastEventId);
  }
}
