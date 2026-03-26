import { Injectable } from "@nestjs/common";
import type {
  ClientPingDto,
  ClientUpdateCheckDto,
  CreateClientSupportTicketInputDto,
  MarkClientAnnouncementsReadInputDto,
  ReplyClientSupportTicketInputDto
} from "@chordv/shared";
import { DevDataService } from "../common/dev-data.service";

@Injectable()
export class ClientService {
  constructor(private readonly devDataService: DevDataService) {}

  getBootstrap(token?: string) {
    return this.devDataService.getBootstrap(token);
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

  getVersion() {
    return this.devDataService.getClientVersion();
  }

  ping(token?: string): Promise<ClientPingDto> {
    return this.devDataService.pingClient(token);
  }

  checkUpdate(input: ClientUpdateCheckDto) {
    return this.devDataService.checkClientUpdate(input);
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

  streamEvents(token?: string) {
    return this.devDataService.streamRuntimeEvents(token);
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
}
