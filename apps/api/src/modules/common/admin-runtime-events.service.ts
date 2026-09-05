import { workLifecycle } from "../../work-lifecycle";
import { Injectable, Logger, MessageEvent, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { ClientRuntimeEventDto } from "@chordv/shared";
import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { Observable } from "rxjs";
import { PrismaService } from "./prisma.service";

type EventSink = (event: MessageEvent) => void;
type AdminRuntimeEventDto = Pick<
  ClientRuntimeEventDto,
  | "type"
  | "occurredAt"
  | "ticketId"
  | "ticketStatus"
  | "subscriptionId"
  | "subscriptionState"
  | "nodeId"
  | "state"
  | "platform"
  | "channel"
  | "latestVersion"
  | "announcementId"
>;
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
      this.subscribers.add(sink);

      for (const event of this.getReplayEvents(options?.lastEventId)) {
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
        this.subscribers.delete(sink);
      };
    });
  }

  publish(event: AdminRuntimeEventDto) {
    const message = this.toReplayableMessageEvent(event, this.nextEventId());
    this.recordReplayEvent(message);
    this.dispatchMessage(message);
    void workLifecycle.track(this.broadcastToCluster(message.id ?? "", event));
  }

  publishTicketUpdated(input: { ticketId: string; ticketStatus?: AdminRuntimeEventDto["ticketStatus"] | null }) {
    this.publish({
      type: "ticket_updated",
      occurredAt: new Date().toISOString(),
      ticketId: input.ticketId,
      ...(input.ticketStatus ? { ticketStatus: input.ticketStatus } : {})
    });
  }

  publishSubscriptionUpdated(input: {
    subscriptionId?: string | null;
    state?: AdminRuntimeEventDto["state"] | null;
  }) {
    this.publish({
      type: "subscription_updated",
      occurredAt: new Date().toISOString(),
      subscriptionId: input.subscriptionId ?? null,
      subscriptionState: input.state ?? null,
      state: input.state ?? null
    });
  }

  publishVersionUpdated(input: {
    platform?: AdminRuntimeEventDto["platform"] | null;
    channel?: AdminRuntimeEventDto["channel"] | null;
    latestVersion?: string | null;
  }) {
    this.publish({
      type: "version_updated",
      occurredAt: new Date().toISOString(),
      platform: input.platform ?? null,
      channel: input.channel ?? null,
      latestVersion: input.latestVersion ?? null
    });
  }

  publishRuntimeComponentUpdated() {
    this.publish({
      type: "runtime_component_updated",
      occurredAt: new Date().toISOString()
    });
  }

  publishReleaseCenterUpdated() {
    this.publish({
      type: "release_center_updated",
      occurredAt: new Date().toISOString()
    });
  }

  publishImageBedUpdated() {
    this.publish({
      type: "image_bed_updated",
      occurredAt: new Date().toISOString()
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
      { type: "ticket_updated", occurredAt },
      { type: "subscription_updated", occurredAt },
      { type: "node_access_updated", occurredAt },
      { type: "version_updated", occurredAt },
      { type: "runtime_component_updated", occurredAt },
      { type: "release_center_updated", occurredAt },
      { type: "image_bed_updated", occurredAt },
      { type: "announcement_updated", occurredAt },
      { type: "policy_updated", occurredAt },
      { type: "sync_queue_updated", occurredAt }
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
        void workLifecycle.track(this.scheduleListenerReconnect());
      });
      listener.on("end", () => {
        void workLifecycle.track(this.scheduleListenerReconnect());
      });
      this.listener = listener;
    } catch (error) {
      this.logger.warn(`Admin SSE listener failed to start: ${error instanceof Error ? error.message : String(error)}`);
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
