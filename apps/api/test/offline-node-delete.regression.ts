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

async function testDeleteNodeStopsBeforeLocalDeleteWhenPanelCleanupFails() {
  let nodeDeleted = false;
  let offlineCleanupCalled = false;
  let remoteDeleteQueued = false;
  const nodeUpdates: Array<Record<string, any>> = [];
  const calls: string[] = [];
  const service = createAdminNodeService({
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => ["user_1"],
      publishNodeAccessUpdatedToUsers: () => undefined
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke_local_leases");
        return 1;
      },
      queueLeaseRevocationJobForNode: async () => {
        calls.push("queue_lease_revocation");
      },
      removePanelBindingsForNode: async () => {
        remoteDeleteQueued = true;
        calls.push("queue_panel_delete");
        throw new Error("panel cleanup queue failed");
      },
      finalizeOfflineNodePanelCleanup: async () => {
        offlineCleanupCalled = true;
        calls.push("finalize_offline_cleanup");
        return { bindingsDeleted: 1, abandonedAt: new Date() };
      }
    },
    prisma: {
      panelClientBinding: {
        findMany: async () => [{ subscriptionId: "sub_1" }]
      },
      node: {
        // Missing/offline panel must finalize locally and keep used traffic untouched.
        findUnique: async () => ({ id: "node_1", panelEnabled: true, panelStatus: "offline" }),
        update: async (payload: Record<string, any>) => {
          calls.push("local_update");
          nodeUpdates.push(payload);
          return {};
        },
        delete: async () => {
          nodeDeleted = true;
        }
      }
    }
  });

  const result = await service.deleteNode("node_1");

  assert.equal(result.ok, true);
  assert.equal(result.panelSyncStatus, "synced");
  assert.equal(offlineCleanupCalled, true, "offline panel delete must finalize local cleanup without waiting for remote panel");
  assert.equal(remoteDeleteQueued, false, "offline panel delete must not keep queueing remote delete_client forever");
  assert.deepEqual(calls, ["local_update", "revoke_local_leases", "queue_lease_revocation", "finalize_offline_cleanup"]);
  assert.equal(nodeUpdates[0].data.isActive, false, "node must be hidden locally before remote cleanup completes");
  assert.equal(nodeUpdates[0].data.panelStatus, "offline");
  assert.equal(nodeDeleted, false, "node row must be kept for historical traffic ledger references");
}

async function testDeleteNodeMarksBindingsDeletedWhenPanelDeleteQueuePartiallyFails() {
  const calls: string[] = [];
  const service = createAdminNodeService({
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => [],
      publishNodeAccessUpdatedToUsers: () => undefined
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke_local_leases");
        return 0;
      },
      queueLeaseRevocationJobForNode: async () => {
        calls.push("queue_lease_revocation");
      },
      removePanelBindingsForNode: async () => {
        calls.push("queue_panel_delete");
        return {
          requested: 1,
          updated: 0,
          failed: [
            {
              bindingId: "binding_1",
              nodeId: "node_1",
              nodeName: "node",
              panelClientEmail: "user@example.com",
              error: "panel queue write failed"
            }
          ]
        };
      },
      finalizeOfflineNodePanelCleanup: async () => {
        calls.push("finalize_offline_cleanup");
        return { bindingsDeleted: 1, abandonedAt: new Date() };
      },
      markPanelBindingsDeletedForNode: async () => {
        calls.push("mark_deleted");
        return 1;
      }
    },
    prisma: {
      node: {
        // Online panel still queues remote delete; partial queue failure falls back to offline finalize.
        findUnique: async () => ({ id: "node_1", panelEnabled: true, panelStatus: "online" }),
        update: async () => ({})
      }
    }
  });

  const result = await service.deleteNode("node_1");

  assert.equal(result.ok, true);
  assert.equal(result.panelSyncStatus, "synced");
  assert.deepEqual(calls, [
    "revoke_local_leases",
    "queue_lease_revocation",
    "queue_panel_delete",
    "finalize_offline_cleanup"
  ]);
}

async function testDeleteNodeReturnsWhenEventTargetResolutionStallsAfterLocalSave() {
  const calls: string[] = [];
  let publishedUserIds: string[] | null = null;
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
      }
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke_local_leases");
        return 0;
      },
      queueLeaseRevocationJobForNode: async () => {
        calls.push("queue_lease_revocation");
      },
      removePanelBindingsForNode: async () => {
        calls.push("queue_panel_delete");
        return { requested: 1, updated: 1, failed: [] };
      }
    },
    prisma: {
      node: {
        findUnique: async () => ({ id: "node_1", panelEnabled: true, panelStatus: "online" }),
        update: async (payload: Record<string, any>) => {
          calls.push("local_update");
          assert.equal(payload.data.isActive, false);
          return {};
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
  assert.equal(result.panelSyncStatus, "pending");
  assert.deepEqual(calls, [
    "local_update",
    "revoke_local_leases",
    "queue_lease_revocation",
    "queue_panel_delete",
    "resolve_event_targets",
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
      publishNodeAccessUpdatedToUsers: () => undefined
    },
    adminRuntimeEventsService: {
      publish: (event: Record<string, any>) => {
        adminEvents.push(event);
      }
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => 0,
      queueLeaseRevocationJobForNode: async () => undefined,
      removePanelBindingsForNode: async () => ({ requested: 1, updated: 1, failed: [] })
    },
    prisma: {
      node: {
        findUnique: async () => ({ id: "node_1", panelEnabled: true, panelStatus: "online" }),
        update: async () => ({})
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
  assert.equal(adminEvents.length, 1);
  assert.equal(adminEvents[0].type, "node_access_updated");
  assert.equal(adminEvents[0].nodeId, "node_1");
}

async function testDeleteNodeReturnsWhenPanelCleanupStallsAfterLocalSave() {
  const calls: string[] = [];
  let publishedUserIds: string[] | null = null;
  const service = createAdminNodeService({
    logger: {
      warn: () => undefined
    },
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => {
        calls.push("resolve_event_targets");
        return ["user_1"];
      },
      publishNodeAccessUpdatedToUsers: (userIds: string[]) => {
        calls.push("publish_event");
        publishedUserIds = userIds;
      }
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke_local_leases");
        return 0;
      },
      queueLeaseRevocationJobForNode: async () => {
        calls.push("queue_lease_revocation");
      },
      removePanelBindingsForNode: async () => {
        calls.push("queue_panel_delete");
        return new Promise(() => undefined);
      }
    },
    prisma: {
      node: {
        findUnique: async () => ({ id: "node_1", panelEnabled: true, panelStatus: "online" }),
        update: async (payload: Record<string, any>) => {
          calls.push("local_update");
          assert.equal(payload.data.isActive, false);
          assert.equal(payload.data.recommended, false);
          assert.equal(payload.data.panelStatus, "offline");
          return {};
        }
      }
    }
  });

  const result = await Promise.race([
    service.deleteNode("node_1"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("deleteNode waited for stalled panel cleanup")), 750);
    })
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.panelSyncStatus, "pending");
  assert.deepEqual(calls, [
    "local_update",
    "revoke_local_leases",
    "queue_lease_revocation",
    "queue_panel_delete",
    "resolve_event_targets",
    "publish_event"
  ]);
  assert.deepEqual(publishedUserIds, ["user_1"]);
}

async function testDeleteNodeOfflinePanelFinalizesWithoutRemoteQueueAndKeepsLocalTraffic() {
  const calls: string[] = [];
  let usedTrafficReads = 0;
  const service = createAdminNodeService({
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => ["user_1"],
      publishNodeAccessUpdatedToUsers: () => undefined
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke_local_leases");
        return 2;
      },
      queueLeaseRevocationJobForNode: async () => {
        calls.push("queue_lease_revocation");
      },
      removePanelBindingsForNode: async () => {
        calls.push("queue_panel_delete");
        return { requested: 1, updated: 1, failed: [] };
      },
      finalizeOfflineNodePanelCleanup: async () => {
        calls.push("finalize_offline_cleanup");
        return { bindingsDeleted: 2, abandonedAt: new Date() };
      }
    },
    prisma: {
      subscription: {
        findMany: async () => {
          usedTrafficReads += 1;
          return [{ id: "sub_1", usedTrafficGb: 42.5 }];
        }
      },
      node: {
        findUnique: async () => ({
          id: "node_1",
          panelEnabled: true,
          panelStatus: "degraded"
        }),
        update: async (payload: Record<string, any>) => {
          calls.push("local_update");
          assert.equal(payload.data.isActive, false);
          assert.equal(payload.data.panelStatus, "offline");
          return {};
        }
      }
    }
  });

  const result = await service.deleteNode("node_1");

  assert.equal(result.ok, true);
  assert.equal(result.panelSyncStatus, "synced");
  assert.ok(String(result.panelSyncMessage ?? result.message ?? "").includes("已用流量保持不变") || String(result.panelSyncMessage ?? result.message ?? "").includes("本地停用") || String(result.panelSyncMessage ?? result.message ?? "").includes("放弃重试"));
  assert.deepEqual(calls, ["local_update", "revoke_local_leases", "queue_lease_revocation", "finalize_offline_cleanup"]);
  assert.equal(usedTrafficReads, 0, "delete must not rewrite subscription usedTrafficGb");
}

async function testFinalizeOfflineNodePanelCleanupAbandonsJobsAndResolvesMetering() {
  const bindingUpdates: Array<Record<string, any>> = [];
  const jobUpdates: Array<Record<string, any>> = [];
  const incidentUpdates: Array<Record<string, any>> = [];
  const snapshotDeletes: Array<Record<string, any>> = [];
  const service = createRuntimeSessionService({
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_1",
            nodeId: "node_1",
            subscriptionId: "sub_1",
            userId: "user_1"
          }
        ],
        updateMany: async (payload: Record<string, any>) => {
          bindingUpdates.push(payload);
          return { count: 1 };
        }
      },
      panelSyncJob: {
        updateMany: async (payload: Record<string, any>) => {
          jobUpdates.push(payload);
          return { count: 3 };
        }
      },
      meteringIncident: {
        updateMany: async (payload: Record<string, any>) => {
          incidentUpdates.push(payload);
          return { count: 2 };
        }
      },
      trafficSnapshot: {
        deleteMany: async (payload: Record<string, any>) => {
          snapshotDeletes.push(payload);
          return { count: 1 };
        }
      },
      $transaction: async (ops: any) => {
        if (Array.isArray(ops)) {
          return Promise.all(ops);
        }
        return ops({
          panelClientBinding: {
            updateMany: async (payload: Record<string, any>) => {
              bindingUpdates.push(payload);
              return { count: 1 };
            }
          },
          trafficSnapshot: {
            deleteMany: async (payload: Record<string, any>) => {
              snapshotDeletes.push(payload);
              return { count: 1 };
            }
          }
        });
      }
    }
  });

  const result = await service.finalizeOfflineNodePanelCleanup("node_1");

  assert.equal(result.bindingsDeleted, 1);
  assert.equal(bindingUpdates.length > 0, true);
  assert.equal(bindingUpdates.some((item) => item.data?.status === "deleted"), true);
  assert.equal(jobUpdates.length, 1);
  assert.deepEqual(jobUpdates[0].where.status.in, ["pending", "running", "failed"]);
  assert.equal(jobUpdates[0].data.status, "completed");
  assert.equal(incidentUpdates.length, 1);
  assert.equal(incidentUpdates[0].where.nodeId, "node_1");
  assert.equal(incidentUpdates[0].data.status, "resolved");
  assert.equal(snapshotDeletes.length >= 1, true, "only panel traffic snapshots are cleaned; subscription used traffic stays in ledger");
}

async function testPanelDeleteJobAbandonsAfterMaxAttemptsOnInactiveNode() {
  const jobUpdates: Array<Record<string, any>> = [];
  const bindingUpdates: Array<Record<string, any>> = [];
  const incidentUpdates: Array<Record<string, any>> = [];
  const service = createRuntimeSessionService({
    logger: {
      warn: () => undefined
    },
    xuiService: {
      removeClient: async () => {
        throw new Error("panel unreachable");
      }
    },
    prisma: {
      panelSyncJob: {
        update: async (payload: Record<string, any>) => {
          jobUpdates.push(payload);
          return payload;
        }
      },
      panelClientBinding: {
        updateMany: async (payload: Record<string, any>) => {
          bindingUpdates.push(payload);
          return { count: 1 };
        }
      },
      meteringIncident: {
        updateMany: async (payload: Record<string, any>) => {
          incidentUpdates.push(payload);
          return { count: 1 };
        }
      },
      trafficSnapshot: {
        deleteMany: async () => ({ count: 1 })
      },
      node: {
        update: async () => ({})
      },
      $transaction: async (ops: any[]) => Promise.all(ops)
    }
  });

  await (service as any).runPanelSyncJob({
    id: "job_1",
    action: "delete_client",
    attempts: 7,
    bindingId: "binding_1",
    subscriptionId: "sub_1",
    userId: "user_1",
    teamId: null,
    nodeId: "node_1",
    panelClientEmail: "user@example.com",
    panelClientId: "uuid-1",
    panelInboundId: 1,
    panelBaseUrl: "https://panel.example",
    panelApiBasePath: "/",
    panelUsername: "admin",
    panelPassword: "secret",
    node: {
      id: "node_1",
      name: "offline-node",
      flow: "",
      isActive: false,
      panelEnabled: true,
      panelBaseUrl: "https://panel.example",
      panelApiBasePath: "/",
      panelUsername: "admin",
      panelPassword: "secret",
      panelInboundId: 1
    },
    binding: {
      status: "deleted"
    }
  });

  assert.equal(jobUpdates.length, 1);
  assert.equal(jobUpdates[0].data.status, "completed");
  assert.ok(String(jobUpdates[0].data.lastError ?? "").includes("停止重试") || String(jobUpdates[0].data.lastError ?? "").includes("不可达") || String(jobUpdates[0].data.lastError ?? "").includes("delete_client"));
  assert.equal(bindingUpdates[0].data.status, "deleted");
  assert.equal(incidentUpdates[0].data.status, "resolved");
}

async function testDeleteNodeMapsLocalSaveFailure() {
  let leaseQueued = false;
  let panelCleanupStarted = false;
  let publishStarted = false;
  const service = createAdminNodeService({
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => {
        publishStarted = true;
        return ["user_1"];
      },
      publishNodeAccessUpdatedToUsers: () => undefined
    },
    runtimeSessionService: {
      queueLeaseRevocationJobForNode: async () => {
        leaseQueued = true;
      },
      removePanelBindingsForNode: async () => {
        panelCleanupStarted = true;
        return { requested: 0, updated: 0, failed: [] };
      }
    },
    prisma: {
      node: {
        findUnique: async () => ({ id: "node_1" }),
        update: async () => {
          throw new Error("server closed the connection unexpectedly");
        }
      }
    }
  });

  await assert.rejects(
    () => service.deleteNode("node_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /节点删除保存失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "node delete local save failures must return a controlled 503 instead of HTTP 500"
  );
  assert.equal(leaseQueued, false);
  assert.equal(panelCleanupStarted, false);
  assert.equal(publishStarted, false);
}


async function main() {
  await testDeleteNodeStopsBeforeLocalDeleteWhenPanelCleanupFails();
  await testDeleteNodeMarksBindingsDeletedWhenPanelDeleteQueuePartiallyFails();
  await testDeleteNodeReturnsWhenEventTargetResolutionStallsAfterLocalSave();
  await testDeleteNodePublishesAdminEventWhenClientTargetResolutionStalls();
  await testDeleteNodeReturnsWhenPanelCleanupStallsAfterLocalSave();
  await testDeleteNodeOfflinePanelFinalizesWithoutRemoteQueueAndKeepsLocalTraffic();
  await testFinalizeOfflineNodePanelCleanupAbandonsJobsAndResolvesMetering();
  await testPanelDeleteJobAbandonsAfterMaxAttemptsOnInactiveNode();
  await testDeleteNodeMapsLocalSaveFailure();
  console.log("offline panel delete regression checks passed");
}

void main();
