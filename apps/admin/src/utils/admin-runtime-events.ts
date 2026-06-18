import type { AdminRuntimeEventDto } from "../api/client";

export function shouldRefreshTicketsForAdminEvent(event: AdminRuntimeEventDto) {
  return event.type === "ticket_updated" || event.type === "subscription_updated";
}
