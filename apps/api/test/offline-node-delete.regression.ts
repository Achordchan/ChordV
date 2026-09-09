import "reflect-metadata";
import assert from "node:assert/strict";
import { ServiceUnavailableException } from "@nestjs/common";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { AdminNodeService } from "../src/modules/common/admin-node.service";

function createInstance<T extends object>(prototype: object, overrides: Record<string, unknown> = {}): T {
  return Object.assign(Object.create(prototype), overrides) as T;
}

function createRuntimeSessionService(overrides: Record<string, unknown> = {}) {
  return createInstance<RuntimeSessionService>(RuntimeSessionService.prototype, overrides);
}

function createAdminNodeService(overrides: Record<string, unknown> = {}) {
  const runtimeSessionOverride =
    typeof overrides.runtimeSessionService === "object" && overrides.runtimeSessionService !== null
      ? (overrides.runtimeSessionService as Record<string, unknown>)
      : {};
  return createInstance<AdminNodeService>(AdminNodeService.prototype, {
    ...overrides,
    runtimeSessionService: {
      queueLeaseRevocationJobForNode: async () => undefined,
      ...runtimeSessionOverride
    }
  });
}

// Panel era is retired: deleteNode always revokes live leases, queues lease
// revocation, then hard deletes the node row (per-node rows cascade), and
// publishes node access / subscription refresh events. There is no more
// remote panel cleanup path to fail, stall, or finalize.
async function testDeleteNodeHardDeletesAfterLeaseRevocation() {
  const calls: string[] = [];
  let nodeDeleted = false;
  let subscriptionPublishCount = 0;
  const service = createAdminNodeService({
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => {
        calls.push("resolve_event_targets");
        return ["user_1"];
      },
      publishNodeAccessUpdatedToUsers: () => {
        calls.push("publish_event");
      },
      publishSubscriptionUpdated: async () => {
        subscriptionPublishCount += 1;
      }
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke_local_leases");
        return 2;
      },
      queueLeaseRevocationJobForNode: async () => {
        calls.push("queue_lease_revocation");
      }
    },
    prisma: {
      node: {
        findUnique: async () => ({ id: "node_1", isActive: true }),
        delete: async (payload: Record<string, any>) => {
          calls.push("hard_delete");
          assert.equal(payload.where.id, "node_1");
          nodeDeleted = true;
        }
      }
    }
  });

  const result = await service.deleteNode("node_1");

  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.deepEqual(calls, [
    "resolve_event_targets",
    "revoke_local_leases",
    "queue_lease_revocation",
    "hard_delete",
    "publish_event"
  ]);
  assert.equal(nodeDeleted, true, "node must be hard-deleted; traffic ledger uses SetNull");
  assert.equal(subscriptionPublishCount, 1, "clients must refresh subscription metering after hard delete");
}

async function testDeleteNodeReturnsWhenEventTargetResolutionStallsAfterLocalSave() {
  const calls: string[] = [];
  let publishedUserIds: string[] | null = null;
  let nodeDeleted = false;
  const service = createAdminNodeService({
    logger: {
      warn: () => undefined
    },
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => {
        calls.push("resolve_event_targets");
        return new Promise<string[]>(() => undefined);
      },
      publishNodeAccessUpdatedToUsers: (userIds: string[]) => {
        calls.push("publish_event");
        publishedUserIds = userIds;
      },
      publishSubscriptionUpdated: async () => undefined
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke_local_leases");
        return 0;
      },
      queueLeaseRevocationJobForNode: async () => {
        calls.push("queue_lease_revocation");
      }
    },
    prisma: {
      node: {
        findUnique: async () => ({ id: "node_1", isActive: true }),
        delete: async () => {
          calls.push("hard_delete");
          nodeDeleted = true;
        }
      }
    }
  });

  const result = await Promise.race([
    service.deleteNode("node_1"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("deleteNode waited for stalled event target resolution")), 750);
    })
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(nodeDeleted, true, "stalled event target resolution must not block the hard delete");
  assert.deepEqual(calls, [
    "resolve_event_targets",
    "revoke_local_leases",
    "queue_lease_revocation",
    "hard_delete",
    "publish_event"
  ]);
  assert.deepEqual(publishedUserIds, []);
}

async function testDeleteNodePublishesAdminEventWhenClientTargetResolutionStalls() {
  const adminEvents: Array<Record<string, any>> = [];
  const service = createAdminNodeService({
    logger: {
      warn: () => undefined
    },
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => new Promise<string[]>(() => undefined),
      publishNodeAccessUpdatedToUsers: () => undefined,
      publishSubscriptionUpdated: async () => undefined
    },
    adminRuntimeEventsService: {
      publish: (event: Record<string, any>) => {
        adminEvents.push(event);
      }
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => 0,
      queueLeaseRevocationJobForNode: async () => undefined
    },
    prisma: {
      node: {
        findUnique: async () => ({ id: "node_1", isActive: true }),
        delete: async () => ({})
      }
    }
  });

  const result = await Promise.race([
    service.deleteNode("node_1"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("deleteNode waited for stalled event target resolution")), 750);
    })
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(adminEvents.length, 1);
  assert.equal(adminEvents[0].type, "node_access_updated");
  assert.equal(adminEvents[0].nodeId, "node_1");
}

// Lease revocation is best-effort around the local delete: a revocation
// failure must not abort the hard delete (remaining leases are revoked via
// the queued lease revocation job and expiry).
async function testDeleteNodeContinuesWhenLeaseRevocationFails() {
  const calls: string[] = [];
  let nodeDeleted = false;
  const service = createAdminNodeService({
    logger: {
      warn: () => undefined
    },
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => {
        calls.push("resolve_event_targets");
        return [];
      },
      publishNodeAccessUpdatedToUsers: () => {
        calls.push("publish_event");
      },
      publishSubscriptionUpdated: async () => undefined
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke_local_leases");
        throw new Error("lease revoke failed");
      },
      queueLeaseRevocationJobForNode: async () => {
        calls.push("queue_lease_revocation");
      }
    },
    prisma: {
      node: {
        findUnique: async () => ({ id: "node_1", isActive: true }),
        delete: async () => {
          calls.push("hard_delete");
          nodeDeleted = true;
        }
      }
    }
  });

  const result = await service.deleteNode("node_1");

  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(nodeDeleted, true, "lease revocation failure must not block the hard delete");
  assert.deepEqual(calls, [
    "resolve_event_targets",
    "revoke_local_leases",
    "queue_lease_revocation",
    "hard_delete",
    "publish_event"
  ]);
}

async function testDeleteNodeMapsLocalSaveFailure() {
  let leaseQueued = false;
  let eventTargetsResolved = false;
  let accessPublished = false;
  const service = createAdminNodeService({
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => {
        eventTargetsResolved = true;
        return ["user_1"];
      },
      publishNodeAccessUpdatedToUsers: () => {
        accessPublished = true;
      },
      publishSubscriptionUpdated: async () => {
        accessPublished = true;
      }
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => 0,
      queueLeaseRevocationJobForNode: async () => {
        leaseQueued = true;
      }
    },
    prisma: {
      node: {
        findUnique: async () => ({ id: "node_1", isActive: true }),
        delete: async () => {
          throw new Error("server closed the connection unexpectedly");
        }
      }
    }
  });

  await assert.rejects(
    () => service.deleteNode("node_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /节点删除失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "node delete local save failures must return a controlled 503 instead of HTTP 500"
  );
  assert.equal(leaseQueued, true, "lease revocation job is queued before the hard delete attempt");
  assert.equal(eventTargetsResolved, true, "event target resolution may run before local save");
  assert.equal(accessPublished, false, "failed local save must not publish access/subscription events");
}


async function main() {
  await testDeleteNodeHardDeletesAfterLeaseRevocation();
  await testDeleteNodeReturnsWhenEventTargetResolutionStallsAfterLocalSave();
  await testDeleteNodePublishesAdminEventWhenClientTargetResolutionStalls();
  await testDeleteNodeContinuesWhenLeaseRevocationFails();
  await testDeleteNodeMapsLocalSaveFailure();
  console.log("offline panel delete regression checks passed");
}

void main();
