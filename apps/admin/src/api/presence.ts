import type { AdminPresenceSnapshotDto } from "@chordv/shared";
import { request } from "./base";

const ADMIN_PRESENCE_TIMEOUT_MS = 20 * 1000;

export function fetchAdminPresence() {
  return request<AdminPresenceSnapshotDto>("/admin/presence", {
    timeoutMs: ADMIN_PRESENCE_TIMEOUT_MS
  });
}
