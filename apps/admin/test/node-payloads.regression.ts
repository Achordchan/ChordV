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

function testInboundDeployPayloadDerivesDestAndPreservesDeployedSpec() {
  // First deployment: only the operator's decisions; omitted fields take the
  // control-plane defaults. An EMPTY dest derives from the SNI — Reality's
  // fallback target must be able to present a valid certificate for the SNI,
  // so a custom SNI with the default microsoft target would deploy fine and
  // then fail every handshake.
  assert.deepEqual(
    buildInboundDeployPayload({ listenPort: 8443, serverName: "  www.example.org  ", dest: "", rotateKeys: false }),
    { listenPort: 8443, serverNames: ["www.example.org"], dest: "www.example.org:443", rotateKeys: false }
  );
  // An explicit target is kept (trimmed); an explicit port wins over the
  // 443 fallback.
  const explicit = buildInboundDeployPayload({ listenPort: "", serverName: "www.example.org", dest: "  proxy.example.org:8443  ", rotateKeys: true });
  assert.equal(explicit.dest, "proxy.example.org:8443");
  assert.equal(explicit.listenPort, 443);
  assert.equal(explicit.rotateKeys, true);

  // A reissue preserves the deployed flow/fingerprint/spiderX: without them
  // the server's defaults would silently reset them (e.g. flow "" →
  // xtls-rprx-vision) and cut off every client config already handed out.
  const reissue = buildInboundDeployPayload({
    listenPort: 443, serverName: "www.example.org", dest: "", rotateKeys: false,
    preserve: { flow: "", fingerprint: "safari", spiderX: "/api" }
  });
  assert.deepEqual(
    { flow: reissue.flow, fingerprint: reissue.fingerprint, spiderX: reissue.spiderX },
    { flow: "", fingerprint: "safari", spiderX: "/api" }
  );
  // No preserve on a first deployment: the fields stay ABSENT so the
  // control-plane defaults apply.
  const first = buildInboundDeployPayload({ listenPort: 443, serverName: "www.example.org", dest: "", rotateKeys: false });
  assert.equal(Object.hasOwn(first, "flow"), false);
  assert.equal(Object.hasOwn(first, "fingerprint"), false);
  assert.equal(Object.hasOwn(first, "spiderX"), false);
}

testInboundDeployPayloadDerivesDestAndPreservesDeployedSpec();
