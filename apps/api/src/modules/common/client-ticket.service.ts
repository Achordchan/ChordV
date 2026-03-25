import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  ClientSupportTicketDetailDto,
  ClientSupportTicketSummaryDto,
  CreateClientSupportTicketInputDto,
  ReplyClientSupportTicketInputDto,
  TeamMemberRole
} from "@chordv/shared";
import { AuthSessionService } from "./auth-session.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { PrismaService } from "./prisma.service";
import { createId } from "./release-center.utils";
import { pickCurrentSubscription } from "./subscription.utils";
import {
  hasUnreadTicketMessages,
  toClientSupportTicketDetail,
  toClientSupportTicketSummary
} from "./ticket.utils";

type ClientSubscriptionAccess = {
  subscription: {
    id: string;
    plan: { maxConcurrentSessions: number };
    user: { id: string; status: "active" | "disabled" } | null;
    team: { id: string; name: string; status: "active" | "disabled" } | null;
  } | null;
  team: { id: string; name: string; status: "active" | "disabled" } | null;
  memberRole: TeamMemberRole | null;
  memberUsedTrafficGb: number | null;
};

@Injectable()
export class ClientTicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessionService: AuthSessionService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService
  ) {}

  async getClientSupportTicketInbox(userId: string) {
    const rows = await this.prisma.supportTicket.findMany({
      where: { userId },
      select: {
        id: true,
        readStates: {
          where: { userId },
          select: { lastReadAt: true, lastReadMessageAt: true },
          take: 1
        }
      }
    });

    const latestAdminMessageMap = await this.loadLatestAdminTicketMessageMap(rows.map((item) => item.id));
    const unreadCount = rows.filter((row) =>
      hasUnreadTicketMessages(latestAdminMessageMap.get(row.id) ?? null, row.readStates[0] ?? null)
    ).length;

    return {
      totalCount: rows.length,
      unreadCount
    };
  }

  async listClientSupportTickets(token?: string): Promise<ClientSupportTicketSummaryDto[]> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const rows = await this.prisma.supportTicket.findMany({
      where: { userId: user.id },
      include: {
        team: {
          select: { id: true, name: true }
        },
        messages: {
          select: { body: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1
        },
        readStates: {
          where: { userId: user.id },
          select: { lastReadAt: true, lastReadMessageAt: true },
          take: 1
        }
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
    });

    const latestAdminMessageMap = await this.loadLatestAdminTicketMessageMap(rows.map((item) => item.id));
    return rows.map((row) => toClientSupportTicketSummary(row, latestAdminMessageMap.get(row.id) ?? null));
  }

  async getClientSupportTicketDetail(ticketId: string, token?: string): Promise<ClientSupportTicketDetailDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const row = await this.requireClientSupportTicketDetail(ticketId, user.id);
    return toClientSupportTicketDetail(row);
  }

  async markClientSupportTicketRead(
    ticketId: string,
    token?: string
  ): Promise<{ ok: boolean; ticketId: string; lastReadAt: string }> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const row = await this.prisma.supportTicket.findFirst({
      where: {
        id: ticketId,
        userId: user.id
      },
      select: {
        id: true,
        messages: {
          where: { authorRole: "admin" },
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    });

    if (!row) {
      throw new NotFoundException("工单不存在");
    }

    const now = new Date();
    await this.prisma.supportTicketReadState.upsert({
      where: {
        ticketId_userId: {
          ticketId: row.id,
          userId: user.id
        }
      },
      create: {
        id: createId("ticket_read"),
        ticketId: row.id,
        userId: user.id,
        lastReadMessageAt: row.messages[0]?.createdAt ?? null,
        lastReadAt: now
      },
      update: {
        lastReadMessageAt: row.messages[0]?.createdAt ?? null,
        lastReadAt: now
      }
    });

    this.clientRuntimeEventsService.publishToUser(user.id, {
      type: "ticket_read_state_updated",
      occurredAt: now.toISOString(),
      ticketId: row.id
    });

    return {
      ok: true,
      ticketId: row.id,
      lastReadAt: now.toISOString()
    };
  }

  async createClientSupportTicket(
    input: CreateClientSupportTicketInputDto,
    token?: string
  ): Promise<ClientSupportTicketDetailDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    const title = input.title.trim();
    const body = input.body.trim();

    if (!title) {
      throw new BadRequestException("工单标题不能为空");
    }
    if (!body) {
      throw new BadRequestException("工单内容不能为空");
    }

    const now = new Date();
    const ticketId = createId("ticket");
    await this.prisma.supportTicket.create({
      data: {
        id: ticketId,
        userId: user.id,
        subscriptionId: access.subscription?.id ?? null,
        teamId: access.team?.id ?? null,
        title,
        status: "waiting_admin",
        source: "desktop",
        lastMessageAt: now,
        readStates: {
          create: {
            id: createId("ticket_read"),
            userId: user.id,
            lastReadMessageAt: now,
            lastReadAt: now
          }
        },
        messages: {
          create: {
            id: createId("ticket_msg"),
            authorRole: "user",
            authorUserId: user.id,
            body
          }
        }
      }
    });

    this.clientRuntimeEventsService.publishToUser(user.id, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "waiting_admin"
    });

    return this.getClientSupportTicketDetail(ticketId, token);
  }

  async replyClientSupportTicket(
    ticketId: string,
    input: ReplyClientSupportTicketInputDto,
    token?: string
  ): Promise<ClientSupportTicketDetailDto> {
    const user = await this.authSessionService.authenticateAccessToken(token);
    const body = input.body.trim();
    if (!body) {
      throw new BadRequestException("回复内容不能为空");
    }

    const current = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId: user.id },
      select: { id: true, status: true }
    });
    if (!current) {
      throw new NotFoundException("工单不存在");
    }
    if (current.status === "closed") {
      throw new BadRequestException("当前工单已关闭，请等待管理员重新打开。");
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.supportTicketMessage.create({
        data: {
          id: createId("ticket_msg"),
          ticketId,
          authorRole: "user",
          authorUserId: user.id,
          body
        }
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: "waiting_admin",
          lastMessageAt: now,
          closedAt: null
        }
      });
      await tx.supportTicketReadState.upsert({
        where: {
          ticketId_userId: {
            ticketId,
            userId: user.id
          }
        },
        create: {
          id: createId("ticket_read"),
          ticketId,
          userId: user.id,
          lastReadMessageAt: now,
          lastReadAt: now
        },
        update: {
          lastReadMessageAt: now,
          lastReadAt: now
        }
      });
    });

    this.clientRuntimeEventsService.publishToUser(user.id, {
      type: "ticket_updated",
      occurredAt: now.toISOString(),
      ticketId,
      ticketStatus: "waiting_admin"
    });

    return this.getClientSupportTicketDetail(ticketId, token);
  }

  private async loadLatestAdminTicketMessageMap(ticketIds: string[]) {
    const uniqueTicketIds = Array.from(new Set(ticketIds.filter((item) => item.trim().length > 0)));
    const result = new Map<string, Date>();
    if (uniqueTicketIds.length === 0) {
      return result;
    }

    const rows = await this.prisma.supportTicketMessage.findMany({
      where: {
        ticketId: { in: uniqueTicketIds },
        authorRole: "admin"
      },
      select: {
        ticketId: true,
        createdAt: true
      },
      orderBy: [{ createdAt: "desc" }]
    });

    for (const row of rows) {
      if (!result.has(row.ticketId)) {
        result.set(row.ticketId, row.createdAt);
      }
    }
    return result;
  }

  private async requireClientSupportTicketDetail(ticketId: string, userId: string) {
    const row = await this.prisma.supportTicket.findFirst({
      where: {
        id: ticketId,
        userId
      },
      include: {
        team: {
          select: { id: true, name: true }
        },
        messages: {
          include: {
            authorUser: {
              select: { displayName: true }
            }
          },
          orderBy: { createdAt: "asc" }
        },
        readStates: {
          where: { userId },
          select: { lastReadAt: true, lastReadMessageAt: true },
          take: 1
        }
      }
    });

    if (!row) {
      throw new NotFoundException("工单不存在");
    }
    return row;
  }

  private async resolveSubscriptionAccessForUser(userId: string): Promise<ClientSubscriptionAccess> {
    const membership = await this.prisma.teamMember.findUnique({
      where: { userId },
      include: {
        team: {
          include: {
            subscriptions: {
              include: { plan: true, user: true, team: true },
              orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
            }
          }
        }
      }
    });

    if (membership) {
      const pickedSubscription = pickCurrentSubscription(membership.team.subscriptions);
      const subscription = pickedSubscription
        ? await this.prisma.subscription.findUnique({
            where: { id: pickedSubscription.id },
            include: { plan: true, user: true, team: true }
          })
        : null;
      const memberUsedTrafficGb = subscription
        ? await this.getMemberUsedTrafficGb(membership.teamId, userId, subscription.id)
        : 0;

      return {
        subscription,
        team: membership.team,
        memberRole: membership.role as TeamMemberRole,
        memberUsedTrafficGb
      };
    }

    const subscription = await this.findCurrentPersonalSubscription(userId);
    return {
      subscription,
      team: null,
      memberRole: null,
      memberUsedTrafficGb: null
    };
  }

  private async findCurrentPersonalSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: { userId },
      include: { plan: true, user: true, team: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
  }

  private async getMemberUsedTrafficGb(teamId: string, userId: string, subscriptionId: string) {
    const rows = await this.prisma.trafficLedger.findMany({
      where: { teamId, userId, subscriptionId }
    });
    return rows.reduce((sum, item) => sum + item.usedTrafficGb, 0);
  }
}
