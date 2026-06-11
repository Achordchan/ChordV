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

async function requestJson(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer admin-test-token"
    }
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

    assert.deepEqual(calls, [
      { route: "panel-job", value: "job_1" },
      { route: "panel-node", value: "node_1" },
      { route: "lease-job", value: "lease_job_1" },
      { route: "lease-node", value: "node_1" }
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
