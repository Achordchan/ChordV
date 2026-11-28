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
assert.equal(shouldRefreshTicketsForAdminEvent(event("node_access_updated")), false);
assert.deepEqual(adminEventSections(event("keepalive")), []);
assert.deepEqual(adminEventSections(event("account_updated")), ["overview", "users", "subscriptions", "teams"]);
assert.deepEqual(adminEventSections(event("resync")), ["resync"]);
assert.deepEqual(adminEventSections(event("presence_updated")), [], "在线状态事件仅由共享 presence store 刷新轻量接口");
assert.deepEqual(adminEventSections(event("subscription_updated")), ["overview", "users", "subscriptions", "teams", "plans", "tickets"]);
assert.deepEqual(adminEventSections({ type: "release_center_updated", occurredAt: "" } as unknown as AdminRuntimeEventDto), [], "已移除的发布事件不能重新激活旧入口");

console.log("admin runtime event regression checks passed");
