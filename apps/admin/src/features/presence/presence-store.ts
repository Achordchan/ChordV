import type { AdminPresenceSnapshotDto, AdminUserPresenceDto } from "@chordv/shared";

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
};

/**
 * 在线状态共享数据：首页、客户列表、团队成员等多处同时使用时只拉一份。
 * 首次订阅、页面恢复可见和服务端状态事件触发读取；同一时间只有一个请求，期间的事件合并成一次补读。
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
      if (!state.loading) emit({ loading: true });
      return;
    }
    inFlight = true;
    const current = generation;
    emit({ loading: true });
    try {
      const snapshot = await deps.fetch();
      if (current === generation) emit({ snapshot, byUser: new Map(snapshot.users.map((entry) => [entry.userId, entry])), error: null });
    } catch {
      if (current === generation) emit({ error: "在线状态暂时不可用，状态变化或返回页面时将重试。" });
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
    const current = generation;
    const stopEvents = deps.subscribeEvents((event) => {
      if (current === generation && (event.type === "presence_updated" || event.type === "resync")) void refresh();
    });
    const stopVisibility = deps.onVisibilityChange(() => {
      if (current === generation && deps.visible()) void refresh();
    });
    stopTransport = () => {
      stopEvents();
      stopVisibility();
    };
    void refresh();
  };

  return {
    getState: () => state,
    refresh,
    subscribe(listener: () => void) {
      const notify = () => listener();
      listeners.add(notify);
      users += 1;
      if (users === 1) start();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(notify);
        users -= 1;
        if (users === 0) {
          generation += 1;
          pending = false;
          stopTransport?.();
          stopTransport = null;
          emit({ loading: false });
        }
      };
    }
  };
}
