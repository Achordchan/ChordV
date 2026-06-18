import assert from "node:assert/strict";
import { emptyNodeForm } from "../src/utils/admin-forms";
import { buildImportNodePayload, buildUpdateNodePayload } from "../src/utils/admin-node-payloads";

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
