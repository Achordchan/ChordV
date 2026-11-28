import type { ClientRuntimeEventDto } from "@chordv/shared";
import { listenNative as listen } from "../lib/nativeBridge";
import { API_BASE, ApiRequestError, createApiRequestError, getApiErrorStatus, isAccessTokenExpiredApiError } from "./http";
import { loadCommandInvoke, recordClientDiagnosticLog } from "./native-commands";
import { isReplayableEventId, parseClientRuntimeEvent, parseServerSentEventBlock, splitServerSentEventBlocks } from "./sse";

type ClientRuntimeEventType = ClientRuntimeEventDto["type"];

export function createClientRuntimeFallbackRefreshEventTypes(includeVersion: boolean): ClientRuntimeEventType[] {
  // SSE 断流时的兜底只刷新账号/节点/订阅等关键状态。
  // 工单未读数走真实 support_unread_updated 推送和重连后的状态查询，不参与兜底轮询。
  return [
    "subscription_updated",
    "node_access_updated",
    "account_updated",
    "announcement_updated",
    "policy_updated",
    ...(includeVersion ? (["version_updated"] as const) : [])
  ];
}

type ClientEventSubscriber = {
  onEvent: (event: ClientRuntimeEventDto) => void;
  onError?: (error: Error, meta: { authError: boolean; status: number | null }) => void;
  onOpen?: (meta: { elapsedMs: number | null }) => void;
};

export function subscribeClientEvents(accessToken: string, subscriber: ClientEventSubscriber) {
  let disposed = false;
  let reconnectTimer: number | null = null;
  let fallbackRefreshActive = false;
  let activeController: AbortController | null = null;
  let nativeCleanup: (() => void) | null = null;
  let lastEventId: string | null = null;
  let reconnectAttempt = 0;
  const handshakeTimeoutMs = 25_000;
  const streamIdleTimeoutMs = 45_000;
  const reconnectBaseDelayMs = 1_000;
  const reconnectMaxDelayMs = 30_000;

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) {
      return;
    }
    const exp = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** Math.min(reconnectAttempt, 5));
    const jitter = Math.floor(Math.random() * 500);
    const delay = exp + jitter;
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const markStreamStable = () => {
    reconnectAttempt = 0;
  };

  const connectNative = async () => {
    const invoke = await loadCommandInvoke();
    if (!invoke) {
      void recordClientDiagnosticLog("client-sse-js", "native invoke unavailable");
      return false;
    }

    const startedAt = performance.now();
    const streamId =
      typeof crypto.randomUUID === "function"
        ? `client-events-${crypto.randomUUID()}`
        : `client-events-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let opened = false;
    let failedBeforeOpen = false;
    let cleanup = () => undefined;
    const unlistenOpen = await listen<{
      streamId?: string;
    }>("chordv://client-runtime-event-open", (event) => {
      if (event.payload?.streamId !== streamId || opened) {
        return;
      }
      opened = true;
      subscriber.onOpen?.({
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
      });
      void recordClientDiagnosticLog("client-sse-js", "native stream opened");
      stopFallbackRefresh();
    });
    const unlistenEvent = await listen<{
      streamId?: string;
      eventId?: string | null;
      event?: ClientRuntimeEventDto;
    }>("chordv://client-runtime-event", (event) => {
      const payload = event.payload;
      if (!payload?.event || payload.streamId !== streamId) {
        return;
      }
      if (payload.event.type !== "keepalive") {
        void recordClientDiagnosticLog(
          "client-sse-js",
          `native event ${payload.event.type} stream=${payload.streamId ?? "-"} id=${payload.eventId ?? "-"}`
        );
      }
      if (isReplayableEventId(payload.eventId ?? null)) {
        lastEventId = payload.eventId ?? null;
      }
      stopFallbackRefresh();
      markStreamStable();
      subscriber.onEvent(payload.event);
    });
    const unlistenError = await listen<{
      streamId?: string;
      message?: string;
      status?: number | null;
      authError?: boolean;
    }>("chordv://client-runtime-event-error", (event) => {
      const payload = event.payload;
      if (!payload || payload.streamId !== streamId) {
        return;
      }
      const error = new ApiRequestError(payload.status ?? null, payload.message || "事件流连接失败");
      subscriber.onError?.(error, {
        authError: Boolean(payload.authError) || payload.status === 401,
        status: payload.status ?? null
      });
      failedBeforeOpen = true;
      cleanup();
      if (!payload.authError && payload.status !== 401 && payload.status !== 403) {
        startFallbackRefresh();
        scheduleReconnect();
      }
    });

    cleanup = () => {
      unlistenOpen();
      unlistenEvent();
      unlistenError();
      void invoke("stop_client_event_stream", { streamId }).catch(() => null);
      if (nativeCleanup === cleanup) {
        nativeCleanup = null;
      }
    };
    nativeCleanup = cleanup;

    try {
      const response = await invoke<{ streamId: string }>("start_client_event_stream", {
        input: {
          streamId,
          accessToken,
          lastEventId
        }
      });
      if (response.streamId !== streamId) {
        throw new Error("native SSE stream id mismatch");
      }
      if (disposed || failedBeforeOpen) {
        cleanup();
        return true;
      }
      return true;
    } catch (error) {
      cleanup();
      subscriber.onError?.(error instanceof Error ? error : new Error("事件流连接失败"), {
        authError: false,
        status: null
      });
      return false;
    }
  };

  const emitSyntheticEvent = (type: ClientRuntimeEventType) => {
    subscriber.onEvent({
      type,
      occurredAt: new Date().toISOString(),
      synthetic: true
    } as ClientRuntimeEventDto);
  };

  const emitFallbackRefresh = (includeVersion: boolean) => {
    for (const type of createClientRuntimeFallbackRefreshEventTypes(includeVersion)) {
      emitSyntheticEvent(type);
    }
  };

  const startFallbackRefresh = () => {
    if (disposed || fallbackRefreshActive) return;
    fallbackRefreshActive = true;
    emitFallbackRefresh(false);
  };

  const stopFallbackRefresh = () => {
    fallbackRefreshActive = false;
  };

  const handleEventBlock = (chunk: string) => {
    const parsedEvent = parseServerSentEventBlock(chunk);
    if (!parsedEvent.data) {
      if (isReplayableEventId(parsedEvent.id)) {
        lastEventId = parsedEvent.id;
      }
      return;
    }

    try {
      const payload = parseClientRuntimeEvent(parsedEvent);
      if (isReplayableEventId(parsedEvent.id)) {
        lastEventId = parsedEvent.id;
      }
      subscriber.onEvent(payload);
    } catch (error) {
      subscriber.onError?.(error instanceof Error ? error : new Error("事件解析失败"), {
        authError: false,
        status: null
      });
    }
  };

  const connect = async () => {
    let nativeHandled = false;
    try {
      nativeHandled = await connectNative();
    } catch (error) {
      void recordClientDiagnosticLog(
        "client-sse-js",
        `native connect crashed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (nativeHandled || disposed) {
      return;
    }

    void recordClientDiagnosticLog("client-sse-js", "fetch fallback begin");
    const startedAt = performance.now();
    const controller = new AbortController();
    activeController = controller;
    let idleAbort = false;
    let handshakeTimer: number | null = window.setTimeout(() => {
      idleAbort = true;
      controller.abort();
    }, handshakeTimeoutMs);
    let idleTimer: number | null = null;
    const armIdleWatchdog = () => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
      }
      idleTimer = window.setTimeout(() => {
        idleAbort = true;
        controller.abort();
      }, streamIdleTimeoutMs);
    };
    const clearIdleWatchdog = () => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const clearHandshakeWatchdog = () => {
      if (handshakeTimer !== null) {
        window.clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };
    try {
      // 网页兜底连接不带 presence=ping 声明：定期在线上报只在原生推送连接里进行（不受网页定时器节流影响），
      // 这里声明了却不上报会被服务端当成失效连接断开。
      const response = await fetch(`${API_BASE}/api/client/events/stream`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "text/event-stream",
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {})
        },
        signal: controller.signal
      });
      clearHandshakeWatchdog();

      if (!response.ok) {
        throw createApiRequestError("/client/events/stream", response.status, await response.text());
      }

      if (!response.body) {
        throw new Error("事件流未返回内容");
      }

      subscriber.onOpen?.({
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
      });
      void recordClientDiagnosticLog("client-sse-js", "fetch stream opened");
      stopFallbackRefresh();
      armIdleWatchdog();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        armIdleWatchdog();
        buffer += decoder.decode(value, { stream: true });
        const chunks = splitServerSentEventBlocks(buffer);
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const parsedEvent = parseServerSentEventBlock(chunk);
          if (!parsedEvent.data) {
            if (isReplayableEventId(parsedEvent.id)) {
              lastEventId = parsedEvent.id;
            }
            continue;
          }

          try {
            const payload = parseClientRuntimeEvent(parsedEvent);
            if (payload.type !== "keepalive") {
              void recordClientDiagnosticLog("client-sse-js", `fetch event ${payload.type} id=${parsedEvent.id ?? "-"}`);
            }
            if (isReplayableEventId(parsedEvent.id)) {
              lastEventId = parsedEvent.id;
            }
            markStreamStable();
            subscriber.onEvent(payload);
          } catch (error) {
            subscriber.onError?.(error instanceof Error ? error : new Error("事件解析失败"), {
              authError: false,
              status: null
            });
          }
        }
      }

      if (buffer.trim()) {
        handleEventBlock(buffer);
      }
      startFallbackRefresh();
      scheduleReconnect();
    } catch (error) {
      if (disposed) {
        return;
      }
      if (controller.signal.aborted && !idleAbort) {
        return;
      }
      const normalizedError = error instanceof Error ? error : new Error("事件流连接失败");
      const status = getApiErrorStatus(normalizedError);
      const authError = isAccessTokenExpiredApiError(normalizedError) || status === 403;
      subscriber.onError?.(normalizedError, {
        authError,
        status
      });
      if (authError) {
        return;
      }
      startFallbackRefresh();
      scheduleReconnect();
    } finally {
      clearHandshakeWatchdog();
      clearIdleWatchdog();
      if (activeController === controller) {
        activeController = null;
      }
    }
  };

  void connect();

  return () => {
    disposed = true;
    stopFallbackRefresh();
    nativeCleanup?.();
    activeController?.abort();
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
    }
  };
}
