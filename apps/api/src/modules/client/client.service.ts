import { Injectable } from "@nestjs/common";
import type {
  ClientPingDto,
  PlatformTarget,
  ClientUpdateCheckDto,
  CreateClientRoutingRuleInputDto,
  CreateClientSupportTicketInputDto,
  MarkClientAnnouncementsReadInputDto,
  ReplyClientSupportTicketInputDto,
  UpdateClientRoutingRuleInputDto
} from "@chordv/shared";
import { DevDataService } from "../common/dev-data.service";
import type { UploadedTicketAttachmentFile } from "../common/image-bed.service";

@Injectable()
export class ClientService {
  constructor(private readonly devDataService: DevDataService) {}

  getBootstrap(token?: string, platform?: PlatformTarget) {
    return this.devDataService.getBootstrap(token, platform);
  }

  getSubscription(token?: string) {
    return this.devDataService.getSubscription(token);
  }

  getNodes(token?: string) {
    return this.devDataService.getNodes(token);
  }

  probeNodes(nodeIds: string[], token?: string) {
    return this.devDataService.probeClientNodes(nodeIds, token);
  }

  getPolicies() {
    return this.devDataService.getPolicies();
  }

  getAnnouncements(token?: string) {
    return this.devDataService.getAnnouncements(token);
  }

  markAnnouncementsRead(input: MarkClientAnnouncementsReadInputDto, token?: string) {
    return this.devDataService.markClientAnnouncementsRead(input, token);
  }

  getVersion(platform?: PlatformTarget) {
    return this.devDataService.getClientVersion(platform);
  }

  ping(token?: string): Promise<ClientPingDto> {
    return this.devDataService.pingClient(token);
  }

  checkUpdate(input: ClientUpdateCheckDto) {
    return this.devDataService.checkClientUpdate(input);
  }

  listRoutingRules(token?: string) {
    return this.devDataService.listClientRoutingRules(token);
  }

  createRoutingRule(input: CreateClientRoutingRuleInputDto, token?: string) {
    return this.devDataService.createClientRoutingRule(input, token);
  }

  updateRoutingRule(ruleId: string, input: UpdateClientRoutingRuleInputDto, token?: string) {
    return this.devDataService.updateClientRoutingRule(ruleId, input, token);
  }

  deleteRoutingRule(ruleId: string, token?: string) {
    return this.devDataService.deleteClientRoutingRule(ruleId, token);
  }

  testRoutingRule(value: string, token?: string) {
    return this.devDataService.testClientRoutingRule(value, token);
  }

  connect(nodeId: string, mode: "global" | "rule" | "direct", strategyGroupId?: string, token?: string) {
    return this.devDataService.connect({ nodeId, mode, strategyGroupId }, token);
  }

  heartbeat(sessionId: string, token?: string) {
    return this.devDataService.heartbeatSession(sessionId, token);
  }

  disconnect(sessionId: string, token?: string) {
    return this.devDataService.disconnect(sessionId, token);
  }

  streamEvents(token?: string, lastEventId?: string | null) {
    return this.devDataService.streamRuntimeEvents(token, lastEventId);
  }

  getRuntime(sessionId?: string, token?: string) {
    return this.devDataService.getActiveRuntime(sessionId, token);
  }

  listSupportTickets(token?: string) {
    return this.devDataService.listClientSupportTickets(token);
  }

  getSupportTicket(ticketId: string, token?: string) {
    return this.devDataService.getClientSupportTicketDetail(ticketId, token);
  }

  markSupportTicketRead(ticketId: string, token?: string) {
    return this.devDataService.markClientSupportTicketRead(ticketId, token);
  }

  createSupportTicket(input: CreateClientSupportTicketInputDto, token?: string) {
    return this.devDataService.createClientSupportTicket(input, token);
  }

  replySupportTicket(ticketId: string, input: ReplyClientSupportTicketInputDto, token?: string) {
    return this.devDataService.replyClientSupportTicket(ticketId, input, token);
  }

  replySupportTicketWithAttachment(
    ticketId: string,
    input: { body?: string | null },
    file: UploadedTicketAttachmentFile | undefined,
    token?: string
  ) {
    return this.devDataService.replyClientSupportTicketWithAttachment(ticketId, input, file, token);
  }
}
