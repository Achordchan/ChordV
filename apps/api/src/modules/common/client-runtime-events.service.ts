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
  event: ClientRuntimeEventDto;
};

const RUNTIME_EVENTS_CHANNEL = "chordv_runtime_events";

@Injectable()
export class ClientRuntimeEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientRuntimeEventsService.name);
  private readonly instanceId = randomUUID();
  private readonly subscribers = new Map<string, Set<EventSink>>();
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

  streamForUser(userId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const sink: EventSink = (event) => subscriber.next(event);
      const current = this.subscribers.get(userId) ?? new Set<EventSink>();
      current.add(sink);
      this.subscribers.set(userId, current);

      for (const event of this.createStreamOpenedEvents()) {
        subscriber.next(this.toMessageEvent(event));
      }

      const timer = setInterval(() => {
        subscriber.next(
          this.toMessageEvent({
            type: "keepalive",
            occurredAt: new Date().toISOString()
          })
        );
      }, 15000);

      return () => {
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
    this.dispatchToUser(userId, event);
    void this.broadcastToCluster(userId, event);
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

  private dispatchToUser(userId: string, event: ClientRuntimeEventDto) {
    const subscribers = this.subscribers.get(userId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    const payload = this.toMessageEvent(event);
    for (const sink of subscribers) {
      sink(payload);
    }
  }

  private async broadcastToCluster(userId: string, event: ClientRuntimeEventDto) {
    try {
      await this.prisma.$executeRaw`select pg_notify(${RUNTIME_EVENTS_CHANNEL}, ${JSON.stringify({ originInstanceId: this.instanceId, userId, event })})`;
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

  private createStreamOpenedEvents(): ClientRuntimeEventDto[] {
    const occurredAt = new Date().toISOString();
    return [
      { type: "keepalive", occurredAt },
      { type: "subscription_updated", occurredAt },
      { type: "node_access_updated", occurredAt },
      { type: "announcement_updated", occurredAt }
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
          this.dispatchToUser(envelope.userId, envelope.event);
        } catch (error) {
          this.logger.warn(`解析 SSE 广播失败：${error instanceof Error ? error.message : String(error)}`);
        }
      });
      listener.on("error", (error) => {
        this.logger.error(`SSE 广播监听已断开：${error.message}`);
        void this.scheduleListenerReconnect();
      });
      listener.on("end", () => {
        void this.scheduleListenerReconnect();
      });
      this.listener = listener;
    } catch (error) {
      this.logger.warn(`SSE 广播监听启动失败：${error instanceof Error ? error.message : String(error)}`);
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
