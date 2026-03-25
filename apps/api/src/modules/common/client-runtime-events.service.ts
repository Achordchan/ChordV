import { Injectable, MessageEvent } from "@nestjs/common";
import type { ClientRuntimeEventDto } from "@chordv/shared";
import { Observable } from "rxjs";

type EventSink = (event: MessageEvent) => void;

@Injectable()
export class ClientRuntimeEventsService {
  private readonly subscribers = new Map<string, Set<EventSink>>();

  streamForUser(userId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const sink: EventSink = (event) => subscriber.next(event);
      const current = this.subscribers.get(userId) ?? new Set<EventSink>();
      current.add(sink);
      this.subscribers.set(userId, current);

      subscriber.next(this.toMessageEvent({
        type: "keepalive",
        occurredAt: new Date().toISOString()
      }));

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
    const subscribers = this.subscribers.get(userId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    const payload = this.toMessageEvent(event);
    for (const sink of subscribers) {
      sink(payload);
    }
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

  private toMessageEvent(event: ClientRuntimeEventDto): MessageEvent {
    return {
      type: event.type,
      data: JSON.stringify(event)
    };
  }
}
