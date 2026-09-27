import "reflect-metadata";
import assert from "node:assert/strict";
import { ReleaseCenterService } from "../src/modules/common/release-center.service";
import { normalizeReleaseChannel, parseArtifactBuildNumber, releaseChannelsVisibleTo } from "../src/modules/common/release-center.utils";

type Row = {
  id: string;
  platform: string;
  channel: string;
  version: string;
  displayTitle: string;
  changelog: string[];
  minimumVersion: string;
  forceUpgrade: boolean;
  status: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  artifacts: any[];
};

function release(id: string, channel: string, version: string, status = "published"): Row {
  const now = new Date("2026-09-01T00:00:00Z");
  return {
    id, platform: "macos", channel, version, displayTitle: version, changelog: [], minimumVersion: "0.0.0",
    forceUpgrade: false, status, publishedAt: status === "published" ? now : null, createdAt: now, updatedAt: now, artifacts: []
  };
}

function matches(row: Row, where: Record<string, any>) {
  return Object.entries(where).every(([key, expected]) =>
    expected && typeof expected === "object" && "in" in expected
      ? expected.in.includes((row as any)[key])
      : (row as any)[key] === expected
  );
}

function createService(rows: Row[]) {
  const events: Array<{ platform: string; channel: string }> = [];
  const lockKeys: string[] = [];
  let lockChain: Promise<unknown> = Promise.resolve();
  const hooks: { beforeTransaction?: () => void } = {};
  const service: any = Object.create(ReleaseCenterService.prototype);
  service.logger = { warn() {} };
  const prisma: any = {
    // Transactions run one at a time, like holders of the same advisory lock.
    $transaction: (task: (tx: any) => Promise<unknown>) => {
      const run = lockChain.then(() => { hooks.beforeTransaction?.(); hooks.beforeTransaction = undefined; return task(prisma); });
      lockChain = run.catch(() => undefined);
      return run;
    },
    $executeRaw: async (_strings: TemplateStringsArray, key: string) => { lockKeys.push(key); return 1; },
    release: {
      findMany: async ({ where }: any) => rows.filter(row => matches(row, where)).map(row => ({ ...row })),
      findUnique: async ({ where }: any) => {
        const row = rows.find(item => item.id === where.id);
        return row ? { ...row } : null;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find(item => item.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        const targets = rows.filter(row => matches(row, where));
        for (const row of targets) Object.assign(row, data);
        return { count: targets.length };
      }
    }
  };
  service.prisma = prisma;
  service.pickClientUsableArtifact = async () => ({
    id: "artifact", type: "dmg", source: "uploaded", deliveryMode: "desktop_installer_download",
    downloadUrl: "https://updates.example/ChordV.dmg", fileName: "ChordV.dmg", fileHash: null, fileSizeBytes: 1n,
    isPrimary: true, isFullPackage: true, createdAt: new Date(), updatedAt: new Date()
  });
  service.clientEventsPublisher = {
    publishVersionUpdated: async (platform: string, channel: string) => { events.push({ platform, channel }); }
  };
  service.adminRuntimeEventsService = { publishVersionUpdated() {}, publishReleaseCenterUpdated() {} };
  return { service, events, lockKeys, hooks };
}

async function check(service: any, currentVersion: string, channel: "stable" | "beta") {
  return service.checkClientUpdate({ currentVersion, platform: "macos", channel, artifactType: "dmg" });
}

async function main() {
  assert.equal(normalizeReleaseChannel("beta"), "beta");
  assert.equal(normalizeReleaseChannel("stable"), "stable");
  assert.equal(normalizeReleaseChannel(undefined), "stable");
  assert.equal(normalizeReleaseChannel("nightly"), "stable", "unknown channels must fall back to stable");
  assert.deepEqual(releaseChannelsVisibleTo("stable"), ["stable"]);
  assert.deepEqual(releaseChannelsVisibleTo("beta"), ["stable", "beta"]);

  const rows = [
    release("stable-11", "stable", "1.1.11"),
    release("beta-12", "beta", "1.1.12"),
    release("beta-13", "beta", "1.1.13"),
    release("beta-14-draft", "beta", "1.1.14", "draft")
  ];
  const { service, events } = createService(rows);

  // Beta A (1.1.12) had a bug, beta B (1.1.13) replaced it. Stable users never see either.
  const stableUser = await check(service, "1.1.11", "stable");
  assert.equal(stableUser.hasUpdate, false);
  assert.equal(stableUser.channel, "stable");

  const tester = await check(service, "1.1.11", "beta");
  assert.equal(tester.hasUpdate, true);
  assert.equal(tester.latestVersion, "1.1.13", "testers take the highest published build across both channels");

  const testerOnBetaA = await check(service, "1.1.12", "beta");
  assert.equal(testerOnBetaA.latestVersion, "1.1.13", "testers still on beta A are moved to beta B");

  // Turning the switch off never downgrades a tester to the older stable build.
  const leftBeta = await check(service, "1.1.13", "stable");
  assert.equal(leftBeta.hasUpdate, false);
  assert.equal(leftBeta.latestVersion, "1.1.13");

  // Beta builds are never required: neither their own force flag nor their
  // minimum version blocks a tester. Only the stable line can force an update.
  const forced = createService([
    { ...release("stable-11", "stable", "1.1.11"), forceUpgrade: false },
    { ...release("beta-12", "beta", "1.1.12"), forceUpgrade: true, minimumVersion: "1.1.12" }
  ]);
  const optionalBeta = await check(forced.service, "1.1.11", "beta");
  assert.equal(optionalBeta.latestVersion, "1.1.12");
  assert.equal(optionalBeta.releaseChannel, "beta");
  assert.equal(optionalBeta.forceUpgrade, false, "a forced beta must stay optional for testers");
  assert.equal(optionalBeta.minimumVersion, "0.0.0", "a beta minimum version must not reach the client");
  assert.equal(optionalBeta.updateRequirement, "optional");
  assert.equal((await check(forced.service, "1.1.11", "stable")).hasUpdate, false);

  const stableForced = createService([
    { ...release("stable-11", "stable", "1.1.11"), forceUpgrade: true },
    release("beta-12", "beta", "1.1.12")
  ]);
  const behindStable = await check(stableForced.service, "1.1.10", "beta");
  assert.equal(behindStable.latestVersion, "1.1.12");
  assert.equal(behindStable.forceUpgrade, true, "a tester behind a forced stable release must still update");
  assert.equal(behindStable.updateRequirement, "required_release");
  const stableRequired = await check(stableForced.service, "1.1.10", "stable");
  assert.equal(stableRequired.releaseChannel, "stable");
  assert.equal(stableRequired.forceUpgrade, true);
  const aheadOfStable = await check(stableForced.service, "1.1.11", "beta");
  assert.equal(aheadOfStable.forceUpgrade, false, "testers already on the forced stable build are not forced onto beta");

  const stableMinimum = createService([
    { ...release("stable-11", "stable", "1.1.11"), minimumVersion: "1.1.11" },
    release("beta-12", "beta", "1.1.12")
  ]);
  const belowMinimum = await check(stableMinimum.service, "1.1.10", "beta");
  assert.equal(belowMinimum.forceUpgrade, true);
  assert.equal(belowMinimum.minimumVersion, "1.1.11", "testers inherit the stable minimum version");
  assert.equal(belowMinimum.updateRequirement, "required_minimum");

  // The newest stable has no artifact for this client: a lower beta cannot meet
  // the stable requirement, so it must not be handed out as a mandatory update.
  const unreachable = createService([
    { ...release("stable-20", "stable", "1.2.0"), minimumVersion: "1.2.0", forceUpgrade: true, artifacts: ["unusable"] },
    release("beta-112", "beta", "1.1.12"),
    release("stable-111", "stable", "1.1.11")
  ]);
  const usableArtifact = unreachable.service.pickClientUsableArtifact;
  unreachable.service.pickClientUsableArtifact = async (artifacts: any[], ...rest: any[]) =>
    artifacts[0] === "unusable" ? null : usableArtifact(artifacts, ...rest);
  const noLoop = await check(unreachable.service, "1.1.10", "beta");
  assert.notEqual(noLoop.latestVersion, "1.1.12", "a beta below the inherited requirement must be skipped");
  assert.equal(noLoop.latestVersion, "1.1.11", "fall back like stable users do when the newest stable is unavailable");
  assert.equal(noLoop.releaseChannel, "stable");

  // Release history follows update-check visibility, newest first, published only.
  const history = createService([
    { ...release("stable-8", "stable", "1.1.8"), changelog: ["旧版本"] },
    { ...release("stable-9", "stable", "1.1.9"), displayTitle: "", changelog: ["修复下载状态条"], artifacts: [{ id: "a9", isPrimary: true, type: "dmg", fileName: "ChordV_1.1.9_build7.dmg" }] },
    release("beta-10", "beta", "1.1.10"),
    release("stable-11-draft", "stable", "1.1.11", "draft")
  ]);
  const stableHistory = await history.service.listClientReleaseHistory({ platform: "macos", channel: "stable" });
  assert.deepEqual(stableHistory.map((item: any) => item.version), ["1.1.9", "1.1.8"], "stable history hides betas and drafts");
  assert.equal(stableHistory[0].title, "1.1.9", "an empty title falls back to the version");
  assert.deepEqual(stableHistory[0].changelog, ["修复下载状态条"]);
  assert.equal(stableHistory[0].build, 7, "history shows the primary installer's build");
  assert.equal(stableHistory[1].build, null);
  const testerHistory = await history.service.listClientReleaseHistory({ platform: "macos", channel: "beta", limit: 2 });
  assert.deepEqual(testerHistory.map((item: any) => [item.version, item.releaseChannel]), [["1.1.10", "beta"], ["1.1.9", "stable"]]);

  // Build numbers: a newer installer of the same version reaches clients that report
  // their build; older clients and 1.1.9 users keep the plain version comparison.
  assert.equal(parseArtifactBuildNumber({ fileName: "ChordV_1.1.10_build42.dmg" }), 42);
  assert.equal(parseArtifactBuildNumber({ fileName: "ChordV_1.1.10_build43_x64-setup.exe" }), 43);
  assert.equal(parseArtifactBuildNumber({ fileName: null, sourceUrl: "https://github.com/a/b/releases/download/v1.1.10/ChordV_1.1.10_build44.dmg?x=1" }), 44);
  assert.equal(parseArtifactBuildNumber({ fileName: "ChordV_1.1.10.dmg" }), null, "installers without a build keep working");
  assert.equal(parseArtifactBuildNumber({ fileName: "ChordV_1.1.10_build0.dmg" }), null);

  const builds = createService([release("stable-9", "stable", "1.1.9"), release("beta-10", "beta", "1.1.10")]);
  const usable = builds.service.pickClientUsableArtifact;
  let offeredName = "ChordV_1.1.10_build42.dmg";
  builds.service.pickClientUsableArtifact = async (...args: any[]) => ({ ...(await usable(...args)), fileName: offeredName });
  const withBuild = (currentVersion: string, currentBuild: number | undefined, channel: "stable" | "beta") =>
    builds.service.checkClientUpdate({ currentVersion, currentBuild, platform: "macos", channel, artifactType: "dmg" });

  const tester41 = await withBuild("1.1.10", 41, "beta");
  assert.equal(tester41.hasUpdate, true, "a tester on build 41 receives build 42 of the same version");
  assert.equal(tester41.latestVersion, "1.1.10");
  assert.equal(tester41.latestBuild, 42);
  assert.equal(tester41.forceUpgrade, false, "a newer build alone never forces");
  assert.equal((await withBuild("1.1.10", 42, "beta")).hasUpdate, false, "the same build is not offered again");
  assert.equal((await withBuild("1.1.10", 50, "beta")).hasUpdate, false, "an older build is never offered");
  assert.equal((await withBuild("1.1.10", undefined, "beta")).hasUpdate, false, "clients that do not report a build keep today's behaviour");
  const fromOld = await withBuild("1.1.9", undefined, "beta");
  assert.equal(fromOld.hasUpdate, true);
  assert.equal(fromOld.latestVersion, "1.1.10", "1.1.9 moves straight to 1.1.10");
  offeredName = "ChordV_1.1.10.dmg";
  assert.equal((await withBuild("1.1.10", 41, "beta")).hasUpdate, false, "an installer without a build is not treated as newer");
  assert.equal((await withBuild("1.1.10", 41, "beta")).latestBuild, null);

  // Guard rails around promotion.
  await assert.rejects(service.promoteRelease("stable-11"), /只有测试版/);
  await assert.rejects(service.promoteRelease("beta-14-draft"), /请先发布测试版/);
  await assert.rejects(service.updateRelease("beta-13", { channel: "stable" }), /转为正式版/);

  const promoted = await service.promoteRelease("beta-13");
  assert.equal(promoted.channel, "stable");
  assert.equal(promoted.version, "1.1.13");
  assert.deepEqual(events.at(-1), { platform: "macos", channel: "stable" }, "promotion must notify stable clients");

  const stableAfterPromotion = await check(service, "1.1.11", "stable");
  assert.equal(stableAfterPromotion.hasUpdate, true);
  assert.equal(stableAfterPromotion.latestVersion, "1.1.13", "stable users jump straight to the promoted build");

  const testerAfterPromotion = await check(service, "1.1.13", "beta");
  assert.equal(testerAfterPromotion.hasUpdate, false, "testers already on the promoted build are not prompted again");

  // Beta A is now older than stable, so promoting it would be a downgrade.
  await assert.rejects(service.promoteRelease("beta-12"), /正式版已是 1\.1\.13/);

  // An admin edits a draft beta's channel while another publishes it: the
  // channel check must use the persisted status read under the lock.
  const editRace = createService([release("stable-11", "stable", "1.1.11"), release("beta-15", "beta", "1.1.15", "draft")]);
  editRace.hooks.beforeTransaction = () => { editRace.service.prisma.release.update({ where: { id: "beta-15" }, data: { status: "published" } }); };
  await assert.rejects(editRace.service.updateRelease("beta-15", { channel: "stable" }), /转为正式版/);
  const draftEdit = createService([release("beta-16", "beta", "1.1.16", "draft")]);
  const switched = await draftEdit.service.updateRelease("beta-16", { channel: "stable" });
  assert.equal(switched.channel, "stable", "drafts can still switch channel");

  // Two admins promote different betas at once: the lower one must not land after the higher one.
  const race = createService([
    release("stable-11", "stable", "1.1.11"),
    release("beta-12", "beta", "1.1.12"),
    release("beta-13", "beta", "1.1.13")
  ]);
  const [higher, lower] = await Promise.allSettled([race.service.promoteRelease("beta-13"), race.service.promoteRelease("beta-12")]);
  assert.equal(higher.status, "fulfilled");
  assert.equal(lower.status, "rejected");
  assert.match(String((lower as PromiseRejectedResult).reason?.message), /正式版已是 1\.1\.13/);
  assert.ok(race.lockKeys.every(key => key === "chordv:release-line:macos"), "promotion locks the platform release line");

  console.log("Release beta channel: build numbers, release history, tester visibility, beta never forced, no-downgrade opt-out, promotion guard rails and stable rollout passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
