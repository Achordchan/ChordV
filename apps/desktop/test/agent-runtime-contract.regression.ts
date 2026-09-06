import assert from "node:assert/strict";
import type { GeneratedRuntimeConfigDto, RuntimeOutboundDto } from "../../../packages/shared/src/types.ts";

const outbound = {
  protocol: "vless",
  server: "edge.example.invalid",
  port: 443,
  uuid: "123e4567-e89b-42d3-a456-426614174000",
  flow: "xtls-rprx-vision",
  realityPublicKey: "public-key-fixture",
  shortId: "01234567",
  serverName: "cdn.example.invalid",
  fingerprint: "chrome",
  spiderX: "/",
  mldsa65Verify: null
} satisfies RuntimeOutboundDto;

const runtime = {
  sessionId: "session_fixture",
  leaseId: "lease_fixture",
  leaseExpiresAt: "2026-07-26T00:10:00.000Z",
  leaseHeartbeatIntervalSeconds: 20,
  leaseGraceSeconds: 60,
  node: {
    id: "node_fixture",
    name: "测试节点",
    region: "测试地区",
    countryCode: "US",
    provider: "fixture",
    tags: [],
    latencyMs: 15,
    recommended: false,
    protocol: "vless",
    security: "reality"
  },
  mode: "rule",
  localHttpPort: 17890,
  localSocksPort: 17891,
  routingProfile: "managed-rule-default",
  generatedAt: "2026-07-26T00:00:00.000Z",
  features: { blockAds: true, chinaDirect: true, aiServicesProxy: true },
  customRoutingRules: [],
  outbound
} satisfies GeneratedRuntimeConfigDto;

const decoded = JSON.parse(JSON.stringify(runtime)) as GeneratedRuntimeConfigDto;
assert.deepEqual(decoded, runtime);
assert.equal(decoded.outbound.uuid, outbound.uuid);
assert.deepEqual(Object.keys(decoded.outbound).sort(), [
  "fingerprint",
  "flow",
  "mldsa65Verify",
  "port",
  "protocol",
  "realityPublicKey",
  "server",
  "serverName",
  "shortId",
  "spiderX",
  "uuid"
]);
assert.equal("controlMode" in decoded, false);
assert.equal("meteringSource" in decoded, false);
assert.equal("agentId" in decoded, false);

console.log("agent-runtime-contract.regression.ts passed");
