import "reflect-metadata";
import assert from "node:assert/strict";
import { ForbiddenException, Module, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AdminController } from "../src/modules/admin/admin.controller";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import { AdminRuntimeEventsService } from "../src/modules/common/admin-runtime-events.service";
import { AuthSessionService } from "../src/modules/common/auth-session.service";
import { ClientAuthGuard } from "../src/modules/common/client-auth.guard";
import { DevDataService } from "../src/modules/common/dev-data.service";
import { ImageBedService } from "../src/modules/common/image-bed.service";
import { RuntimeComponentsService } from "../src/modules/common/runtime-components.service";
import { ClientController } from "../src/modules/client/client.controller";
import { ClientService } from "../src/modules/client/client.service";
import { DownloadsController } from "../src/modules/client/downloads.controller";

type RouteCall = {
  route: string;
  value: string;
  body?: unknown;
  file?: {
    originalname?: string;
    mimetype?: string;
    size?: number;
  } | null;
};

const calls: RouteCall[] = [];
const releaseDownloadPath = "virtual-release.zip";

Reflect.defineMetadata(
  "design:paramtypes",
  [DevDataService, RuntimeComponentsService, ImageBedService, AdminRuntimeEventsService, AuthSessionService],
  AdminController
);
Reflect.defineMetadata("design:paramtypes", [DevDataService, RuntimeComponentsService], DownloadsController);
Reflect.defineMetadata("design:paramtypes", [ClientService, RuntimeComponentsService], ClientController);
Reflect.defineMetadata("design:paramtypes", [AuthSessionService], AdminAuthGuard);
Reflect.defineMetadata("design:paramtypes", [AuthSessionService], ClientAuthGuard);

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
  updateUser: async (userId: string, body: unknown) => {
    calls.push({ route: "user-update", value: userId, body });
    return { id: userId, body, panelSyncStatus: "pending" };
  },
  updateTeam: async (teamId: string, body: unknown) => {
    calls.push({ route: "team-update", value: teamId, body });
    return { id: teamId, body, panelSyncStatus: "pending" };
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
  },
  createAnnouncement: async (body: unknown) => {
    calls.push({ route: "announcement-create", value: "new", body });
    return { id: "announcement_1", body };
  },
  updateAnnouncement: async (announcementId: string, body: unknown) => {
    calls.push({ route: "announcement-update", value: announcementId, body });
    return { id: announcementId, body };
  },
  deleteAnnouncement: async (announcementId: string) => {
    calls.push({ route: "announcement-delete", value: announcementId });
    return { ok: true, announcementId };
  },
  createRelease: async (body: unknown) => {
    calls.push({ route: "release-create", value: "new", body });
    return { id: "release_1", body };
  },
  updateRelease: async (releaseId: string, body: unknown) => {
    calls.push({ route: "release-update", value: releaseId, body });
    return { id: releaseId, body };
  },
  publishRelease: async (releaseId: string) => {
    calls.push({ route: "release-publish", value: releaseId });
    return { id: releaseId, status: "published" };
  },
  unpublishRelease: async (releaseId: string) => {
    calls.push({ route: "release-unpublish", value: releaseId });
    return { id: releaseId, status: "draft" };
  },
  createReleaseArtifact: async (releaseId: string, body: unknown) => {
    calls.push({ route: "release-artifact-create", value: releaseId, body });
    return { id: releaseId, artifact: body };
  },
  uploadReleaseArtifact: async (releaseId: string, body: unknown, file?: Express.Multer.File) => {
    calls.push({ route: "release-artifact-upload", value: releaseId, body: toPlainJson(body), file: summarizeUploadedFile(file) });
    return { id: releaseId, artifact: body, file: summarizeUploadedFile(file) };
  },
  updateReleaseArtifact: async (releaseId: string, artifactId: string, body: unknown) => {
    calls.push({ route: "release-artifact-update", value: `${releaseId}:${artifactId}`, body });
    return { id: releaseId, artifactId, artifact: body };
  },
  deleteReleaseArtifact: async (releaseId: string, artifactId: string) => {
    calls.push({ route: "release-artifact-delete", value: `${releaseId}:${artifactId}` });
    return { id: releaseId, deletedArtifactId: artifactId };
  },
  replaceReleaseArtifactUpload: async (releaseId: string, artifactId: string, body: unknown, file?: Express.Multer.File) => {
    calls.push({
      route: "release-artifact-replace-upload",
      value: `${releaseId}:${artifactId}`,
      body: toPlainJson(body),
      file: summarizeUploadedFile(file)
    });
    return { id: releaseId, artifactId, artifact: body, file: summarizeUploadedFile(file) };
  },
  getReleaseArtifactDownloadDescriptor: async (artifactId: string) => {
    calls.push({ route: "release-download", value: artifactId });
    return { absolutePath: releaseDownloadPath, fileName: "ChordV_1.1.7_x64-full.zip" };
  },
  getAdminSupportTicketDetail: async (ticketId: string) => {
    calls.push({ route: "ticket-detail", value: ticketId });
    return { id: ticketId };
  },
  replyAdminSupportTicketWithAttachment: async (ticketId: string, body: unknown, file?: Express.Multer.File, adminId?: string | null) => {
    calls.push({
      route: "ticket-attachment",
      value: ticketId,
      body: { ...toPlainJson(body), adminId },
      file: summarizeUploadedFile(file)
    });
    return { id: ticketId, body, file: summarizeUploadedFile(file) };
  }
};

const runtimeComponentsServiceStub = {
  listAdminRuntimeComponents: async () => {
    calls.push({ route: "runtime-list", value: "all" });
    return [];
  },
  listRuntimeComponentFailureReports: async (limit?: number) => {
    calls.push({ route: "runtime-failures", value: String(limit ?? "") });
    return [];
  },
  uploadAdminRuntimeComponent: async (body: unknown, file?: Express.Multer.File) => {
    calls.push({ route: "runtime-upload", value: "new", body: toPlainJson(body), file: summarizeUploadedFile(file) });
    return { id: "component_1", body, file: summarizeUploadedFile(file) };
  },
  replaceAdminRuntimeComponentUpload: async (componentId: string, body: unknown, file?: Express.Multer.File) => {
    calls.push({ route: "runtime-replace-upload", value: componentId, body: toPlainJson(body), file: summarizeUploadedFile(file) });
    return { id: componentId, body, file: summarizeUploadedFile(file) };
  },
  validateAdminRuntimeComponent: async (componentId: string) => {
    calls.push({ route: "runtime-verify", value: componentId });
    return { id: componentId, validationStatus: "ready" };
  },
  deleteAdminRuntimeComponent: async (componentId: string) => {
    calls.push({ route: "runtime-delete", value: componentId });
    return { ok: true, componentId };
  }
};

const imageBedServiceStub = {
  getAdminConfig: async () => {
    calls.push({ route: "image-bed-config-get", value: "config" });
    return { baseUrl: "https://image.example.com" };
  },
  updateAdminConfig: async (body: unknown) => {
    calls.push({ route: "image-bed-config-update", value: "config", body: toPlainJson(body) });
    return { ...toPlainJson(body), configured: true };
  },
  listAdminFiles: async (query: unknown) => {
    calls.push({ route: "image-bed-files-list", value: "files", body: toPlainJson(query) });
    return { files: [], query: toPlainJson(query) };
  },
  deleteAdminFile: async (query: unknown) => {
    calls.push({ route: "image-bed-file-delete", value: "files", body: toPlainJson(query) });
    return { ok: true, query: toPlainJson(query) };
  }
};

const clientServiceStub = {
  replySupportTicketWithAttachment: async (
    ticketId: string,
    body: unknown,
    file?: Express.Multer.File,
    authorization?: string
  ) => {
    calls.push({
      route: "client-ticket-attachment",
      value: ticketId,
      body: { ...toPlainJson(body), authorization },
      file: summarizeUploadedFile(file)
    });
    return { id: ticketId, body, file: summarizeUploadedFile(file) };
  }
};

async function testAdminSseRejectsNonAdminWithForbiddenException() {
  let validate: (() => Promise<void>) | undefined;
  const controller = new AdminController(
    devDataServiceStub as any,
    runtimeComponentsServiceStub as any,
    imageBedServiceStub as any,
    {
      stream: (input: { validate?: () => Promise<void> }) => {
        validate = input.validate;
        return {};
      }
    } as any,
    {
      authenticateAccessToken: async () => ({ id: "user_1", role: "user" })
    } as any
  );

  controller.streamEvents("Bearer user-test-token");

  assert.equal(typeof validate, "function");
  await assert.rejects(
    () => validate?.() ?? Promise.resolve(),
    (error) => error instanceof ForbiddenException && /需要管理员权限/.test(error.message),
    "admin SSE non-admin validation must return 403 instead of leaking a default HTTP 500"
  );
}

async function testAdminSseRouteMetadataAndAdminValidation() {
  const streamEventsHandler = AdminController.prototype.streamEvents;
  assert.equal(Reflect.getMetadata("path", streamEventsHandler), "events/stream");
  assert.equal(Reflect.getMetadata("method", streamEventsHandler), 0);
  assert.equal(Reflect.getMetadata("__sse__", streamEventsHandler), true);

  let observedInput:
    | {
        lastEventId?: string;
        validate?: () => Promise<void>;
      }
    | undefined;
  const controller = new AdminController(
    devDataServiceStub as any,
    runtimeComponentsServiceStub as any,
    imageBedServiceStub as any,
    {
      stream: (input: { lastEventId?: string; validate?: () => Promise<void> }) => {
        observedInput = input;
        return {};
      }
    } as any,
    {
      authenticateAccessToken: async (authorization?: string) => {
        assert.equal(authorization, "Bearer admin-test-token");
        return { id: "admin_1", role: "admin" };
      }
    } as any
  );

  controller.streamEvents("Bearer admin-test-token", "event_123");

  assert.equal(observedInput?.lastEventId, "event_123");
  assert.equal(typeof observedInput?.validate, "function");
  await observedInput?.validate?.();
}

@Module({
  controllers: [AdminController, DownloadsController, ClientController],
  providers: [
    AdminAuthGuard,
    ClientAuthGuard,
    {
      provide: AuthSessionService,
      useValue: {
        authenticateAccessToken: async (authorization?: string) =>
          authorization === "Bearer user-test-token" ? { id: "user_1", role: "user" } : { id: "admin_1", role: "admin" }
      }
    },
    { provide: DevDataService, useValue: devDataServiceStub },
    { provide: ClientService, useValue: clientServiceStub },
    { provide: RuntimeComponentsService, useValue: runtimeComponentsServiceStub },
    { provide: ImageBedService, useValue: imageBedServiceStub },
    { provide: AdminRuntimeEventsService, useValue: {} }
  ]
})
class TestAdminRoutesModule {}

function summarizeUploadedFile(file?: Express.Multer.File) {
  if (!file) {
    return null;
  }
  return {
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size
  };
}

function toPlainJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

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

async function requestMultipartJson(
  baseUrl: string,
  path: string,
  fields: Record<string, string>,
  fileName = "ChordV_1.1.7_x64-full.zip",
  fileContent = "release artifact",
  mimeType = "application/zip",
  authorization = "Bearer admin-test-token"
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  form.set("file", new Blob([fileContent], { type: mimeType }), fileName);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization
    },
    body: form
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function requestText(baseUrl: string, routePath: string) {
  const response = await fetch(`${baseUrl}${routePath}`);
  return {
    status: response.status
  };
}

async function main() {
  await testAdminSseRejectsNonAdminWithForbiddenException();
  await testAdminSseRouteMetadataAndAdminValidation();

  const app = await NestFactory.create(TestAdminRoutesModule, { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true
    })
  );
  await app.listen(0, "127.0.0.1");
  const expressApp = app.getHttpAdapter().getInstance() as {
    response: {
      download: (absolutePath: string, fileName: string, callback?: (error?: Error) => void) => unknown;
    };
  };
  const originalDownload = expressApp.response.download;
  const downloadCalls: Array<{ absolutePath: string; fileName: string }> = [];
  expressApp.response.download = function (
    this: { status: (code: number) => { end: () => void } },
    absolutePath: string,
    fileName: string,
    callback?: (error?: Error) => void
  ) {
    downloadCalls.push({ absolutePath, fileName });
    this.status(204).end();
    callback?.();
    return this;
  };

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
      await requestJson(baseUrl, "/api/admin/users/user_1", {
        method: "PATCH",
        body: { status: "disabled" }
      }),
      {
        status: 200,
        body: { id: "user_1", body: { status: "disabled" }, panelSyncStatus: "pending" }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/teams/team_1", {
        method: "PATCH",
        body: { status: "disabled" }
      }),
      {
        status: 200,
        body: { id: "team_1", body: { status: "disabled" }, panelSyncStatus: "pending" }
      }
    );
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
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/announcements", {
        body: { title: "公告", content: "内容", priority: "normal" }
      }),
      {
        status: 201,
        body: { id: "announcement_1", body: { title: "公告", content: "内容", priority: "normal" } }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/announcements/announcement_1", {
        method: "PATCH",
        body: { title: "公告更新" }
      }),
      {
        status: 200,
        body: { id: "announcement_1", body: { title: "公告更新" } }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/announcements/announcement_1", {
        method: "DELETE"
      }),
      {
        status: 200,
        body: { ok: true, announcementId: "announcement_1" }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/releases", {
        body: { version: "1.1.7", displayTitle: "", channel: "stable" }
      }),
      {
        status: 201,
        body: { id: "release_1", body: { version: "1.1.7", displayTitle: "", channel: "stable" } }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/releases/release_1", {
        method: "PATCH",
        body: { displayTitle: "" }
      }),
      {
        status: 200,
        body: { id: "release_1", body: { displayTitle: "" } }
      }
    );
    assert.deepEqual(await requestJson(baseUrl, "/api/admin/releases/release_1/publish"), {
      status: 201,
      body: { id: "release_1", status: "published" }
    });
    assert.deepEqual(await requestJson(baseUrl, "/api/admin/releases/release_1/unpublish"), {
      status: 201,
      body: { id: "release_1", status: "draft" }
    });
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/releases/release_1/artifacts", {
        body: {
          platform: "windows",
          architecture: "x64",
          artifactType: "full_replace",
          sourceType: "external",
          downloadUrl: "https://download.example.com/ChordV_1.1.7_x64-full.zip"
        }
      }),
      {
        status: 201,
        body: {
          id: "release_1",
          artifact: {
            platform: "windows",
            architecture: "x64",
            artifactType: "full_replace",
            sourceType: "external",
            downloadUrl: "https://download.example.com/ChordV_1.1.7_x64-full.zip"
          }
        }
      }
    );
    assert.deepEqual(
      await requestMultipartJson(baseUrl, "/api/admin/releases/release_1/artifacts/upload", {
        source: "uploaded",
        type: "zip",
        deliveryMode: "desktop_full_replace",
        fileName: "ChordV_1.1.7_x64-full.zip",
        isPrimary: "true"
      }),
      {
        status: 201,
        body: {
          id: "release_1",
          artifact: {
            source: "uploaded",
            type: "zip",
            deliveryMode: "desktop_full_replace",
            fileName: "ChordV_1.1.7_x64-full.zip",
            isPrimary: "true"
          },
          file: {
            originalname: "ChordV_1.1.7_x64-full.zip",
            mimetype: "application/zip",
            size: 16
          }
        }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/releases/release_1/artifacts/artifact_1", {
        method: "PATCH",
        body: { sha256: "" }
      }),
      {
        status: 200,
        body: { id: "release_1", artifactId: "artifact_1", artifact: { sha256: "" } }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/releases/release_1/artifacts/artifact_1", {
        method: "DELETE"
      }),
      {
        status: 200,
        body: { id: "release_1", deletedArtifactId: "artifact_1" }
      }
    );
    assert.deepEqual(
      await requestMultipartJson(baseUrl, "/api/admin/releases/release_1/artifacts/artifact_1/upload", {
        source: "uploaded",
        type: "zip",
        deliveryMode: "desktop_full_replace",
        fileName: "ChordV_1.1.7_x64-full.zip",
        isPrimary: "true"
      }),
      {
        status: 201,
        body: {
          id: "release_1",
          artifactId: "artifact_1",
          artifact: {
            source: "uploaded",
            type: "zip",
            deliveryMode: "desktop_full_replace",
            fileName: "ChordV_1.1.7_x64-full.zip",
            isPrimary: "true"
          },
          file: {
            originalname: "ChordV_1.1.7_x64-full.zip",
            mimetype: "application/zip",
            size: 16
          }
        }
      }
    );
    assert.deepEqual(await requestText(baseUrl, "/api/downloads/releases/artifact_1"), {
      status: 204
    });
    assert.deepEqual(downloadCalls, [{ absolutePath: releaseDownloadPath, fileName: "ChordV_1.1.7_x64-full.zip" }]);
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/image-bed/config", {
        method: "GET"
      }),
      {
        status: 200,
        body: { baseUrl: "https://image.example.com" }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/image-bed/config", {
        method: "PATCH",
        body: {
          baseUrl: "https://image.example.com",
          apiToken: "token",
          uploadFolder: "uat",
          uploadChannel: "telegram",
          channelName: "UAT"
        }
      }),
      {
        status: 200,
        body: {
          baseUrl: "https://image.example.com",
          apiToken: "token",
          uploadFolder: "uat",
          uploadChannel: "telegram",
          channelName: "UAT",
          configured: true
        }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/image-bed/files?start=2&count=5&search=uat&dir=tests&recursive=true", {
        method: "GET"
      }),
      {
        status: 200,
        body: { files: [], query: { start: "2", count: "5", search: "uat", dir: "tests", recursive: "true" } }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/image-bed/files?path=tests%2Fuat.png&folder=false", {
        method: "DELETE"
      }),
      {
        status: 200,
        body: { ok: true, query: { path: "tests/uat.png", folder: "false" } }
      }
    );
    assert.deepEqual(
      await requestMultipartJson(
        baseUrl,
        "/api/admin/tickets/ticket_1/attachments",
        { body: "带附件回复" },
        "ticket-attachment.png",
        "png",
        "image/png"
      ),
      {
        status: 201,
        body: {
          id: "ticket_1",
          body: { body: "带附件回复" },
          file: {
            originalname: "ticket-attachment.png",
            mimetype: "image/png",
            size: 3
          }
        }
      }
    );
    assert.deepEqual(
      await requestMultipartJson(
        baseUrl,
        "/api/client/tickets/ticket_1/attachments",
        { body: "client attachment reply" },
        "client-ticket.png",
        "png",
        "image/png",
        "Bearer user-test-token"
      ),
      {
        status: 201,
        body: {
          id: "ticket_1",
          body: { body: "client attachment reply" },
          file: {
            originalname: "client-ticket.png",
            mimetype: "image/png",
            size: 3
          }
        }
      }
    );
    assert.deepEqual(
      await requestMultipartJson(
        baseUrl,
        "/api/admin/runtime-components/upload",
        {
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          fileName: "xray.zip",
          enabled: "true"
        },
        "xray.zip",
        "runtime"
      ),
      {
        status: 201,
        body: {
          id: "component_1",
          body: {
            platform: "windows",
            architecture: "x64",
            kind: "xray",
            fileName: "xray.zip",
            enabled: "true"
          },
          file: {
            originalname: "xray.zip",
            mimetype: "application/zip",
            size: 7
          }
        }
      }
    );
    assert.deepEqual(
      await requestMultipartJson(
        baseUrl,
        "/api/admin/runtime-components/component_1/upload",
        {
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          fileName: "xray.zip",
          enabled: "true"
        },
        "xray.zip",
        "runtime"
      ),
      {
        status: 201,
        body: {
          id: "component_1",
          body: {
            platform: "windows",
            architecture: "x64",
            kind: "xray",
            fileName: "xray.zip",
            enabled: "true"
          },
          file: {
            originalname: "xray.zip",
            mimetype: "application/zip",
            size: 7
          }
        }
      }
    );
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/runtime-components/failures?limit=10", {
        method: "GET"
      }),
      { status: 200, body: [] }
    );
    assert.deepEqual(await requestJson(baseUrl, "/api/admin/runtime-components/component_1/verify"), {
      status: 201,
      body: { id: "component_1", validationStatus: "ready" }
    });
    assert.deepEqual(
      await requestJson(baseUrl, "/api/admin/runtime-components/component_1", {
        method: "DELETE"
      }),
      { status: 200, body: { ok: true, componentId: "component_1" } }
    );

    assert.deepEqual(calls, [
      { route: "panel-job", value: "job_1" },
      { route: "panel-node", value: "node_1" },
      { route: "lease-job", value: "lease_job_1" },
      { route: "lease-node", value: "node_1" },
      { route: "subscription-nodes", value: "subscription_1", body: { nodeIds: ["node_1"] } },
      { route: "subscription-reset-traffic", value: "subscription_1", body: { userId: "user_1" } },
      { route: "user-disconnect", value: "user_1" },
      { route: "user-update", value: "user_1", body: { status: "disabled" } },
      { route: "team-update", value: "team_1", body: { status: "disabled" } },
      { route: "node-update", value: "node_1", body: { isActive: false } },
      { route: "node-delete", value: "node_1" },
      { route: "node-probe-all", value: "all" },
      { route: "announcement-create", value: "new", body: { title: "公告", content: "内容", priority: "normal" } },
      { route: "announcement-update", value: "announcement_1", body: { title: "公告更新" } },
      { route: "announcement-delete", value: "announcement_1" },
      { route: "release-create", value: "new", body: { version: "1.1.7", displayTitle: "", channel: "stable" } },
      { route: "release-update", value: "release_1", body: { displayTitle: "" } },
      { route: "release-publish", value: "release_1" },
      { route: "release-unpublish", value: "release_1" },
      {
        route: "release-artifact-create",
        value: "release_1",
        body: {
          platform: "windows",
          architecture: "x64",
          artifactType: "full_replace",
          sourceType: "external",
          downloadUrl: "https://download.example.com/ChordV_1.1.7_x64-full.zip"
        }
      },
      {
        route: "release-artifact-upload",
        value: "release_1",
        body: {
          source: "uploaded",
          type: "zip",
          deliveryMode: "desktop_full_replace",
          fileName: "ChordV_1.1.7_x64-full.zip",
          isPrimary: "true"
        },
        file: {
          originalname: "ChordV_1.1.7_x64-full.zip",
          mimetype: "application/zip",
          size: 16
        }
      },
      { route: "release-artifact-update", value: "release_1:artifact_1", body: { sha256: "" } },
      { route: "release-artifact-delete", value: "release_1:artifact_1" },
      {
        route: "release-artifact-replace-upload",
        value: "release_1:artifact_1",
        body: {
          source: "uploaded",
          type: "zip",
          deliveryMode: "desktop_full_replace",
          fileName: "ChordV_1.1.7_x64-full.zip",
          isPrimary: "true"
        },
        file: {
          originalname: "ChordV_1.1.7_x64-full.zip",
          mimetype: "application/zip",
          size: 16
        }
      },
      { route: "release-download", value: "artifact_1" },
      { route: "image-bed-config-get", value: "config" },
      {
        route: "image-bed-config-update",
        value: "config",
        body: {
          baseUrl: "https://image.example.com",
          apiToken: "token",
          uploadFolder: "uat",
          uploadChannel: "telegram",
          channelName: "UAT"
        }
      },
      {
        route: "image-bed-files-list",
        value: "files",
        body: { start: "2", count: "5", search: "uat", dir: "tests", recursive: "true" }
      },
      {
        route: "image-bed-file-delete",
        value: "files",
        body: { path: "tests/uat.png", folder: "false" }
      },
      {
        route: "ticket-attachment",
        value: "ticket_1",
        body: { body: "带附件回复", adminId: "admin_1" },
        file: {
          originalname: "ticket-attachment.png",
          mimetype: "image/png",
          size: 3
        }
      },
      {
        route: "client-ticket-attachment",
        value: "ticket_1",
        body: { body: "client attachment reply", authorization: "Bearer user-test-token" },
        file: {
          originalname: "client-ticket.png",
          mimetype: "image/png",
          size: 3
        }
      },
      {
        route: "runtime-upload",
        value: "new",
        body: {
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          fileName: "xray.zip",
          enabled: "true"
        },
        file: {
          originalname: "xray.zip",
          mimetype: "application/zip",
          size: 7
        }
      },
      {
        route: "runtime-replace-upload",
        value: "component_1",
        body: {
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          fileName: "xray.zip",
          enabled: "true"
        },
        file: {
          originalname: "xray.zip",
          mimetype: "application/zip",
          size: 7
        }
      },
      { route: "runtime-failures", value: "10" },
      { route: "runtime-verify", value: "component_1" },
      { route: "runtime-delete", value: "component_1" }
    ]);
  } finally {
    expressApp.response.download = originalDownload;
    await app.close();
  }

  console.log("admin controller route regression checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
