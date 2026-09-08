import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { shouldProvisionPanelClients } from "../src/modules/common/runtime-session.utils";
import { usesAgentControl } from "../src/modules/common/node-control-mode";
import { isNodeOnboardingReady } from "../src/modules/common/node-onboarding-policy";

// R3 regression trio: three behaviors a review round caught being broken by
// the panel retirement — every one of them silently wrong without these.

// 1) The connect gate must ADMIT direct_primary (the only supported mode now).
//    An inverted condition rejects every connection to a registered, enabled
//    node — no normal client can connect at all.
const runtimeSessionSource = readFileSync(path.resolve(__dirname, "../src/modules/common/runtime-session.service.ts"), "utf8");
assert.equal(usesAgentControl("direct_primary"), true, "direct_primary 必须由 agent 控制");
assert.equal(usesAgentControl("xui_primary"), false, "xui_primary 不再受支持");
assert.match(
  runtimeSessionSource,
  /if \(!usesAgentControl\(node\.controlMode\)\) \{\s*\n\s*throw new ForbiddenException\("当前节点控制模式不可用"\);/,
  "connect 的门槛必须是「非 agent 控制才拒绝」，反转会让所有 direct 节点无法连接"
);
assert.doesNotMatch(
  runtimeSessionSource,
  /if \(usesAgentControl\(node\.controlMode\)\) \{\s*\n\s*throw new ForbiddenException/,
  "connect 不得拒绝 agent 控制的节点"
);

// 2) Provisioning eligibility must go through the SHARED predicate: it carries
//    the team/account status checks a bare subscription.state check drops —
//    renewing an active subscription of a DISABLED team would otherwise
//    re-provision (ENSURE_USER) credentials the team shutdown disabled.
const baseSubscription = {
  state: "active" as const,
  expireAt: new Date(Date.now() + 86_400_000),
  remainingTrafficGb: 100
};
assert.equal(shouldProvisionPanelClients(baseSubscription), true, "活跃订阅应供给");
assert.equal(
  shouldProvisionPanelClients({ ...baseSubscription, team: { status: "suspended" as never } }),
  false,
  "被停用团队的订阅不得供给（绕过会恢复团队停用禁用的凭据）"
);
assert.equal(
  shouldProvisionPanelClients({ ...baseSubscription, user: { status: "disabled" as const } }),
  false,
  "被停用账户的订阅不得供给"
);
assert.equal(
  shouldProvisionPanelClients({ ...baseSubscription, remainingTrafficGb: 0 }),
  false,
  "流量耗尽的订阅不得供给"
);
assert.match(
  runtimeSessionSource,
  /const shouldProvision = shouldProvisionPanelClients\(subscription\);/,
  "供给资格必须走共享判定函数，不得内联简化"
);

// 3) Disabling a node must disable its bindings too: getConfig does not check
//    node.isActive, so previously issued credentials would keep working on the
//    disabled node outside the managed client's lease handling.
const adminNodeSource = readFileSync(path.resolve(__dirname, "../src/modules/common/admin-node.service.ts"), "utf8");
assert.match(
  adminNodeSource,
  /markPanelBindingsDisabledForNode\(nodeId\)/,
  "禁用节点必须同时禁用其绑定（否则已发凭据在 getConfig 下继续可用）"
);
assert.match(
  runtimeSessionSource,
  /async markPanelBindingsDisabledForNode\(nodeId: string\) \{[\s\S]*?markPanelBindingsDisabledForSubscription\(subscription\.id, \{ nodeIds: \[nodeId\] \}\)/,
  "节点级禁用必须逐订阅按节点过滤执行"
);

// Guard the gate's neighbors too: an onboarding-ready direct node must pass
// the policy check that the connect path relies on.
assert.equal(
  isNodeOnboardingReady({
    registrationStatus: "agent_ready",
    protocol: "vless",
    security: "reality",
    uuid: "11111111-1111-4111-8111-111111111111",
    realityPublicKey: "k".repeat(43),
    serverName: "www.microsoft.com",
    fingerprint: "chrome",
    serverHost: "203.0.113.7",
    serverPort: 443
  }),
  true,
  "agent_ready + 已部署参数的节点必须可连"
);

console.log("runtime session regression passed (connect 门不反转、供给资格共享判定、节点禁用联动绑定)");
