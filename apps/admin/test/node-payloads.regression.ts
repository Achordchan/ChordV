import assert from "node:assert/strict";
import { emptyNodeForm } from "../src/utils/admin-forms";
import { buildImportNodePayload, buildInboundDeployPayload, buildUpdateNodePayload } from "../src/utils/admin-node-payloads";

function testImportNodeKeepsOnlySubscriptionUrl() {
  const payload = buildImportNodePayload({
    ...emptyNodeForm(),
    provider: "",
    panelInboundId: Number.NaN,
    subscriptionUrl: "  https://node.example.com/sub  "
  });

  assert.equal(payload.subscriptionUrl, "https://node.example.com/sub");
  assert.equal(payload.name, undefined);
  assert.equal(payload.provider, undefined);
  assert.equal(payload.panelBaseUrl, undefined);
  assert.equal(payload.panelInboundId, undefined);
}

function testUpdateNodeCanClearSubscriptionUrl() {
  const payload = buildUpdateNodePayload({
    ...emptyNodeForm(),
    subscriptionUrl: "   "
  });

  assert.equal(Object.hasOwn(payload, "subscriptionUrl"), true);
  assert.equal(payload.subscriptionUrl, null);
}

testImportNodeKeepsOnlySubscriptionUrl();
testUpdateNodeCanClearSubscriptionUrl();

console.log("admin node payload regression checks passed");

function testInboundDeployPayloadOnlyCarriesOperatorDecisions() {
  const payload = buildInboundDeployPayload({ listenPort: 8443, serverName: "  www.example.org  ", rotateKeys: false });
  assert.deepEqual(payload, { listenPort: 8443, serverNames: ["www.example.org"], rotateKeys: false });
  // Empty port falls back to the control-plane default; the server normalizes
  // and validates the whole spec again.
  assert.equal(buildInboundDeployPayload({ listenPort: "", serverName: "www.example.org", rotateKeys: true }).listenPort, 443);
  assert.equal(buildInboundDeployPayload({ listenPort: "", serverName: "www.example.org", rotateKeys: false }).rotateKeys, false);
}

testInboundDeployPayloadOnlyCarriesOperatorDecisions();
