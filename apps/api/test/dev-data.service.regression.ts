import assert from "node:assert/strict";
import { DevDataService } from "../src/modules/common/dev-data.service";

function createService(overrides: Record<string, unknown> = {}) {
  return Object.assign(Object.create(DevDataService.prototype), overrides) as DevDataService & Record<string, unknown>;
}

async function testPublishFailureDoesNotPartiallyPersist() {
  let updateCalled = false;
  const service = createService({
    ensureReleaseExists: async () => ({ id: "release_1", platform: "windows", status: "draft" }),
    assertReleasePublishable: async () => {
      throw new Error("blocked");
    },
    prisma: {
      release: {
        update: async () => {
          updateCalled = true;
          throw new Error("should_not_run");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.updateRelease("release_1", {
        status: "published",
        displayTitle: "版本一"
      }),
    /blocked/
  );
  assert.equal(updateCalled, false, "发布校验失败时不应该先写入基础字段");
}

async function testPublishedReleaseBlocksArtifactMutation() {
  const service = createService({
    ensureReleaseExists: async () => ({ id: "release_1", platform: "windows", status: "published" })
  });

  await assert.rejects(
    () =>
      service.createReleaseArtifact("release_1", {
        source: "external",
        type: "setup.exe",
        downloadUrl: "https://example.com/ChordV_1.0.6_x64-setup.exe"
      }),
    /请先撤回发布，再调整安装产物/
  );
}

async function testConvertToTeamRollbackRestoresPersonalSync() {
  const syncCalls: string[] = [];
  let deletedMembership = false;
  const service = createService({
    requireSubscription: async () => ({ id: "sub_personal", userId: "user_1", teamId: null }),
    ensureUserExists: async () => ({ id: "user_1", status: "active" }),
    requireTeam: async () => ({ id: "team_1", status: "active" }),
    getUserMembership: async () => null,
    findCurrentTeamSubscription: async () => ({
      id: "sub_team",
      state: "active",
      expireAt: new Date(Date.now() + 60_000),
      remainingTrafficGb: 50
    }),
    syncSubscriptionPanelAccess: async (subscriptionId: string) => {
      syncCalls.push(subscriptionId);
    },
    revokeSubscriptionLeases: async () => 0,
    removePanelBindingsForSubscription: async () => ({ requested: 0, updated: 0, failed: [] }),
    assertPanelBindingMutation: () => undefined,
    prisma: {
      teamMember: {
        create: async () => undefined,
        deleteMany: async () => {
          deletedMembership = true;
          return { count: 1 };
        }
      },
      subscription: {
        delete: async () => {
          throw new Error("delete_failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.convertPersonalSubscriptionToTeam("sub_personal", { targetTeamId: "team_1" }),
    /delete_failed/
  );

  assert.equal(deletedMembership, true, "失败后应该回滚刚创建的团队成员关系");
  assert.deepEqual(syncCalls, ["sub_team", "sub_team", "sub_personal"], "失败后应先清理团队授权，再恢复个人订阅授权");
}

async function testExternalArtifactValidationWritesBackMetadata() {
  const updates: Array<Record<string, unknown>> = [];
  const service = createService({
    resolveExternalReleaseArtifactMetadata: async () => ({
      fileName: "ChordV_1.0.6_x64-setup.exe",
      fileSizeBytes: BigInt(1024),
      fileHash: "abc123"
    }),
    prisma: {
      releaseArtifact: {
        findFirst: async () => ({
          id: "artifact_1",
          releaseId: "release_1",
          source: "external",
          type: "setup.exe",
          downloadUrl: "https://example.com/ChordV_1.0.6_x64-setup.exe",
          fileName: null,
          fileSizeBytes: null,
          fileHash: null
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return undefined;
        }
      }
    }
  });

  const result = await service.validateReleaseArtifact("release_1", "artifact_1");
  assert.equal(result.status, "ready");
  assert.equal(updates.length, 1, "校验成功后应回填可识别的元信息");
  assert.equal(updates[0]?.fileName, "ChordV_1.0.6_x64-setup.exe");
}

async function main() {
  await testPublishFailureDoesNotPartiallyPersist();
  await testPublishedReleaseBlocksArtifactMutation();
  await testConvertToTeamRollbackRestoresPersonalSync();
  await testExternalArtifactValidationWritesBackMetadata();
  console.log("dev-data.service regression checks passed");
}

void main();
