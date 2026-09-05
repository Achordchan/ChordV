import { workLifecycle } from "../../work-lifecycle";
import { Injectable, Logger, MessageEvent, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { ClientRuntimeEventDto } from "@chordv/shared";
import { Client as PgClient } from "pg";
import { randomUUID } from "node:crypto";
import { Observable } from "rxjs";
import { PrismaService } from "./prisma.service";

type EventSink = (event: MessageEvent) => void;
type ClusterEnvelope = {
  originInstanceId: string;
  userId: string;
  eventId: string;
  event: ClientRuntimeEventDto;
};

const RUNTIME_EVENTS_CHANNEL = "chordv_runtime_events";
const MAX_REPLAY_EVENTS_PER_USER = 100;

@Injectable()
export class ClientRuntimeEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientRuntimeEventsService.name);
  private readonly instanceId = randomUUID();
  private readonly subscribers = new Map<string, Set<EventSink>>();
  private readonly replayEventsByUser = new Map<string, MessageEvent[]>();
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

  streamForUser(
    userId: string,
    options?: { validate?: () => Promise<void> | void; lastEventId?: string | null }
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      if (workLifecycle.isDraining) { subscriber.complete(); return; }
      let deliveryQueue = Promise.resolve();
      const deliver = (event: MessageEvent) => {
        if (!options?.validate) {
          subscriber.next(event);
          return;
        }
        deliveryQueue = deliveryQueue
          .then(() => subscriber.closed ? undefined : options.validate?.())
          .then(() => {
            subscriber.next(event);
          })
          .catch((error) => {
            subscriber.error(error);
          });
        workLifecycle.track(deliveryQueue);
      };
      const sink: EventSink = (event) => deliver(event);
      const current = this.subscribers.get(userId) ?? new Set<EventSink>();
      current.add(sink);
      this.subscribers.set(userId, current);

      for (const event of this.getReplayEvents(userId, options?.lastEventId)) {
        deliver(event);
      }

      for (const event of this.createStreamOpenedEvents()) {
        deliver(this.toMessageEvent(event));
      }

      const timer = setInterval(() => {
        deliver(
          this.toMessageEvent({
            type: "keepalive",
            occurredAt: new Date().toISOString()
          })
        );
      }, 15000);

      const removeDrainListener = workLifecycle.onDrain(() => subscriber.complete());
      return () => {
        removeDrainListener();
        clearInterval(timer);
        const active = this.subscribers.get(userId);
        if (!active) {
          return;
        }
        active.delete(sink);
        if (active.size === 0) {
          this.subscribers.delete(userId);
        }
      };
    });
  }

  publishToUser(userId: string, event: ClientRuntimeEventDto) {
    const message = this.toReplayableMessageEvent(event, this.nextEventId());
    this.recordReplayEvent(userId, message);
    this.dispatchMessageToUser(userId, message);
    void workLifecycle.track(this.broadcastToCluster(userId, message.id ?? "", event));
  }

  publishToUsers(userIds: Iterable<string>, event: ClientRuntimeEventDto) {
    const uniqueUserIds = Array.from(new Set(userIds));
    if (uniqueUserIds.length === 0) {
      return;
    }
    for (const userId of uniqueUserIds) {
      this.publishToUser(userId, event);
    }
  }

  private dispatchToUser(userId: string, event: ClientRuntimeEventDto, eventId: string) {
    const message = this.toReplayableMessageEvent(event, eventId);
    this.recordReplayEvent(userId, message);
    this.dispatchMessageToUser(userId, message);
  }

  private dispatchMessageToUser(userId: string, message: MessageEvent) {
    const subscribers = this.subscribers.get(userId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    for (const sink of subscribers) {
      sink(message);
    }
  }

  private async broadcastToCluster(userId: string, eventId: string, event: ClientRuntimeEventDto) {
    try {
      await this.prisma.$executeRaw`select pg_notify(${RUNTIME_EVENTS_CHANNEL}, ${JSON.stringify({ originInstanceId: this.instanceId, userId, eventId, event })})`;
    } catch (error) {
      this.logger.warn(`SSE 广播发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private toMessageEvent(event: ClientRuntimeEventDto): MessageEvent {
    return {
      type: event.type,
      data: JSON.stringify(event)
    };
  }

  private toReplayableMessageEvent(event: ClientRuntimeEventDto, eventId: string): MessageEvent {
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

  private recordReplayEvent(userId: string, event: MessageEvent) {
    if (!event.id) {
      return;
    }
    const events = this.replayEventsByUser.get(userId) ?? [];
    events.push(event);
    if (events.length > MAX_REPLAY_EVENTS_PER_USER) {
      events.splice(0, events.length - MAX_REPLAY_EVENTS_PER_USER);
    }
    this.replayEventsByUser.set(userId, events);
  }

  private getReplayEvents(userId: string, lastEventId?: string | null) {
    const normalizedLastEventId = lastEventId?.trim();
    if (!normalizedLastEventId) {
      return [];
    }
    const events = this.replayEventsByUser.get(userId) ?? [];
    const lastIndex = events.findIndex((event) => event.id === normalizedLastEventId);
    return lastIndex >= 0 ? events.slice(lastIndex + 1) : events;
  }

  private createStreamOpenedEvents(): ClientRuntimeEventDto[] {
    const occurredAt = new Date().toISOString();
    return [
      { type: "keepalive", occurredAt },
      { type: "subscription_updated", occurredAt },
      { type: "node_access_updated", occurredAt },
      { type: "announcement_updated", occurredAt },
      { type: "policy_updated", occurredAt },
      { type: "version_updated", occurredAt },
      { type: "ticket_updated", occurredAt }
    ];
  }

  private async startListener() {
    if (workLifecycle.isDraining || this.destroyed || this.listener) {
      return;
    }

    const listener = new PgClient({
      connectionString: process.env.DATABASE_URL
    });
    try {
      await listener.connect();
      await listener.query(`LISTEN ${RUNTIME_EVENTS_CHANNEL}`);
      listener.on("notification", (notification) => {
        if (notification.channel !== RUNTIME_EVENTS_CHANNEL || !notification.payload) {
          return;
        }
        try {
          const envelope = JSON.parse(notification.payload) as ClusterEnvelope;
          if (!envelope || envelope.originInstanceId === this.instanceId) {
            return;
          }
          if (!envelope.eventId) {
            return;
          }
          this.dispatchToUser(envelope.userId, envelope.event, envelope.eventId);
        } catch (error) {
          this.logger.warn(`解析 SSE 广播失败：${error instanceof Error ? error.message : String(error)}`);
        }
      });
      listener.on("error", (error) => {
        this.logger.error(`SSE 广播监听已断开：${error.message}`);
        void workLifecycle.track(this.scheduleListenerReconnect());
      });
      listener.on("end", () => {
        void workLifecycle.track(this.scheduleListenerReconnect());
      });
      this.listener = listener;
    } catch (error) {
      this.logger.warn(`SSE 广播监听启动失败：${error instanceof Error ? error.message : String(error)}`);
      await listener.end().catch(() => undefined);
      void workLifecycle.track(this.scheduleListenerReconnect());
    }
  }

  private async scheduleListenerReconnect() {
    if (workLifecycle.isDraining || this.destroyed || this.reconnectTimer) {
      return;
    }
    const current = this.listener;
    this.listener = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void workLifecycle.track(this.startListener());
    }, 5000);
    this.reconnectTimer.unref?.();
    await current?.end().catch(() => undefined);
  }
}
