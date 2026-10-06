import assert from "node:assert/strict";
import { canForceConnectGuidance, deriveGuidanceFromConnectFailure, readError } from "../src/lib/connectionGuidance";

function testPanelProvisioningPendingUsesActionableGuidance() {
  const message = readError("Panel client is queued but not confirmed yet: panel offline");
  assert.equal(message, "节点开通同步中，请稍后重试。");

  const guidance = deriveGuidanceFromConnectFailure(message, "node_fallback", "windows");
  assert.equal(guidance?.code, "node_provisioning_pending");
  assert.equal(guidance?.tone, "warning");
  assert.equal(guidance?.title, "节点开通同步中");
  assert.equal(guidance?.actionLabel, "稍后重试");
  assert.equal(guidance?.recommendedNodeId, "node_fallback");
}

function testForceConnectOnlyOffersForExternalConflicts() {
  for (const raw of ["external_vpn_conflict: 检测到系统中已有 VPN 正在运行（x），请先断开后再连接 ChordV。", "external_proxy_conflict: 检测到系统代理已由其他应用占用（x），请先关闭后再连接 ChordV。"]) {
    const guidance = deriveGuidanceFromConnectFailure(readError(raw), null, "macos");
    assert.ok(guidance && canForceConnectGuidance(guidance.code), `${raw} should offer force connect`);
  }
  const other = deriveGuidanceFromConnectFailure(readError("Panel client is queued but not confirmed yet: panel offline"), null, "windows");
  assert.ok(other && !canForceConnectGuidance(other.code), "unrelated failures must never offer force connect");
}

function main() {
  testPanelProvisioningPendingUsesActionableGuidance();
  testForceConnectOnlyOffersForExternalConflicts();
  console.log("desktop connection guidance regression checks passed");
}

main();
