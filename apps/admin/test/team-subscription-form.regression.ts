import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyPlanToTeamSubscriptionForm,
  buildCreateTeamSubscriptionPayload,
  emptyTeamSubscriptionForm,
  type TeamSubscriptionFormState
} from "../src/utils/admin-forms";

const teamPlan = {
  id: "plan_team_pro",
  name: "Team Pro",
  scope: "team",
  totalTrafficGb: 2048,
  isActive: true
};

function testEmptyTeamSubscriptionFormDefaultsUsedTrafficToZero() {
  const form = emptyTeamSubscriptionForm();

  assert.equal(form.usedTrafficGb, 0);
}

function testApplyTeamPlanKeepsUsedTraffic() {
  const form: TeamSubscriptionFormState = {
    planId: "",
    totalTrafficGb: 100,
    usedTrafficGb: 12.5,
    expireAt: "2026-07-18T10:30"
  };

  const next = applyPlanToTeamSubscriptionForm({ plans: [teamPlan] } as any, form, teamPlan.id);

  assert.equal(next.planId, teamPlan.id);
  assert.equal(next.totalTrafficGb, teamPlan.totalTrafficGb);
  assert.equal(next.usedTrafficGb, 12.5);
}

function testApplyMissingTeamPlanKeepsUsedTraffic() {
  const form: TeamSubscriptionFormState = {
    planId: "old_plan",
    totalTrafficGb: 300,
    usedTrafficGb: 7.75,
    expireAt: "2026-07-18T10:30"
  };

  const next = applyPlanToTeamSubscriptionForm({ plans: [teamPlan] } as any, form, "missing_plan");

  assert.equal(next.planId, "missing_plan");
  assert.equal(next.totalTrafficGb, 300);
  assert.equal(next.usedTrafficGb, 7.75);
}

function testCreateTeamSubscriptionPayloadIncludesUsedTraffic() {
  const form: TeamSubscriptionFormState = {
    planId: teamPlan.id,
    totalTrafficGb: 2048,
    usedTrafficGb: 88.25,
    expireAt: "2026-07-18T10:30"
  };

  const expireAt = new Date(form.expireAt).toISOString();
  const payload = buildCreateTeamSubscriptionPayload(form, expireAt);

  assert.deepEqual(payload, {
    planId: teamPlan.id,
    totalTrafficGb: 2048,
    usedTrafficGb: 88.25,
    expireAt
  });
}

function testCreateTeamSubscriptionPayloadRequiresValidatedExpireAt() {
  const form = {
    ...emptyTeamSubscriptionForm(),
    planId: teamPlan.id,
    expireAt: ""
  };

  const payload = buildCreateTeamSubscriptionPayload(form, "2026-07-01T00:00:00.000Z");

  assert.equal(payload.usedTrafficGb, 0);
  assert.equal(payload.expireAt, "2026-07-01T00:00:00.000Z");
}

function testInlineTeamSubscriptionEditorExposesUsedTrafficInput() {
  const source = readFileSync(resolve(import.meta.dirname, "../src/pages/SubscriptionsPage.tsx"), "utf8");

  assert.match(source, /label="已用流量 \(GB\)"/);
  assert.match(source, /value=\{props\.teamSubscriptionForm\.usedTrafficGb\}/);
  assert.match(source, /usedTrafficGb: Number\(value\) \|\| 0/);
}

function testTeamMemberDisconnectCopyIsTeamScoped() {
  const subscriptionsSource = readFileSync(resolve(import.meta.dirname, "../src/pages/SubscriptionsPage.tsx"), "utf8");
  const modalSource = readFileSync(resolve(import.meta.dirname, "../src/features/modals/AdminModals.tsx"), "utf8");

  assert.match(subscriptionsSource, /断开本 Team 连接/);
  assert.match(modalSource, /只断开该成员在当前 Team 订阅下的连接/);
}

function testUserDisconnectActionsUseDisconnectIcon() {
  const usersSource = readFileSync(resolve(import.meta.dirname, "../src/pages/UsersPage.tsx"), "utf8");

  assert.match(usersSource, /IconPlugConnectedX/);
  assert.match(usersSource, /title="账号级：断开当前连接"[\s\S]{0,500}<IconPlugConnectedX size=\{16\} \/>/);
  assert.match(usersSource, /title="账号级：断开当前连接，不移出团队"[\s\S]{0,500}<IconPlugConnectedX size=\{16\} \/>/);
  assert.doesNotMatch(usersSource, /title="账号级：断开当前连接"[\s\S]{0,500}<IconRefresh size=\{16\} \/>/);
  assert.doesNotMatch(usersSource, /title="账号级：断开当前连接，不移出团队"[\s\S]{0,500}<IconRefresh size=\{16\} \/>/);
}

function testSubscriptionTrafficAndTeamDisconnectActionsUseDifferentIcons() {
  const subscriptionsSource = readFileSync(resolve(import.meta.dirname, "../src/pages/SubscriptionsPage.tsx"), "utf8");

  assert.match(subscriptionsSource, /IconGaugeOff/);
  assert.match(subscriptionsSource, /IconPlugConnectedX/);
  assert.match(subscriptionsSource, /title="重置流量"[\s\S]{0,500}<IconGaugeOff size=\{16\} \/>/);
  assert.match(subscriptionsSource, />\s*重置流量\s*<\/Button>[\s\S]{0,800}title="Team 范围：断开该成员在当前 Team 订阅下的连接"/);
  assert.match(subscriptionsSource, /leftSection=\{<IconGaugeOff size=\{14\} \/>\}[\s\S]{0,600}>\s*重置流量\s*<\/Button>/);
  assert.match(subscriptionsSource, /leftSection=\{<IconPlugConnectedX size=\{14\} \/>\}[\s\S]{0,600}>\s*断开本 Team 连接\s*<\/Button>/);
  assert.doesNotMatch(subscriptionsSource, /IconBolt/);
}

testEmptyTeamSubscriptionFormDefaultsUsedTrafficToZero();
testApplyTeamPlanKeepsUsedTraffic();
testApplyMissingTeamPlanKeepsUsedTraffic();
testCreateTeamSubscriptionPayloadIncludesUsedTraffic();
testCreateTeamSubscriptionPayloadRequiresValidatedExpireAt();
testInlineTeamSubscriptionEditorExposesUsedTrafficInput();
testTeamMemberDisconnectCopyIsTeamScoped();
testUserDisconnectActionsUseDisconnectIcon();
testSubscriptionTrafficAndTeamDisconnectActionsUseDifferentIcons();

console.log("team subscription form regression checks passed");
