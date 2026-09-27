import type { AdminPresenceSnapshotDto, AdminUserPresenceDto } from "@chordv/shared";

/** 页面可见时每 30 秒拉一次：客户端超时掉线不会产生事件，只能靠轮询发现。 */
export const PRESENCE_POLL_MS = 30_000;

export type PresenceStoreState = {
  snapshot: AdminPresenceSnapshotDto | null;
  /** 按用户 id 的查找表，每份快照只建一次，列表里每一行共用。 */
  byUser: ReadonlyMap<string, AdminUserPresenceDto>;
  loading: boolean;
  error: string | null;
};

type PresenceStoreDeps = {
  fetch: () => Promise<AdminPresenceSnapshotDto>;
  subscribeEvents: (onEvent: (event: { type: string }) => void) => () => void;
  visible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  setInterval: (task: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

/**
 * 在线状态共享数据：首页、客户列表、团队成员等多处同时使用时只拉一份。
 * 有组件在用时才轮询；收到后台的 presence_updated 事件立即刷新；同一时间只有一个请求，期间再次触发会在结束后补一次。
 */
export function createPresenceStore(deps: PresenceStoreDeps) {
  let state: PresenceStoreState = { snapshot: null, byUser: new Map(), loading: false, error: null };
  const listeners = new Set<() => void>();
  let users = 0;
  let inFlight = false;
  let pending = false;
  let generation = 0;
  let stopTransport: (() => void) | null = null;

  const emit = (next: Partial<PresenceStoreState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };

  const refresh = async () => {
    if (!users || !deps.visible()) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    const current = generation;
    emit({ loading: true });
    try {
      const snapshot = await deps.fetch();
      if (current === generation) emit({ snapshot, byUser: new Map(snapshot.users.map((entry) => [entry.userId, entry])), error: null });
    } catch {
      if (current === generation) emit({ error: "在线状态暂时不可用，稍后会自动重试。" });
    } finally {
      inFlight = false;
      if (current === generation) emit({ loading: false });
      if (pending) {
        pending = false;
        void refresh();
      }
    }
  };

  const start = () => {
    generation += 1;
    const stopEvents = deps.subscribeEvents((event) => {
      if (event.type === "presence_updated") void refresh();
    });
    const timer = deps.setInterval(() => void refresh(), PRESENCE_POLL_MS);
    const stopVisibility = deps.onVisibilityChange(() => {
      if (deps.visible()) void refresh();
    });
    stopTransport = () => {
      stopEvents();
      deps.clearInterval(timer);
      stopVisibility();
    };
    void refresh();
  };

  return {
    getState: () => state,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      users += 1;
      if (users === 1) start();
      return () => {
        listeners.delete(listener);
        users -= 1;
        if (users === 0) {
          generation += 1;
          pending = false;
          stopTransport?.();
          stopTransport = null;
        }
      };
    }
  };
}
