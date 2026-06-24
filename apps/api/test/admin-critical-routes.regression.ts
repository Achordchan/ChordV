import "reflect-metadata";
import assert from "node:assert/strict";
import { Module, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AdminController } from "../src/modules/admin/admin.controller";
import { ClientController } from "../src/modules/client/client.controller";
import { DownloadsController } from "../src/modules/client/downloads.controller";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import { AdminRuntimeEventsService } from "../src/modules/common/admin-runtime-events.service";
import { AuthSessionService } from "../src/modules/common/auth-session.service";
import { ClientAuthGuard } from "../src/modules/common/client-auth.guard";
import { DevDataService } from "../src/modules/common/dev-data.service";
import { ImageBedService } from "../src/modules/common/image-bed.service";
import { RuntimeComponentsService } from "../src/modules/common/runtime-components.service";
import { ClientService } from "../src/modules/client/client.service";
import {
  ChangeSubscriptionPlanDto,
  CreateAnnouncementDto,
  CreatePlanDto,
  CreateReleaseArtifactDto,
  CreateReleaseDto,
  CreateRuntimeComponentDto,
  CreateSubscriptionDto,
  CreateTeamDto,
  CreateTeamSubscriptionDto,
  RenewSubscriptionDto,
  UpdateSubscriptionDto
} from "../src/modules/admin/admin.dto";

type RouteCall = {
  route: string;
  value: string;
  body?: unknown;
};

const calls: RouteCall[] = [];
const runtimeDownloadPath = "virtual-runtime.zip";

Reflect.defineMetadata(
  "design:paramtypes",
  [DevDataService, RuntimeComponentsService, ImageBedService, AdminRuntimeEventsService, AuthSessionService],
  AdminController
);
Reflect.defineMetadata("design:paramtypes", [CreatePlanDto], AdminController.prototype, "createPlan");
Reflect.defineMetadata("design:paramtypes", [CreateSubscriptionDto], AdminController.prototype, "createSubscription");
Reflect.defineMetadata("design:paramtypes", [String, RenewSubscriptionDto], AdminController.prototype, "renewSubscription");
Reflect.defineMetadata("design:paramtypes", [String, ChangeSubscriptionPlanDto], AdminController.prototype, "changeSubscriptionPlan");
Reflect.defineMetadata("design:paramtypes", [String, UpdateSubscriptionDto], AdminController.prototype, "updateSubscription");
Reflect.defineMetadata("design:paramtypes", [CreateTeamDto], AdminController.prototype, "createTeam");
Reflect.defineMetadata("design:paramtypes", [String, CreateTeamSubscriptionDto], AdminController.prototype, "createTeamSubscription");
Reflect.defineMetadata("design:paramtypes", [CreateAnnouncementDto], AdminController.prototype, "createAnnouncement");
Reflect.defineMetadata("design:paramtypes", [CreateRuntimeComponentDto], AdminController.prototype, "createRuntimeComponent");
Reflect.defineMetadata("design:paramtypes", [CreateReleaseDto], AdminController.prototype, "createRelease");
Reflect.defineMetadata("design:paramtypes", [String, CreateReleaseArtifactDto], AdminController.prototype, "createReleaseArtifact");
Reflect.defineMetadata("design:paramtypes", [DevDataService, RuntimeComponentsService], DownloadsController);
Reflect.defineMetadata("design:paramtypes", [ClientService, RuntimeComponentsService], ClientController);
Reflect.defineMetadata("design:paramtypes", [AuthSessionService], AdminAuthGuard);
Reflect.defineMetadata("design:paramtypes", [AuthSessionService], ClientAuthGuard);

function toPlainJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function record(route: string, value: string, body?: unknown) {
  const call: RouteCall = body === undefined ? { route, value } : { route, value, body: toPlainJson(body) };
  calls.push(call);
  return call;
}

const devDataServiceStub = {
  getAdminSnapshot: async () => record("snapshot-get", "snapshot"),
  getAdminDashboard: async () => record("dashboard-get", "dashboard"),
  updateCurrentAdminSecurity: async (authorization: string | undefined, body: unknown) =>
    record("admin-security", "me", { ...toPlainJson(body) as Record<string, unknown>, authorization }),
  listAdminUsers: async () => [record("users-list", "all")],
  createUser: async (body: unknown) => record("user-create", "new", body),
  updateUser: async (userId: string, body: unknown) => record("user-update", userId, body),
  updateUserSecurity: async (userId: string, body: unknown) => record("user-security", userId, body),
  listAdminPlans: async () => [record("plans-list", "all")],
  createPlan: async (body: unknown) => record("plan-create", "new", body),
  updatePlan: async (planId: string, body: unknown) => record("plan-update", planId, body),
  updatePlanSecurity: async (planId: string, body: unknown) => record("plan-security", planId, body),
  listAdminSubscriptions: async () => [record("subscriptions-list", "all")],
  createSubscription: async (body: unknown) => record("subscription-create", "new", body),
  renewSubscription: async (subscriptionId: string, body: unknown) => record("subscription-renew", subscriptionId, body),
  changeSubscriptionPlan: async (subscriptionId: string, body: unknown) => record("subscription-change-plan", subscriptionId, body),
  updateSubscription: async (subscriptionId: string, body: unknown) => record("subscription-update", subscriptionId, body),
  convertPersonalSubscriptionToTeam: async (subscriptionId: string, body: unknown) =>
    record("subscription-convert-team", subscriptionId, body),
  getSubscriptionNodeAccess: async (subscriptionId: string) => record("subscription-nodes-get", subscriptionId),
  listAdminTeams: async () => [record("teams-list", "all")],
  createTeam: async (body: unknown) => record("team-create", "new", body),
  updateTeam: async (teamId: string, body: unknown) => record("team-update", teamId, body),
  createTeamMember: async (teamId: string, body: unknown) => record("team-member-create", teamId, body),
  updateTeamMember: async (teamId: string, memberId: string, body: unknown) =>
    record("team-member-update", `${teamId}:${memberId}`, body),
  deleteTeamMember: async (teamId: string, memberId: string) => record("team-member-delete", `${teamId}:${memberId}`),
  kickTeamMember: async (teamId: string, memberId: string, body: unknown) => record("team-member-kick", `${teamId}:${memberId}`, body),
  createTeamSubscription: async (teamId: string, body: unknown) => record("team-subscription-create", teamId, body),
  getTeamUsage: async (teamId: string) => record("team-usage", teamId),
  listAdminNodes: async () => [record("nodes-list", "all")],
  listAdminPanelSyncJobs: async () => [record("panel-jobs-list", "all")],
  listAdminLeaseRevocationJobs: async () => [record("lease-jobs-list", "all")],
  importNodeFromSubscription: async (body: unknown) => record("node-import", "new", body),
  listNodePanelInbounds: async (body: unknown) => record("node-panel-inbounds", "panel", body),
  refreshNode: async (nodeId: string) => record("node-refresh", nodeId),
  probeNode: async (nodeId: string) => record("node-probe", nodeId),
  listAdminSupportTickets: async () => [record("tickets-list", "all")],
  getAdminSupportTicketDetail: async (ticketId: string) => record("ticket-detail", ticketId),
  replyAdminSupportTicket: async (ticketId: string, body: unknown, adminId?: string | null) =>
    record("ticket-reply", ticketId, { ...toPlainJson(body) as Record<string, unknown>, adminId }),
  closeAdminSupportTicket: async (ticketId: string) => record("ticket-close", ticketId),
  reopenAdminSupportTicket: async (ticketId: string) => record("ticket-reopen", ticketId),
  listAdminAnnouncements: async () => [record("announcements-list", "all")],
  getAdminPolicy: async () => record("policy-get", "policy"),
  updatePolicy: async (body: unknown) => record("policy-update", "policy", body),
  listAdminReleases: async (query: unknown) => [record("releases-list", "all", query)],
  deleteRelease: async (releaseId: string) => record("release-delete", releaseId)
};

const runtimeComponentsServiceStub = {
  listAdminRuntimeComponents: async () => [record("runtime-list", "all")],
  createAdminRuntimeComponent: async (body: unknown) => record("runtime-create", "new", body),
  updateAdminRuntimeComponent: async (componentId: string, body: unknown) => record("runtime-update", componentId, body),
  getRuntimeComponentDownloadDescriptor: async (componentId: string) => {
    record("runtime-download", componentId);
    return { absolutePath: runtimeDownloadPath, fileName: "xray.zip" };
  },
  getClientRuntimeComponentsPlan: async (body: unknown) => record("client-runtime-plan", "plan", body),
  reportRuntimeComponentFailure: async (body: unknown, authorization?: string) =>
    record("client-runtime-failure", "failure", { ...toPlainJson(body) as Record<string, unknown>, authorization })
};

const clientServiceStub = {
  getBootstrap: async (authorization?: string, platform?: string) => record("client-bootstrap", "bootstrap", { authorization, platform }),
  getSubscription: async (authorization?: string) => record("client-subscription", "subscription", { authorization }),
  getNodes: async (authorization?: string) => [record("client-nodes", "nodes", { authorization })],
  probeNodes: async (nodeIds: string[], authorization?: string) => record("client-nodes-probe", "nodes", { nodeIds, authorization }),
  getPolicies: async () => record("client-policies", "policies"),
  getAnnouncements: async (authorization?: string) => [record("client-announcements", "announcements", { authorization })],
  markAnnouncementsRead: async (body: unknown, authorization?: string) =>
    record("client-announcements-read", "announcements", { ...toPlainJson(body) as Record<string, unknown>, authorization }),
  getVersion: async (platform?: string) => record("client-version", "version", { platform }),
  ping: async (authorization?: string) => record("client-ping", "ping", { authorization }),
  checkUpdate: async (body: unknown) => record("client-update-check", "update", body),
  getRuntime: async (sessionId?: string, authorization?: string) => record("client-runtime", sessionId ?? "", { authorization }),
  listSupportTickets: async (authorization?: string) => record("client-tickets-list", "all", { authorization }),
  getSupportTicket: async (ticketId: string, authorization?: string) => record("client-ticket-detail", ticketId, { authorization }),
  markSupportTicketRead: async (ticketId: string, authorization?: string) => record("client-ticket-read", ticketId, { authorization }),
  createSupportTicket: async (body: unknown, authorization?: string) =>
    record("client-ticket-create", "new", { ...toPlainJson(body) as Record<string, unknown>, authorization }),
  replySupportTicket: async (ticketId: string, body: unknown, authorization?: string) =>
    record("client-ticket-reply", ticketId, { ...toPlainJson(body) as Record<string, unknown>, authorization }),
  connect: async (nodeId: string, mode: string, strategyGroupId?: string, authorization?: string) =>
    record("client-session-connect", "connect", { nodeId, mode, strategyGroupId, authorization }),
  heartbeat: async (sessionId: string, authorization?: string) => record("client-session-heartbeat", sessionId, { authorization }),
  disconnect: async (sessionId: string, authorization?: string) => record("client-session-disconnect", sessionId, { authorization })
};

@Module({
  controllers: [AdminController, ClientController, DownloadsController],
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
    { provide: ImageBedService, useValue: {} },
    { provide: AdminRuntimeEventsService, useValue: {} }
  ]
})
class TestCriticalRoutesModule {}

async function requestJson(
  baseUrl: string,
  path: string,
  init?: { method?: string; body?: unknown; authorization?: string }
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? "POST",
    headers: {
      authorization: init?.authorization ?? "Bearer admin-test-token",
      ...(init?.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function assertJsonBadRequest(baseUrl: string, path: string, body: unknown, method = "POST") {
  const callCountBefore = calls.length;
  const response = await requestJson(baseUrl, path, { method, body });
  assert.equal(response.status, 400, `${path} should reject null-only optional fields before service execution`);
  assert.equal(calls.length, callCountBefore, `${path} should not call service after DTO validation failure`);
}

async function requestDownload(baseUrl: string, routePath: string) {
  const response = await fetch(`${baseUrl}${routePath}`);
  return response.status;
}

async function main() {
  const app = await NestFactory.create(TestCriticalRoutesModule, { logger: false });
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
    const expireAt = "2030-01-01T00:00:00.000Z";

    await assertJsonBadRequest(baseUrl, "/api/admin/plans", {
      name: "Null Plan",
      scope: "personal",
      totalTrafficGb: 10,
      renewable: true,
      maxConcurrentSessions: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/plans", {
      name: "Null Plan",
      scope: "personal",
      totalTrafficGb: 10,
      renewable: true,
      isActive: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions", {
      userId: "user_1",
      planId: "plan_1",
      expireAt,
      totalTrafficGb: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions", {
      userId: "user_1",
      planId: "plan_1",
      expireAt,
      state: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions/subscription_1/renew", {
      expireAt: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions/subscription_1/renew", {
      resetTraffic: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions/subscription_1/renew", {
      totalTrafficGb: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions/subscription_1/change-plan", {
      planId: "plan_2",
      totalTrafficGb: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions/subscription_1/change-plan", {
      planId: "plan_2",
      expireAt: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions/subscription_1", {
      totalTrafficGb: null
    }, "PATCH");
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions/subscription_1", {
      usedTrafficGb: null
    }, "PATCH");
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions/subscription_1", {
      expireAt: null
    }, "PATCH");
    await assertJsonBadRequest(baseUrl, "/api/admin/subscriptions/subscription_1", {
      state: null
    }, "PATCH");
    await assertJsonBadRequest(baseUrl, "/api/admin/teams", {
      name: "Null Team",
      ownerUserId: "user_1",
      status: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/teams/team_1/subscriptions", {
      planId: "plan_1",
      expireAt,
      usedTrafficGb: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/announcements", {
      title: "Null announcement",
      body: "body",
      level: "info",
      displayMode: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/announcements", {
      title: "Null announcement",
      body: "body",
      level: "info",
      isActive: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/announcements", {
      title: "Null announcement",
      body: "body",
      level: "info",
      countdownSeconds: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/releases", {
      platform: "windows",
      channel: "stable",
      version: "1.1.7",
      displayTitle: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/runtime-components", {
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: null,
      originUrl: "https://cdn.example.com/xray.zip",
      fileName: "xray.zip"
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/runtime-components", {
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "custom_remote",
      originUrl: null,
      fileName: "xray.zip"
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/runtime-components", {
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "custom_remote",
      originUrl: "https://cdn.example.com/xray.zip",
      fileName: "xray.zip",
      allowClientMirror: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/runtime-components", {
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "custom_remote",
      originUrl: "https://cdn.example.com/xray.zip",
      fileName: "xray.zip",
      enabled: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/releases/release_1/artifacts", {
      source: "external",
      type: "external",
      deliveryMode: "external_download",
      downloadUrl: "https://cdn.example.com/chordv.exe",
      allowClientMirror: null
    });
    await assertJsonBadRequest(baseUrl, "/api/admin/releases/release_1/artifacts", {
      source: "external",
      type: "external",
      deliveryMode: "external_download",
      downloadUrl: "https://cdn.example.com/chordv.exe",
      isPrimary: null
    });

    assert.equal((await requestJson(baseUrl, "/api/admin/snapshot", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/dashboard", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/upload-limits", { method: "GET" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/me/security", {
        method: "PUT",
        body: { currentPassword: "password1", email: "admin@example.com", newPassword: "password2" }
      })).status,
      200
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/users", { method: "GET" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/users", {
        body: { email: "uat@example.com", password: "password1", displayName: "UAT User", role: "user" }
      })).status,
      201
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/users/user_1", { method: "PATCH", body: { status: "disabled" } })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/users/user_1/security", {
        method: "PUT",
        body: { maxConcurrentSessionsOverride: 2 }
      })).status,
      200
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/plans", { method: "GET" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/plans", {
        body: { name: "UAT Plan", scope: "personal", totalTrafficGb: 10, renewable: true, maxConcurrentSessions: 2 }
      })).status,
      201
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/plans/plan_1", { method: "PATCH", body: { isActive: false } })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/plans/plan_1/security", { method: "PUT", body: { maxConcurrentSessions: 3 } })).status,
      200
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/subscriptions", { method: "GET" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/subscriptions", {
        body: { userId: "user_1", planId: "plan_1", expireAt, totalTrafficGb: 10 }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/subscriptions/subscription_1/renew", {
        body: { expireAt, resetTraffic: true, totalTrafficGb: 20 }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/subscriptions/subscription_1/change-plan", {
        body: { planId: "plan_2", totalTrafficGb: 30, expireAt }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/subscriptions/subscription_1", { method: "PATCH", body: { state: "paused" } })).status,
      200
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/subscriptions/subscription_1/convert-to-team", { body: { targetTeamId: "team_1" } })).status,
      201
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/subscriptions/subscription_1/nodes", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/teams", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/teams", { body: { name: "UAT Team", ownerUserId: "user_1" } })).status, 201);
    assert.equal((await requestJson(baseUrl, "/api/admin/teams/team_1", { method: "PATCH", body: { status: "disabled" } })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/teams/team_1/members", { body: { userId: "user_2", role: "member" } })).status, 201);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/teams/team_1/members/member_1", { method: "PATCH", body: { role: "owner" } })).status,
      200
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/teams/team_1/members/member_1", { method: "DELETE" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/teams/team_1/members/member_1/kick", { body: { disableAccount: true } })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/teams/team_1/subscriptions", {
        body: { planId: "plan_1", expireAt, totalTrafficGb: 10 }
      })).status,
      201
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/teams/team_1/usage", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/nodes", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/nodes/panel-sync-jobs", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/nodes/lease-revocation-jobs", { method: "GET" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/nodes/import", {
        body: { subscriptionUrl: "https://node.example.com/sub", name: "UAT Node", countryCode: "US" }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/nodes/panel-inbounds", {
        body: { panelBaseUrl: "https://panel.example.com", panelUsername: "admin", panelPassword: "password" }
      })).status,
      201
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/nodes/node_1/refresh")).status, 201);
    assert.equal((await requestJson(baseUrl, "/api/admin/nodes/node_1/probe")).status, 201);
    assert.equal((await requestJson(baseUrl, "/api/admin/tickets", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/tickets/ticket_1", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/tickets/ticket_1/replies", { body: { body: "admin reply" } })).status, 201);
    assert.equal((await requestJson(baseUrl, "/api/admin/tickets/ticket_1/close")).status, 201);
    assert.equal((await requestJson(baseUrl, "/api/admin/tickets/ticket_1/reopen")).status, 201);
    assert.equal((await requestJson(baseUrl, "/api/admin/announcements", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/policies", { method: "GET" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/policies", {
        method: "PATCH",
        body: { modes: ["global", "rule"], defaultMode: "rule", blockAds: true }
      })).status,
      200
    );
    assert.equal((await requestJson(baseUrl, "/api/admin/releases?platform=windows&status=draft", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/releases/release_1", { method: "DELETE" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/admin/runtime-components", { method: "GET" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/runtime-components", {
        body: { platform: "windows", architecture: "x64", kind: "xray", source: "custom_remote", originUrl: "https://cdn.example.com/xray.zip", fileName: "xray.zip" }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/admin/runtime-components/component_1", {
        method: "PATCH",
        body: { source: "custom_remote", originUrl: "https://cdn.example.com/xray.zip", fileName: "xray.zip", enabled: true }
      })).status,
      200
    );
    assert.equal(await requestDownload(baseUrl, "/api/downloads/runtime-components/component_1"), 204);
    assert.deepEqual(downloadCalls, [{ absolutePath: runtimeDownloadPath, fileName: "xray.zip" }]);

    assert.equal(
      (await requestJson(baseUrl, "/api/client/bootstrap?platform=windows", {
        method: "GET",
        authorization: "Bearer user-test-token"
      })).status,
      200
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/client/subscription", { method: "GET", authorization: "Bearer user-test-token" })).status,
      200
    );
    assert.equal((await requestJson(baseUrl, "/api/client/nodes", { method: "GET", authorization: "Bearer user-test-token" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/client/nodes/probe", {
        authorization: "Bearer user-test-token",
        body: { nodeIds: ["node_1"] }
      })).status,
      201
    );
    assert.equal((await requestJson(baseUrl, "/api/client/policies", { method: "GET", authorization: "Bearer user-test-token" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/client/announcements", { method: "GET", authorization: "Bearer user-test-token" })).status,
      200
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/client/announcements/read", {
        authorization: "Bearer user-test-token",
        body: { announcementIds: ["announcement_1"], action: "seen" }
      })).status,
      201
    );
    assert.equal((await requestJson(baseUrl, "/api/client/version?platform=windows", { method: "GET" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/client/ping", { method: "GET", authorization: "Bearer user-test-token" })).status, 200);
    assert.equal(
      (await requestJson(baseUrl, "/api/client/update/check", {
        authorization: "Bearer user-test-token",
        body: { currentVersion: "1.1.6", platform: "windows", channel: "stable", artifactType: "zip" }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/client/runtime-components/plan?platform=windows&architecture=x64", {
        method: "GET",
        authorization: "Bearer user-test-token"
      })).status,
      200
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/client/runtime-components/report-failure", {
        authorization: "Bearer user-test-token",
        body: { componentId: "component_1", platform: "windows", architecture: "x64", kind: "xray", reason: "download_failed" }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/client/runtime?sessionId=session_1", {
        method: "GET",
        authorization: "Bearer user-test-token"
      })).status,
      200
    );
    assert.equal((await requestJson(baseUrl, "/api/client/tickets", { method: "GET", authorization: "Bearer user-test-token" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/client/tickets/ticket_1", { method: "GET", authorization: "Bearer user-test-token" })).status, 200);
    assert.equal((await requestJson(baseUrl, "/api/client/tickets/ticket_1/read", { authorization: "Bearer user-test-token" })).status, 201);
    assert.equal(
      (await requestJson(baseUrl, "/api/client/tickets", {
        authorization: "Bearer user-test-token",
        body: { title: "UAT ticket", body: "client body" }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/client/tickets/ticket_1/replies", {
        authorization: "Bearer user-test-token",
        body: { body: "client reply" }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/client/session/connect", {
        authorization: "Bearer user-test-token",
        body: { nodeId: "node_1", mode: "rule" }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/client/session/heartbeat", {
        authorization: "Bearer user-test-token",
        body: { sessionId: "session_1" }
      })).status,
      201
    );
    assert.equal(
      (await requestJson(baseUrl, "/api/client/session/disconnect", {
        authorization: "Bearer user-test-token",
        body: { sessionId: "session_1" }
      })).status,
      201
    );

    const adminCalls = calls.slice(0, 48);
    const clientCalls = calls.slice(48);

    assert.deepEqual(
      adminCalls,
      [
        { route: "snapshot-get", value: "snapshot" },
        { route: "dashboard-get", value: "dashboard" },
        {
          route: "admin-security",
          value: "me",
          body: {
            currentPassword: "password1",
            email: "admin@example.com",
            newPassword: "password2",
            authorization: "Bearer admin-test-token"
          }
        },
        { route: "users-list", value: "all" },
        {
          route: "user-create",
          value: "new",
          body: { email: "uat@example.com", password: "password1", displayName: "UAT User", role: "user" }
        },
        { route: "user-update", value: "user_1", body: { status: "disabled" } },
        { route: "user-security", value: "user_1", body: { maxConcurrentSessionsOverride: 2 } },
        { route: "plans-list", value: "all" },
        {
          route: "plan-create",
          value: "new",
          body: { name: "UAT Plan", scope: "personal", totalTrafficGb: 10, renewable: true, maxConcurrentSessions: 2 }
        },
        { route: "plan-update", value: "plan_1", body: { isActive: false } },
        { route: "plan-security", value: "plan_1", body: { maxConcurrentSessions: 3 } },
        { route: "subscriptions-list", value: "all" },
        { route: "subscription-create", value: "new", body: { userId: "user_1", planId: "plan_1", expireAt, totalTrafficGb: 10 } },
        { route: "subscription-renew", value: "subscription_1", body: { expireAt, resetTraffic: true, totalTrafficGb: 20 } },
        { route: "subscription-change-plan", value: "subscription_1", body: { planId: "plan_2", totalTrafficGb: 30, expireAt } },
        { route: "subscription-update", value: "subscription_1", body: { state: "paused" } },
        { route: "subscription-convert-team", value: "subscription_1", body: { targetTeamId: "team_1" } },
        { route: "subscription-nodes-get", value: "subscription_1" },
        { route: "teams-list", value: "all" },
        { route: "team-create", value: "new", body: { name: "UAT Team", ownerUserId: "user_1" } },
        { route: "team-update", value: "team_1", body: { status: "disabled" } },
        { route: "team-member-create", value: "team_1", body: { userId: "user_2", role: "member" } },
        { route: "team-member-update", value: "team_1:member_1", body: { role: "owner" } },
        { route: "team-member-delete", value: "team_1:member_1" },
        { route: "team-member-kick", value: "team_1:member_1", body: { disableAccount: true } },
        { route: "team-subscription-create", value: "team_1", body: { planId: "plan_1", expireAt, totalTrafficGb: 10 } },
        { route: "team-usage", value: "team_1" },
        { route: "nodes-list", value: "all" },
        { route: "panel-jobs-list", value: "all" },
        { route: "lease-jobs-list", value: "all" },
        {
          route: "node-import",
          value: "new",
          body: { subscriptionUrl: "https://node.example.com/sub", name: "UAT Node", countryCode: "US" }
        },
        {
          route: "node-panel-inbounds",
          value: "panel",
          body: { panelBaseUrl: "https://panel.example.com", panelUsername: "admin", panelPassword: "password" }
        },
        { route: "node-refresh", value: "node_1" },
        { route: "node-probe", value: "node_1" },
        { route: "tickets-list", value: "all" },
        { route: "ticket-detail", value: "ticket_1" },
        { route: "ticket-reply", value: "ticket_1", body: { body: "admin reply", adminId: "admin_1" } },
        { route: "ticket-close", value: "ticket_1" },
        { route: "ticket-reopen", value: "ticket_1" },
        { route: "announcements-list", value: "all" },
        { route: "policy-get", value: "policy" },
        { route: "policy-update", value: "policy", body: { modes: ["global", "rule"], defaultMode: "rule", blockAds: true } },
        { route: "releases-list", value: "all", body: { platform: "windows", status: "draft" } },
        { route: "release-delete", value: "release_1" },
        { route: "runtime-list", value: "all" },
        {
          route: "runtime-create",
          value: "new",
          body: {
            platform: "windows",
            architecture: "x64",
            kind: "xray",
            source: "custom_remote",
            originUrl: "https://cdn.example.com/xray.zip",
            fileName: "xray.zip"
          }
        },
        {
          route: "runtime-update",
          value: "component_1",
          body: {
            source: "custom_remote",
            originUrl: "https://cdn.example.com/xray.zip",
            fileName: "xray.zip",
            enabled: true
          }
        },
        { route: "runtime-download", value: "component_1" }
      ]
    );

    assert.deepEqual(
      clientCalls.map((call) => call.route),
      [
        "client-bootstrap",
        "client-subscription",
        "client-nodes",
        "client-nodes-probe",
        "client-policies",
        "client-announcements",
        "client-announcements-read",
        "client-version",
        "client-ping",
        "client-update-check",
        "client-runtime-plan",
        "client-runtime-failure",
        "client-runtime",
        "client-tickets-list",
        "client-ticket-detail",
        "client-ticket-read",
        "client-ticket-create",
        "client-ticket-reply",
        "client-session-connect",
        "client-session-heartbeat",
        "client-session-disconnect"
      ]
    );
  } finally {
    expressApp.response.download = originalDownload;
    await app.close();
  }

  console.log("critical admin and client route regression checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
