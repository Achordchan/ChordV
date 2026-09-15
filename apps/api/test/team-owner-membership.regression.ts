import "reflect-metadata";
import assert from "node:assert/strict";
import { AdminSubscriptionService } from "../src/modules/common/admin-subscription.service";

async function main() {
  let membership: { id: string; teamId: string } | null = null;
  let transactionMembership: typeof membership;
  const mutations: string[] = [];
  const service = Object.assign(Object.create(AdminSubscriptionService.prototype), {
    requireTeam: async () => ({ id: "team", ownerUserId: "old-owner", status: "active" }),
    ensureUserExists: async () => ({ id: "new-owner", status: "active" }),
    getUserMembership: async () => membership,
    findCurrentPersonalSubscription: async () => null,
    findTeamSubscriptionAfterLocalSaveBestEffort: async () => ({ subscription: null, panelSync: { ok: true } }),
    withTeamRecordRefreshBestEffort: async () => ({ id: "team" }),
    prisma: { $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
      teamMember: {
        findUnique: async () => transactionMembership,
        updateMany: async () => { mutations.push("demote-old"); },
        update: async () => { mutations.push("promote-member"); },
        create: async () => { throw new Error("owner transfer must never create an outside member"); }
      }, team: { update: async () => { mutations.push("save-team"); } }
    }) }
  });
  // The existing public method's team and account locks are covered in dev-data.service.regression.ts.
  const transfer = () => service.updateTeamLocked("team", { ownerUserId: "new-owner" });
  await assert.rejects(transfer, /本团队成员/);
  membership = { id: "member", teamId: "other" };
  await assert.rejects(transfer, /本团队成员/);
  membership = { id: "member", teamId: "team" };
  transactionMembership = null;
  await assert.rejects(transfer, /不属于本团队/);
  assert.equal(mutations.length, 0);
  transactionMembership = membership;
  await transfer();
  assert.deepEqual(mutations, ["demote-old", "promote-member", "save-team"]);
  console.log("team owner membership, concurrent removal and successful transfer checks passed");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
