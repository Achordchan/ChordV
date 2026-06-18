import assert from "node:assert/strict";
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

  const payload = buildCreateTeamSubscriptionPayload(form, "2026-07-01T00:00:00.000Z");

  assert.deepEqual(payload, {
    planId: teamPlan.id,
    totalTrafficGb: 2048,
    usedTrafficGb: 88.25,
    expireAt: new Date(form.expireAt).toISOString()
  });
}

function testCreateTeamSubscriptionPayloadDefaultsUsedTrafficToZero() {
  const form = {
    ...emptyTeamSubscriptionForm(),
    planId: teamPlan.id,
    expireAt: ""
  };

  const payload = buildCreateTeamSubscriptionPayload(form, "2026-07-01T00:00:00.000Z");

  assert.equal(payload.usedTrafficGb, 0);
  assert.equal(payload.expireAt, "2026-07-01T00:00:00.000Z");
}

testEmptyTeamSubscriptionFormDefaultsUsedTrafficToZero();
testApplyTeamPlanKeepsUsedTraffic();
testApplyMissingTeamPlanKeepsUsedTraffic();
testCreateTeamSubscriptionPayloadIncludesUsedTraffic();
testCreateTeamSubscriptionPayloadDefaultsUsedTrafficToZero();

console.log("team subscription form regression checks passed");
