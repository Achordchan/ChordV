import "reflect-metadata";
import assert from "node:assert/strict";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AdminController } from "../src/modules/admin/admin.controller";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import { AdminRuntimeEventsService } from "../src/modules/common/admin-runtime-events.service";
import { AuthSessionService } from "../src/modules/common/auth-session.service";
import { DevDataService } from "../src/modules/common/dev-data.service";
import { ImageBedService } from "../src/modules/common/image-bed.service";
import { RuntimeComponentsService } from "../src/modules/common/runtime-components.service";

type RouteCall = {
  route: string;
  value: string;
  body?: unknown;
};

const calls: RouteCall[] = [];

Reflect.defineMetadata(
  "design:paramtypes",
  [DevDataService, RuntimeComponentsService, ImageBedService, AdminRuntimeEventsService, AuthSessionService],
  AdminController
);
Reflect.defineMetadata("design:paramtypes", [AuthSessionService], AdminAuthGuard);

const devDataServiceStub = {
  retryAdminPanelSyncJob: async (jobId: string) => {
    calls.push({ route: "panel-job", value: jobId });
    return [{ id: jobId, scope: "job" }];
  },
  retryAdminPanelSyncJobsForNode: async (nodeId: string) => {
    calls.push({ route: "panel-node", value: nodeId });
    return [{ nodeId, scope: "node" }];
  },
  retryAdminLeaseRevocationJob: async (jobId: string) => {
    calls.push({ route: "lease-job", value: jobId });
    return [{ id: jobId, scope: "job" }];
  },
  retryAdminLeaseRevocationJobsForNode: async (nodeId: string) => {
    calls.push({ route: "lease-node", value: nodeId });
    return [{ nodeId, scope: "node" }];
  },
  updateSubscriptionNodeAccess: async (subscriptionId: string, body: unknown) => {
    calls.push({ route: "subscription-nodes", value: subscriptionId, body });
    return { subscriptionId, body, panelSyncStatus: "pending" };
  },
  resetSubscriptionTraffic: async (subscriptionId: string, body: unknown) => {
    calls.push({ route: "subscription-reset-traffic", value: subscriptionId, body });
    return { subscriptionId, body, panelSyncStatus: "pending" };
  },
  disconnectUser: async (userId: string) => {
    calls.push({ route: "user-disconnect", value: userId });
    return { userId, panelSyncStatus: "pending" };
  },
  updateNode: async (nodeId: string, body: unknown) => {
    calls.push({ route: "node-update", value: nodeId, body });
    return { id: nodeId, body, panelSyncStatus: "pending" };
  },
  deleteNode: async (nodeId: string) => {
    calls.push({ route: "node-delete", value: nodeId });
    return { ok: true, nodeId, panelSyncStatus: "pending" };
  },
  probeAllNodes: async () => {
    calls.push({ route: "node-probe-all", value: "all" });
    return [{ id: "node_1", panelStatus: "degraded" }];
  }
};

@Module({
  controllers: [AdminController],
  providers: [
    AdminAuthGuard,
    {
      provide: AuthSessionService,
      useValue: {
        authenticateAccessToken: async () => ({ id: "admin_1", role: "admin" })
      }
    },
    { provide: DevDataService, useValue: devDataServiceStub },
    { provide: RuntimeComponentsService, useValue: {} },
    { provide: ImageBedService, useValue: {} },
    { provide: AdminRuntimeEventsService, useValue: {} }
  ]
})
class TestAdminRoutesModule {}

async function requestJson(baseUrl: string, path: string, init?: { method?: string; body?: unknown }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? "POST",
    headers: {
      authorization: "Bearer admin-test-token",
      ...(init?.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function main() {
  const app = await NestFactory.create(TestAdminRoutesModule, { logger: false });
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");

  try {
    const baseUrl = await app.getUrl();
    assert.deepEqual(await requestJson(baseUrl, "/api/admin/nodes/panel-sync-jobs/job_1/retry"), {
      status: 201,
      body: [{ id: "job_1", scope: "job" }]
    });
    assert.deepEqual(await requestJson(baseUrl, "/api/admin/nodes/node_1/panel-sync-jobs/retry"), {
      status: 201,
      body: [{ nodeId: "node_1", scope: "node" }]
    });
    assert.deepEqual(await requestJson(baseUrl, "/api/admin/nodes/lease-revocation-jobs/lease_job_1/retry"), {
      status: 201,
      body: [{ id: "lease_job_1", scope: "job" }]
    });
    assert.deepEqual(await requestJson(baseUrl, "/api/admin/nodes/node_1/lease-revocation-jobs/retry"), {
      status: 201,
      body: [{ nodeId: "node_1", scope: "node" }]
    });
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/subscriptions/subscription_1/nodes", {
        method: "PUT",
        body: { nodeIds: ["node_1"] }
      }),
      {
        status: 200,
        body: { subscriptionId: "subscription_1", body: { nodeIds: ["node_1"] }, panelSyncStatus: "pending" }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/subscriptions/subscription_1/reset-traffic", {
        body: { userId: "user_1" }
      }),
      {
        status: 201,
        body: { subscriptionId: "subscription_1", body: { userId: "user_1" }, panelSyncStatus: "pending" }
      }
    );
    assert.deepEqual(await requestJson(baseUrl, "/api/admin/users/user_1/disconnect"), {
      status: 201,
      body: { userId: "user_1", panelSyncStatus: "pending" }
    });
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/nodes/node_1", {
        method: "PATCH",
        body: { isActive: false }
      }),
      {
        status: 200,
        body: { id: "node_1", body: { isActive: false }, panelSyncStatus: "pending" }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/nodes/node_1", {
        method: "DELETE"
      }),
      {
        status: 200,
        body: { ok: true, nodeId: "node_1", panelSyncStatus: "pending" }
      }
    );
    assert.deepEqual(await requestJson(baseUrl, "/api/admin/nodes/probe-all"), {
      status: 201,
      body: [{ id: "node_1", panelStatus: "degraded" }]
    });

    assert.deepEqual(calls, [
      { route: "panel-job", value: "job_1" },
      { route: "panel-node", value: "node_1" },
      { route: "lease-job", value: "lease_job_1" },
      { route: "lease-node", value: "node_1" },
      { route: "subscription-nodes", value: "subscription_1", body: { nodeIds: ["node_1"] } },
      { route: "subscription-reset-traffic", value: "subscription_1", body: { userId: "user_1" } },
      { route: "user-disconnect", value: "user_1" },
      { route: "node-update", value: "node_1", body: { isActive: false } },
      { route: "node-delete", value: "node_1" },
      { route: "node-probe-all", value: "all" }
    ]);
  } finally {
    await app.close();
  }

  console.log("admin controller route regression checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
