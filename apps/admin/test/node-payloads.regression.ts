import assert from "node:assert/strict";
import { emptyNodeForm } from "../src/utils/admin-forms";
import { buildInboundDeployPayload, buildUpdateNodePayload } from "../src/utils/admin-node-payloads";

function testUpdateNodePayloadCarriesProfileFieldsOnly() {
  const payload = buildUpdateNodePayload({
    ...emptyNodeForm(),
    name: "  UAT Node  ",
    provider: "uat",
    tags: " a , b ",
    isActive: false,
    recommended: true
  });

  assert.equal(payload.name, "  UAT Node  ");
  assert.equal(payload.provider, "uat");
  assert.deepEqual(payload.tags, ["a", "b"]);
  assert.equal(payload.isActive, false);
  assert.equal(payload.recommended, true);
  for (const field of ["subscriptionUrl", "panelBaseUrl", "panelInboundId", "panelEnabled"]) {
    assert.equal(Object.hasOwn(payload, field), false, `${field} 已随面板退役移除`);
  }
}

testUpdateNodePayloadCarriesProfileFieldsOnly();

console.log("admin node payload regression checks passed");

function testInboundDeployPayloadDerivesDestAndPreservesDeployedSpec() {
  // First deployment: only the operator's decisions; omitted fields take the
  // control-plane defaults. An EMPTY dest derives from the first SNI —
  // Reality's fallback target must be able to present a valid certificate for
  // the SNI, so a custom SNI with the default microsoft target would deploy
  // fine and then fail every handshake.
  assert.deepEqual(
    buildInboundDeployPayload({ listenPort: 8443, serverNamesCsv: "  www.example.org  ,  alt.example.org ", dest: "", rotateKeys: false }),
    { listenPort: 8443, serverNames: ["www.example.org", "alt.example.org"], dest: "www.example.org:443", rotateKeys: false }
  );
  // An explicit target is kept (trimmed); an explicit port wins over the 443
  // fallback.
  const explicit = buildInboundDeployPayload({ listenPort: "", serverNamesCsv: "www.example.org", dest: "  proxy.example.org:8443  ", rotateKeys: true });
  assert.equal(explicit.dest, "proxy.example.org:8443");
  assert.equal(explicit.listenPort, 443);
  assert.equal(explicit.rotateKeys, true);

  // A reissue preserves the deployed flow/fingerprint/spiderX AND inboundTag:
  // without them the server's defaults would silently reset them (e.g. flow ""
  // → xtls-rprx-vision) and cut off every client config already handed out.
  const reissue = buildInboundDeployPayload({
    listenPort: 443, serverNamesCsv: "a.example.org, b.example.org", dest: "", rotateKeys: false,
    preserve: { flow: "", fingerprint: "safari", spiderX: "/api", inboundTag: "custom-in" }
  });
  assert.deepEqual(
    { flow: reissue.flow, fingerprint: reissue.fingerprint, spiderX: reissue.spiderX, inboundTag: reissue.inboundTag },
    { flow: "", fingerprint: "safari", spiderX: "/api", inboundTag: "custom-in" }
  );
  // No preserve on a first deployment: the fields stay ABSENT so the
  // control-plane defaults apply (including the default inboundTag).
  const first = buildInboundDeployPayload({ listenPort: 443, serverNamesCsv: "www.example.org", dest: "", rotateKeys: false });
  for (const field of ["flow", "fingerprint", "spiderX", "inboundTag"]) {
    assert.equal(Object.hasOwn(first, field), false, `${field} 首次部署必须缺席`);
  }
  // An empty SNI list cannot build a payload at all.
  assert.throws(() => buildInboundDeployPayload({ listenPort: 443, serverNamesCsv: "  ", dest: "", rotateKeys: false }), /SNI 不能为空/);
}

testInboundDeployPayloadDerivesDestAndPreservesDeployedSpec();
