import { useSyncExternalStore } from "react";
import { subscribeAdminRuntimeEvents } from "../../api/client";
import { fetchAdminPresence } from "../../api/presence";
import { createPresenceStore, type PresenceStoreState } from "./presence-store";

const store = createPresenceStore({
  fetch: fetchAdminPresence,
  subscribeEvents: (onEvent) => subscribeAdminRuntimeEvents(onEvent),
  visible: () => document.visibilityState !== "hidden",
  onVisibilityChange: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }
});

/** 在线状态；共享初次读取、可见恢复及服务端事件触发的更新。 */
export function usePresence(): PresenceStoreState & { refresh: () => Promise<void> } {
  const current = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { ...current, refresh: store.refresh };
}
