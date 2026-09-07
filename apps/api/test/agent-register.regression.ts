import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { UnauthorizedException } from "@nestjs/common";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import { AgentRegisterController } from "../src/modules/agent/agent-register.controller";
import { AgentInstallController } from "../src/modules/agent/agent-install.controller";
import { AgentAdminController } from "../src/modules/agent/agent-admin.controller";
import { AgentRegisterService } from "../src/modules/agent/agent-register.service";
import { hashAgentToken } from "../src/modules/agent/agent.service";
import { loadConfig } from "../../node-agent/src/config.js";

/**
 * Agent-native node onboarding (docs/prd/node-revision-agent-native.md, R1):
 * token minting, the register exchange (single-use, expiry, node lifecycle),
 * controller guard posture, install-script rendering, and agent-side config
 * bootstrap rules.
 */

function routeMetadata(controller: object, method: string) {
  const handler = (controller as { prototype: Record<string, unknown> }).prototype[method];
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler as object) as string,
    method: Reflect.getMetadata(METHOD_METADATA, handler as object) as number
  };
}

// 1) Controller posture: register/install routes are PUBLIC (the pre-credential
//    agent and `curl | bash` cannot authenticate); minting is admin-guarded.
{
  const registerGuards = (Reflect.getMetadata(GUARDS_METADATA, AgentRegisterController) ?? []) as unknown[];
  assert.equal(registerGuards.length, 0, "register route must be reachable without agent credentials");

  const registerRoute = routeMetadata(AgentRegisterController, "register");
  assert.equal(registerRoute.path, "register");
  assert.equal(registerRoute.method, 1, "register must be POST");

  const installGuards = (Reflect.getMetadata(GUARDS_METADATA, AgentInstallController) ?? []) as unknown[];
  assert.equal(installGuards.length, 0, "install script must be public (curl | bash)");
  const installRoute = routeMetadata(AgentInstallController, "installScript");
  assert.equal(installRoute.path, "agent-install/script.sh");
  assert.equal(installRoute.method, 1, "install script must be POST (token travels in the body, never the URL)");

  const adminGuards = (Reflect.getMetadata(GUARDS_METADATA, AgentAdminController) ?? []) as unknown[];
  assert.ok(adminGuards.includes(AdminAuthGuard), "token minting must stay behind AdminAuthGuard");
  const mintRoute = routeMetadata(AgentAdminController, "createAgentNode");
  assert.equal(mintRoute.path, "agent-native");
  assert.equal(mintRoute.method, 1, "agent-native creation must be POST");
  const regenRoute = routeMetadata(AgentAdminController, "issueRegisterToken");
  assert.equal(regenRoute.path, ":nodeId/register-token");
}

async function main() {
// 2) The register exchange: single-use, expiry, node lifecycle, and the minted
//    credentials use the same peppered-hash storage as operator-minted ones.
{
  type TokenRow = {
    id: string; nodeId: string; tokenHash: string; tokenPrefix: string;
    expiresAt: Date; usedAt: Date | null; createdAt: Date;
  };
  const tokens = new Map<string, TokenRow>();
  const createdAgents: Array<{ data: Record<string, unknown> }> = [];
  const updatedNodes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let nodeRow: Record<string, unknown> = { id: "node-1", registrationStatus: "pending_register", nodeAgents: [] };
  let liveAgentRow: Record<string, unknown> | null = null;
  const prisma = {
    agentRegisterToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => tokens.get(where.tokenHash) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = [...tokens.values()].find((entry) => entry.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }
    },
    nodeAgent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdAgents.push({ data });
        liveAgentRow = { id: "agent-row-1", ...data };
        return liveAgentRow;
      }
    },
    node: {
      findUnique: async () => ({ ...nodeRow, nodeAgents: liveAgentRow ? [liveAgentRow] : [] }),
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updatedNodes.push({ where, data });
        Object.assign(nodeRow, data);
        return nodeRow;
      }
    },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        agentRegisterToken: prisma.agentRegisterToken,
        nodeAgent: prisma.nodeAgent,
        node: prisma.node
      })
  };
  const service = new AgentRegisterService(prisma as never);

  const input = (token: string, agentToken = "chordv_agent_" + "a".repeat(43)) => ({
    registerToken: token, agentToken, hostname: "vps-1", arch: "linux-x64" as const,
    agentVersion: "0.1.0", bootId: "boot-1"
  });

  // Unknown token.
  await assert.rejects(() => service.register(input("chordv_register_missing")), UnauthorizedException);

  // Valid single use.
  const token = "chordv_register_good";
  tokens.set(hashAgentToken(token), {
    id: "t-1", nodeId: "node-1", tokenHash: hashAgentToken(token), tokenPrefix: "chordv_register_",
    expiresAt: new Date(Date.now() + 60_000), usedAt: null, createdAt: new Date()
  });
  const clientToken = "chordv_agent_" + "b".repeat(43);
  for (const status of ["agent_ready", null]) {
    nodeRow.registrationStatus = status;
    await assert.rejects(() => service.register(input(token, clientToken)), /不处于待注册状态/);
    assert.equal(createdAgents.length, 0);
    assert.equal(tokens.get(hashAgentToken(token))?.usedAt, null);
    assert.equal(updatedNodes.length, 0);
  }
  nodeRow.registrationStatus = "pending_register";
  const result = await service.register(input(token, clientToken));
  assert.equal(result.accepted, true);
  assert.equal(result.nodeId, "node-1");
  assert.match(result.agentId, /^agent-[0-9a-f]{16}$/);
  assert.equal(
    (createdAgents[0].data as { tokenHash: string }).tokenHash,
    hashAgentToken(clientToken),
    "the CLIENT-generated credential must be stored hashed with the agent-token pepper"
  );
  assert.equal(
    (createdAgents[0].data as { tokenPrefix: string }).tokenPrefix,
    clientToken.slice(0, 20)
  );
  assert.equal(tokens.get(hashAgentToken(token))?.usedAt instanceof Date, true, "token consumed");
  const readyUpdate = updatedNodes.find((update) => update.data.registrationStatus === "agent_ready");
  assert.ok(readyUpdate, "registration must flip the node to agent_ready");

  // IDMPOTENT REPLAY: the registration committed but the agent never received
  // the response — retrying with the SAME client credential returns the same
  // identity instead of a dead end (token already used).
  const agentsBefore = createdAgents.length;
  const replay = await service.register(input(token, clientToken));
  assert.equal(replay.accepted, true);
  assert.equal(replay.agentId, result.agentId, "replay returns the SAME agent identity");
  assert.equal(createdAgents.length, agentsBefore, "replay must not mint a second credential");

  // Replay with a DIFFERENT credential (a thief racing the token): rejected.
  await assert.rejects(() => service.register(input(token, "chordv_agent_" + "c".repeat(43))), /已被使用|不可复用/);
  assert.equal(createdAgents.length, agentsBefore, "foreign credential replay must not mint anything");

  const usedAt = tokens.get(hashAgentToken(token))!.usedAt;
  const updatesBeforeReplay = updatedNodes.length;
  tokens.get(hashAgentToken(token))!.expiresAt = new Date(Date.now() - 1000);
  const expiredReplay = await service.register(input(token, clientToken));
  assert.equal(expiredReplay.agentId, result.agentId);
  assert.equal(createdAgents.length, agentsBefore);
  assert.equal(updatedNodes.length, updatesBeforeReplay);
  assert.equal(tokens.get(hashAgentToken(token))!.usedAt, usedAt);
  await assert.rejects(() => service.register(input(token, "chordv_agent_" + "z".repeat(43))), UnauthorizedException);

  // Expired token.
  const expired = "chordv_register_expired";
  tokens.set(hashAgentToken(expired), {
    id: "t-2", nodeId: "node-1", tokenHash: hashAgentToken(expired), tokenPrefix: "chordv_register_",
    expiresAt: new Date(Date.now() - 1_000), usedAt: null, createdAt: new Date()
  });
  await assert.rejects(() => service.register(input(expired)), /已过期/);
  await assert.rejects(() => service.register(input(expired, clientToken)), /已过期/, "unused expired token cannot use replay shortcut");
  const activeCredential = liveAgentRow; liveAgentRow = null;
  await assert.rejects(() => service.register(input(token, clientToken)), UnauthorizedException, "revoked credential cannot replay");
  liveAgentRow = activeCredential;

  // Node already holding a live agent registered by a DIFFERENT credential:
  // a new token (e.g. regenerated) must not register a second agent.
  const liveAgentToken = "chordv_register_live";
  nodeRow = { id: "node-1", registrationStatus: "agent_ready", nodeAgents: [{ id: "existing" }] };
  tokens.set(hashAgentToken(liveAgentToken), {
    id: "t-3", nodeId: "node-1", tokenHash: hashAgentToken(liveAgentToken), tokenPrefix: "chordv_register_",
    expiresAt: new Date(Date.now() + 60_000), usedAt: null, createdAt: new Date()
  });
  await assert.rejects(() => service.register(input(liveAgentToken)), /已存在有效 Agent/);
}

// 3) Install-script rendering: usable token yields a script carrying the
//    public base URL and the token; spent/unknown tokens yield a clear error
//    script instead of a bare 404. The rendered install script must reference
//    the /api global prefix and pass a bash syntax check.
{
  const { renderInstallScript } = await import("../src/modules/agent/agent-install.controller.js");
  const script = renderInstallScript({ token: "chordv_register_render", apiBase: "https://v.example.com" });
  assert.ok(script.includes('API_BASE="https://v.example.com/api"'), "script must target the /api global prefix");
  assert.ok(!script.includes("command -v node") || script.includes("candidate_version"), "node probing must check each candidate's version");
  assert.ok(script.includes('CHORDV_API_BASE_URL=${API_BASE%/api}'), "agent env must carry the un-prefixed origin");
  assert.ok(script.includes("^v20\\.19\\."), "script must enforce the same Node 20.19.x contract as release build");
  assert.ok(script.includes("ExecStart=${NODE_BIN@Q}"), "systemd unit must use the probed node binary");
  assert.ok(!script.includes("__CHORDV_API_BASE__"), "no placeholder may leak into rendered scripts");
  const bashCheck = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(bashCheck.status, 0, bashCheck.stderr);
  const prisma = {
    agentRegisterToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        if (where.tokenHash === hashAgentToken("chordv_install_ok")) {
          return { nodeId: "node-1", usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
        }
        if (where.tokenHash === hashAgentToken("chordv_install_spent")) {
          return { nodeId: "node-1", usedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
        }
        return null;
      }
    }
  };
  const service = new AgentRegisterService(prisma as never);
  assert.deepEqual(await service.resolveTokenNode("chordv_install_ok"), { nodeId: "node-1", usable: true });
  assert.deepEqual(await service.resolveTokenNode("chordv_install_spent"), { nodeId: "node-1", usable: false });
  assert.equal(await service.resolveTokenNode("unknown-token"), null);
  assert.equal(await service.resolveTokenNode(""), null);
}

// 4) Agent-side config bootstrap: register token XOR credentials, never both.
{
  const previous = { ...process.env };
  try {
    const baseEnv = { CHORDV_API_BASE_URL: "https://api.example.com" };
    const apply = (overrides: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries({ ...previous, ...baseEnv, ...overrides })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    apply({
      CHORDV_AGENT_ID: undefined, CHORDV_NODE_ID: undefined, CHORDV_AGENT_TOKEN: undefined,
      CHORDV_REGISTER_TOKEN: "chordv_register_boot"
    });
    const withToken = loadConfig();
    assert.equal(withToken.registerToken, "chordv_register_boot");
    assert.equal(withToken.agentId, "");

    apply({
      CHORDV_AGENT_ID: "a-1", CHORDV_NODE_ID: "n-1", CHORDV_AGENT_TOKEN: "tok",
      CHORDV_REGISTER_TOKEN: undefined
    });
    const withCredentials = loadConfig();
    assert.equal(withCredentials.registerToken, undefined);
    assert.equal(withCredentials.token, "tok");

    apply({
      CHORDV_AGENT_ID: "a-1", CHORDV_NODE_ID: "n-1", CHORDV_AGENT_TOKEN: "tok",
      CHORDV_REGISTER_TOKEN: "chordv_register_boot"
    });
    assert.throws(() => loadConfig(), /互斥/);

    apply({
      CHORDV_AGENT_ID: undefined, CHORDV_NODE_ID: undefined, CHORDV_AGENT_TOKEN: undefined,
      CHORDV_REGISTER_TOKEN: undefined,
      AGENT_CREDENTIALS_PATH: "/nonexistent/credentials.json"
    });
    assert.throws(() => loadConfig(), /CHORDV_AGENT_ID|凭据文件/);

    // A persisted credentials file alone is a valid boot source (restart after
    // registration removed the spent token from the env).
    const credentialsDir = mkdtempSync(join(tmpdir(), "chordv-agent-creds-"));
    writeFileSync(join(credentialsDir, "credentials.json"), "{}");
    apply({
      AGENT_CREDENTIALS_PATH: join(credentialsDir, "credentials.json"),
      CHORDV_REGISTER_TOKEN: undefined
    });
    const withFileOnly = loadConfig();
    assert.equal(withFileOnly.registerToken, undefined);
    assert.equal(withFileOnly.agentId, "");
    rmSync(credentialsDir, { recursive: true, force: true });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
}

void main().then(() => {
  console.log("agent-register.regression.ts passed (guards, single-use register, expiry, install resolution, agent bootstrap)");
}).catch((error) => { console.error(error); process.exitCode = 1; });
