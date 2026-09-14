import type { AdminRuntimeEventDto } from "../api/client";

export function shouldRefreshTicketsForAdminEvent(event: AdminRuntimeEventDto) {
  return event.type === "ticket_updated" || event.type === "subscription_updated";
}

export function adminEventSections(event: AdminRuntimeEventDto): string[] {
  switch (event.type) {
    case "subscription_updated": return ["overview", "users", "subscriptions", "plans", "tickets"];
    case "node_access_updated": return ["overview", "nodes", "users", "subscriptions"];
    case "sync_queue_updated": return ["overview", "nodes", "users", "subscriptions", "system"];
    case "ticket_updated": return ["overview", "tickets"];
    case "announcement_updated": return ["overview", "announcements"];
    case "policy_updated": return ["policies"];
    case "version_updated": return ["releases"];
    case "release_center_updated": return ["releases"];
    case "runtime_component_updated": return ["runtimeComponents", "releases"];
    case "image_bed_updated": return ["imageBed"];
    default: return [];
  }
}

/** One event-triggered batch, never a periodic refresh. Hidden-page events are
 * retained until visible; events during a read request at most one next batch. */
export function createAdminRefreshBatch(options: {
  visible: () => boolean;
  refresh: (sections: Set<string>) => Promise<void>;
}) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false, stopped = false;
  const flush = async () => {
    timer = undefined;
    if (stopped || busy || !options.visible() || !pending.size) return;
    const batch = new Set(pending); pending.clear(); busy = true;
    try { await options.refresh(batch); }
    finally { busy = false; if (!stopped && pending.size) schedule(); }
  };
  const schedule = () => {
    if (!stopped && !busy && !timer && options.visible() && pending.size) timer = setTimeout(() => { void flush().catch(() => undefined); }, 180);
  };
  return {
    add(sections: string[]) { if (stopped) return; sections.forEach(section => pending.add(section)); schedule(); },
    resume: schedule,
    stop() { stopped = true; clearTimeout(timer); pending.clear(); }
  };
}
