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
  },
  setInterval: (task, ms) => window.setInterval(task, ms),
  clearInterval: (handle) => window.clearInterval(handle as number)
});

/** 在线状态；组件挂载期间自动保持更新。 */
export function usePresence(): PresenceStoreState & { refresh: () => Promise<void> } {
  const current = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { ...current, refresh: store.refresh };
}
