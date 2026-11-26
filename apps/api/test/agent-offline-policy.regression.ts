import assert from "node:assert/strict";
import {
  AGENT_OFFLINE_ALLOWANCE_BYTES,
  DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES,
  resolveAgentOfflineAllowanceBytes
} from "../src/modules/common/agent-offline-policy";
import { AgentService } from "../src/modules/agent/agent.service";
import { buildDirectUserQuotaPayload } from "../src/modules/common/runtime-session.service";

// What a node may serve on its own word while the control plane is unreachable:
// how MUCH (the offline allowance) and how LONG (the subscription's expiry).

async function main() {
  // --- the allowance ---------------------------------------------------------

  // 64 MiB cut every active user off within minutes of any control-plane
  // outage. Whatever the default becomes, it must not drift back to that order
  // of magnitude unnoticed.
  assert.equal(DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES, 5n * 1024n * 1024n * 1024n);
  assert.equal(resolveAgentOfflineAllowanceBytes(undefined), DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES);
  assert.equal(resolveAgentOfflineAllowanceBytes(""), DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES);
  assert.equal(resolveAgentOfflineAllowanceBytes("   "), DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES);
  assert.equal(resolveAgentOfflineAllowanceBytes("53687091200"), 53687091200n);
  assert.equal(resolveAgentOfflineAllowanceBytes(" 1073741824 "), 1073741824n, "首尾空白不应让配置失效");
  // Beyond Number.MAX_SAFE_INTEGER: the value travels as a decimal string and
  // must not be rounded through a float on the way.
  assert.equal(resolveAgentOfflineAllowanceBytes("900719925474099312345"), 900719925474099312345n);

  // A value that would be sent to every agent has to be one an agent can act
  // on. Zero is the dangerous one: it disables every user at the first failed
  // heartbeat.
  for (const bad of ["0", "-1", "10GB", "1e9", "1.5", "0x10", "010", "十"]) {
    const warnings: string[] = [];
    assert.equal(
      resolveAgentOfflineAllowanceBytes(bad, (message) => warnings.push(message)),
      DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES,
      `${bad} 不是合法的字节数，应回退默认值`
    );
    assert.equal(warnings.length, 1, `${bad} 被忽略时必须留下一条告警`);
    assert.ok(warnings[0].includes("CHORDV_AGENT_OFFLINE_ALLOWANCE_BYTES"), "告警必须指明是哪个配置项");
  }
  const silent: string[] = [];
  resolveAgentOfflineAllowanceBytes("1024", (message) => silent.push(message));
  resolveAgentOfflineAllowanceBytes(undefined, (message) => silent.push(message));
  assert.equal(silent.length, 0, "合法值与未配置都不应告警");

  // --- both ways a user reaches a node name the same figure -------------------

  const ensureQuota = buildDirectUserQuotaPayload({
    totalTrafficBytes: 1024n,
    usedTrafficBytes: 24n,
    remainingTrafficGb: 0
  });
  assert.equal(ensureQuota.offlineAllowanceBytes, AGENT_OFFLINE_ALLOWANCE_BYTES.toString());

  const expireAt = new Date("2026-12-31T16:00:00.000Z");
  const lapsedAt = new Date("2020-01-01T00:00:00.000Z");
  const binding = (id: string, subscription: Record<string, unknown>) => ({
    id,
    status: "active",
    source: "direct",
    directRevision: 7n,
    panelClientEmail: `${id}@chordv`,
    panelClientId: `uuid-${id}`,
    subscription: {
      state: "active",
      totalTrafficBytes: 1000n,
      usedTrafficBytes: 400n,
      remainingTrafficGb: 0,
      ...subscription
    }
  });
  const service = new AgentService({
    node: {
      findUnique: async () => ({
        id: "node-1",
        controlMode: "direct_primary",
        agentConfigRevision: 9n,
        flow: "xtls-rprx-vision",
        panelClientBindings: [
          binding("current", { expireAt }),
          binding("lapsed", { expireAt: lapsedAt }),
          binding("paused", { expireAt, state: "paused" })
        ]
      })
    }
  } as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);

  const config = await service.getConfig({ id: "agent-1", nodeId: "node-1" } as never);
  const byId = new Map(config.users.map((user) => [user.bindingId, user]));
  assert.equal(config.users.length, 3);

  const current = byId.get("current")!;
  assert.equal(current.offlineAllowanceBytes, AGENT_OFFLINE_ALLOWANCE_BYTES.toString(), "快照与 ENSURE_USER 的离线额度必须一致");
  // Without the date in the SNAPSHOT a node that restarts, reconnects or was
  // installed before the agent stored expiry never learns it — ENSURE_USER
  // alone only reaches users provisioned from now on.
  assert.equal(current.expiresAt, "2026-12-31T16:00:00.000Z", "快照必须下发订阅到期时间");
  assert.equal(current.enabled, true);
  assert.equal(current.quotaRemainingBytes, "600");

  // A subscription past its date that the control plane has not yet ended
  // (nothing has been metered since) is still ENABLED in the snapshot, with the
  // date. Ending it is the control plane's own transition, with a revision the
  // agents can order; a snapshot that flipped `enabled` by the clock instead
  // would disable the binding at its current revision, and nothing short of a
  // newer revision ever re-enables one.
  const lapsed = byId.get("lapsed")!;
  assert.equal(lapsed.enabled, true, "到期判定不得由快照按时钟隐式完成");
  assert.equal(lapsed.expiresAt, "2020-01-01T00:00:00.000Z");

  const paused = byId.get("paused")!;
  assert.equal(paused.enabled, false);
  assert.equal(paused.expiresAt, "2026-12-31T16:00:00.000Z");

  console.log("agent-offline-policy.regression.ts passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
