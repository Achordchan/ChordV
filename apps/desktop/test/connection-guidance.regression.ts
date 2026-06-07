import assert from "node:assert/strict";
import { deriveGuidanceFromConnectFailure, readError } from "../src/lib/connectionGuidance";

function testPanelProvisioningPendingUsesActionableGuidance() {
  const message = readError("Panel client is queued but not confirmed yet: panel offline");
  assert.equal(message, "节点开通同步中，面板暂时不可用或尚未确认客户端，请稍后重试。");

  const guidance = deriveGuidanceFromConnectFailure(message, "node_fallback", "windows");
  assert.equal(guidance?.code, "node_provisioning_pending");
  assert.equal(guidance?.tone, "warning");
  assert.equal(guidance?.title, "节点开通同步中");
  assert.equal(guidance?.actionLabel, "稍后重试");
  assert.equal(guidance?.recommendedNodeId, "node_fallback");
}

function main() {
  testPanelProvisioningPendingUsesActionableGuidance();
  console.log("desktop connection guidance regression checks passed");
}

main();
