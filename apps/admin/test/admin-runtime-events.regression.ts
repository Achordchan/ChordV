import assert from "node:assert/strict";
import type { AdminRuntimeEventDto } from "../src/api/client";
import { shouldRefreshTicketsForAdminEvent } from "../src/utils/admin-runtime-events";

function event(type: AdminRuntimeEventDto["type"]): AdminRuntimeEventDto {
  return {
    type,
    occurredAt: "2026-01-01T00:00:00.000Z"
  };
}

assert.equal(shouldRefreshTicketsForAdminEvent(event("ticket_updated")), true);
assert.equal(shouldRefreshTicketsForAdminEvent(event("subscription_updated")), true);
assert.equal(shouldRefreshTicketsForAdminEvent(event("version_updated")), false);

console.log("admin runtime event regression checks passed");
