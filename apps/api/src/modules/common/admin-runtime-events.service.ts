import { Injectable, Logger, MessageEvent, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { ClientRuntimeEventDto } from "@chordv/shared";
import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { Observable } from "rxjs";
import { PrismaService } from "./prisma.service";

type EventSink = (event: MessageEvent) => void;
type AdminRuntimeEventDto = Pick<ClientRuntimeEventDto, "type" | "occurredAt" | "ticketId" | "ticketStatus">;
type ClusterEnvelope = {
  originInstanceId: string;
  eventId: string;
  event: AdminRuntimeEventDto;
};

const ADMIN_RUNTIME_EVENTS_CHANNEL = "chordv_admin_runtime_events";
const MAX_REPLAY_EVENTS = 100;

@Injectable()
export class AdminRuntimeEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminRuntimeEventsService.name);
  private readonly instanceId = randomUUID();
  private readonly subscribers = new Set<EventSink>();
  private readonly replayEvents: MessageEvent[] = [];
  private eventSequence = 0;
  private listener: PgClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.startListener();
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.listener?.end().catch(() => undefined);
    this.listener = null;
  }

  stream(options?: { validate?: () => Promise<void> | void; lastEventId?: string | null }): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let deliveryQueue = Promise.resolve();
      const sink: EventSink = (event) => {
        deliveryQueue = deliveryQueue
          .then(() => options?.validate?.())
          .then(() => {
            subscriber.next(event);
          })
          .catch((error) => {
            subscriber.error(error);
          });
      };
      this.subscribers.add(sink);

      for (const event of this.getReplayEvents(options?.lastEventId)) {
        subscriber.next(event);
      }

      for (const event of this.createStreamOpenedEvents()) {
        subscriber.next(this.toMessageEvent(event));
      }

      const timer = setInterval(() => {
        Promise.resolve(options?.validate?.())
          .then(() => {
            subscriber.next(
              this.toMessageEvent({
                type: "keepalive",
                occurredAt: new Date().toISOString()
              })
            );
          })
          .catch((error) => {
            subscriber.error(error);
          });
      }, 15000);

      return () => {
        clearInterval(timer);
        this.subscribers.delete(sink);
      };
    });
  }

  publish(event: AdminRuntimeEventDto) {
    const message = this.toReplayableMessageEvent(event, this.nextEventId());
    this.recordReplayEvent(message);
    this.dispatchMessage(message);
    void this.broadcastToCluster(message.id ?? "", event);
  }

  publishTicketUpdated(input: { ticketId: string; ticketStatus?: AdminRuntimeEventDto["ticketStatus"] | null }) {
    this.publish({
      type: "ticket_updated",
      occurredAt: new Date().toISOString(),
      ticketId: input.ticketId,
      ...(input.ticketStatus ? { ticketStatus: input.ticketStatus } : {})
    });
  }

  private dispatch(event: AdminRuntimeEventDto, eventId: string) {
    const message = this.toReplayableMessageEvent(event, eventId);
    this.recordReplayEvent(message);
    this.dispatchMessage(message);
  }

  private dispatchMessage(message: MessageEvent) {
    for (const sink of this.subscribers) {
      sink(message);
    }
  }

  private async broadcastToCluster(eventId: string, event: AdminRuntimeEventDto) {
    try {
      await this.prisma.$executeRaw`select pg_notify(${ADMIN_RUNTIME_EVENTS_CHANNEL}, ${JSON.stringify({ originInstanceId: this.instanceId, eventId, event })})`;
    } catch (error) {
      this.logger.warn(`Admin SSE broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private toMessageEvent(event: AdminRuntimeEventDto): MessageEvent {
    return {
      type: event.type,
      data: JSON.stringify(event)
    };
  }

  private toReplayableMessageEvent(event: AdminRuntimeEventDto, eventId: string): MessageEvent {
    return {
      id: eventId,
      type: event.type,
      data: JSON.stringify(event)
    };
  }

  private nextEventId() {
    this.eventSequence = (this.eventSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `${Date.now()}-${this.eventSequence}`;
  }

  private recordReplayEvent(event: MessageEvent) {
    if (!event.id) {
      return;
    }
    this.replayEvents.push(event);
    if (this.replayEvents.length > MAX_REPLAY_EVENTS) {
      this.replayEvents.splice(0, this.replayEvents.length - MAX_REPLAY_EVENTS);
    }
  }

  private getReplayEvents(lastEventId?: string | null) {
    const normalizedLastEventId = lastEventId?.trim();
    if (!normalizedLastEventId) {
      return [];
    }
    const lastIndex = this.replayEvents.findIndex((event) => event.id === normalizedLastEventId);
    return lastIndex >= 0 ? this.replayEvents.slice(lastIndex + 1) : this.replayEvents;
  }

  private createStreamOpenedEvents(): AdminRuntimeEventDto[] {
    const occurredAt = new Date().toISOString();
    return [
      { type: "keepalive", occurredAt },
      { type: "ticket_updated", occurredAt }
    ];
  }

  private async startListener() {
    if (this.destroyed || this.listener) {
      return;
    }

    const listener = new PgClient({
      connectionString: process.env.DATABASE_URL
    });
    try {
      await listener.connect();
      await listener.query(`LISTEN ${ADMIN_RUNTIME_EVENTS_CHANNEL}`);
      listener.on("notification", (notification) => {
        if (notification.channel !== ADMIN_RUNTIME_EVENTS_CHANNEL || !notification.payload) {
          return;
        }
        try {
          const envelope = JSON.parse(notification.payload) as ClusterEnvelope;
          if (!envelope || envelope.originInstanceId === this.instanceId || !envelope.eventId) {
            return;
          }
          this.dispatch(envelope.event, envelope.eventId);
        } catch (error) {
          this.logger.warn(`Admin SSE broadcast parse failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      listener.on("error", (error) => {
        this.logger.error(`Admin SSE listener disconnected: ${error.message}`);
        void this.scheduleListenerReconnect();
      });
      listener.on("end", () => {
        void this.scheduleListenerReconnect();
      });
      this.listener = listener;
    } catch (error) {
      this.logger.warn(`Admin SSE listener failed to start: ${error instanceof Error ? error.message : String(error)}`);
      await listener.end().catch(() => undefined);
      void this.scheduleListenerReconnect();
    }
  }

  private async scheduleListenerReconnect() {
    if (this.destroyed || this.reconnectTimer) {
      return;
    }
    const current = this.listener;
    this.listener = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startListener();
    }, 5000);
    this.reconnectTimer.unref?.();
    await current?.end().catch(() => undefined);
  }
}
