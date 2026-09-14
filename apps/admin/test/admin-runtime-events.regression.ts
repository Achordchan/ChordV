import assert from "node:assert/strict";
import type { AdminRuntimeEventDto } from "../src/api/client";
import { adminEventSections, shouldRefreshTicketsForAdminEvent } from "../src/utils/admin-runtime-events";

function event(type: AdminRuntimeEventDto["type"]): AdminRuntimeEventDto {
  return {
    type,
    occurredAt: "2026-01-01T00:00:00.000Z"
  };
}

assert.equal(shouldRefreshTicketsForAdminEvent(event("ticket_updated")), true);
assert.equal(shouldRefreshTicketsForAdminEvent(event("subscription_updated")), true);
assert.equal(shouldRefreshTicketsForAdminEvent(event("version_updated")), false);
assert.deepEqual(adminEventSections(event("runtime_component_updated")), ["runtimeComponents", "releases"], "组件变更必须同时刷新独立组件页和统一发布中心");
assert.deepEqual(adminEventSections(event("release_center_updated")), ["releases"]);
assert.deepEqual(adminEventSections(event("keepalive")), []);

console.log("admin runtime event regression checks passed");
