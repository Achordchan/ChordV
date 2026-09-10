import assert from "node:assert/strict";
import { parsePanelLink, normalizePanelInbound, parsePanelReport } from "../src/modules/agent/panel-inbound";

const publicKey = Buffer.alloc(32, 7).toString("base64url");
const link = `vless://discard-this-placeholder@node.example.com:8443?security=reality&type=tcp&pbk=${publicKey}&sid=abcd&sni=example.com&fp=chrome&flow=xtls-rprx-vision#Panel`;
const spec = parsePanelLink(link, "3.7.0");
assert.equal(spec.inboundTag, "inbound-8443");
assert.equal(spec.listenPort, 8443);
assert.equal(spec.realityPublicKey, publicKey);
assert.equal(JSON.stringify(spec).includes("discard-this-placeholder"), false);
assert.equal("dest" in spec, false, "SNI is not proof of server-side dest");
assert.throws(() => parsePanelLink(link, "3.6.9"), /3.7.0/);
assert.throws(() => parsePanelLink(link, "3.7.0-beta"), /稳定版/);
assert.throws(() => parsePanelLink(link, "3.7.0", "other"), /覆盖/);
assert.equal(parsePanelLink(link, "3.7.0", "other", true).inboundTag, "other");
assert.throws(() => parsePanelLink(link.replace("type=tcp", "type=ws"), "3.7.0"), /TCP/);
assert.throws(() => parsePanelLink(link.replace("#Panel", "&pbk=duplicate"), "3.7.0"), /重复/);
assert.throws(() => parsePanelLink(link.replace("node.example.com", "127.0.0.1"), "3.7.0"), /内网/);
assert.throws(() => normalizePanelInbound({ ...spec, rotateKeys: true }), /轮换/);
assert.throws(() => parsePanelReport({ inbound: { validated: true } }, spec), /校验结果/);
const inbound = { mode: "validate_panel", validated: true, inboundTag: spec.inboundTag, serverPort: spec.listenPort,
  serverHost: spec.serverHost, realityPublicKey: spec.realityPublicKey, shortId: spec.shortId, serverName: spec.serverNames[0],
  flow: spec.flow, fingerprint: spec.fingerprint, spiderX: spec.spiderX };
assert.equal(parsePanelReport({ inbound }, spec).serverPort, 8443);
assert.throws(() => parsePanelReport({ inbound: { ...inbound, realityPublicKey: "wrong" } }, spec), /realityPublicKey/);
console.log("panel inbound parser/report regression passed");

async function serviceRegression() {
  const { AgentService } = await import("../src/modules/agent/agent.service");
  let version = "0.1.0";
  let active = false;
  let wrote = false; let affected = 1;
  const tx = {
    $queryRaw: async () => [],
    node: { findUnique: async () => ({ isActive: active }), update: async () => { throw new Error("past-guards"); } }
  };
  const service = new AgentService({ nodeAgent: { findFirst: async () => ({ id: "agent-1", version }) },
    node: { findUnique: async () => ({ inboundAppliedRevision: 0n }) },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx) } as never, {} as never, {} as never);
  const input = { type: "ENSURE_INBOUND", payload: spec, expectedInboundAppliedRevision: "0" };
  await assert.rejects(() => service.queueCommand("node-1", input as never), /旧 Node agent/);
  version = "go-0.2.0";
  active = true;
  await assert.rejects(() => service.queueCommand("node-1", input as never), /先停用/);
  active = false;
  await assert.rejects(() => service.queueCommand("node-1", { ...input, expectedInboundAppliedRevision: undefined } as never), /revision/);
  await assert.rejects(() => service.queueCommand("node-1", input as never), /past-guards/);
  const reportTx = {
    $queryRaw: async () => [],
    nodeCommandJob: { findFirst: async () => ({ id: "c1", commandType: "ENSURE_INBOUND", payload: spec, targetRevision: 2n, dedupeKey: "key" }), update: async () => ({}) },
    node: { updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      wrote = true;
      assert.equal(data.serverHost, spec.serverHost);
      assert.equal(data.inboundAppliedRevision, 2n);
      assert.equal("isActive" in data, false);
      assert.equal("uuid" in data, false);
      return { count: affected };
    } }
  };
  const complete = new AgentService({ $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(reportTx) } as never, {} as never, {} as never);
  await complete.completeCommand({ id: "agent-1", nodeId: "node-1" } as never, "c1", { status: "completed", result: { inbound } } as never);
  assert.equal(wrote, true);
  affected = 0;
  await assert.rejects(() => complete.completeCommand({ id: "agent-1", nodeId: "node-1" } as never, "c1", { status: "completed", result: { inbound } } as never), /已激活或校验结果已过期/);
}
serviceRegression().then(() => console.log("panel inbound service guards passed"));
