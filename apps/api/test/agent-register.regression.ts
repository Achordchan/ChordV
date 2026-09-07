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
  // Live agents belonging to OTHER nodes, i.e. what a cross-node credential
  // reuse attempt would collide with.
  const foreignAgents: Array<Record<string, unknown>> = [];
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
      },
      // Mirrors the global `NodeAgent.tokenHash` unique index: any agent row
      // (on any node) that already carries this hash is returned.
      findFirst: async ({ where }: { where: { tokenHash: string; nodeId?: { not: string } } }) => {
        const rows = [...foreignAgents, ...(liveAgentRow ? [liveAgentRow] : [])] as Array<Record<string, unknown>>;
        return rows.find((row) =>
          row.tokenHash === where.tokenHash &&
          (!where.nodeId?.not || row.nodeId !== where.nodeId.not)
        ) ?? null;
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

  // CROSS-NODE CREDENTIAL REUSE: a client presenting a valid token for node-2
  // while its persistent secret is already bound to node-1 is rejected with a
  // clear error, not a raw unique-constraint failure — and no agent is created,
  // so `authenticate()` can never resolve one hash to two nodes.
  const crossToken = "chordv_register_cross";
  const boundToken = "chordv_agent_" + "d".repeat(43);
  foreignAgents.push({ id: "foreign", nodeId: "node-1", agentId: "agent-node-1", tokenHash: hashAgentToken(boundToken) });
  nodeRow = { id: "node-2", registrationStatus: "pending_register", nodeAgents: [] };
  liveAgentRow = null;
  tokens.set(hashAgentToken(crossToken), {
    id: "t-4", nodeId: "node-2", tokenHash: hashAgentToken(crossToken), tokenPrefix: "chordv_register_",
    expiresAt: new Date(Date.now() + 60_000), usedAt: null, createdAt: new Date()
  });
  const beforeCross = createdAgents.length;
  await assert.rejects(() => service.register(input(crossToken, boundToken)), /已绑定其他节点/);
  assert.equal(createdAgents.length, beforeCross, "cross-node reuse must not mint a credential");
  assert.equal(tokens.get(hashAgentToken(crossToken))?.usedAt, null, "a rejected reuse must not consume the token");
  // A fresh secret on the same token registers normally.
  const ownToken = "chordv_agent_" + "e".repeat(43);
  const crossOk = await service.register(input(crossToken, ownToken));
  assert.equal(crossOk.nodeId, "node-2");
  assert.equal(createdAgents.length, beforeCross + 1);
}

// 3) Install-script rendering: usable token yields a script carrying the
//    public base URL and the token; spent/unknown tokens yield a clear error
//    script instead of a bare 404. The rendered install script must reference
//    the /api global prefix and pass a bash syntax check.
{
  const { renderInstallScript, normalizeOrigin, AgentInstallController } =
    await import("../src/modules/agent/agent-install.controller.js");
  const script = renderInstallScript({ token: "chordv_register_render", apiBase: "https://v.example.com" });
  assert.ok(script.includes("API_BASE='https://v.example.com/api'"), "script must target the /api global prefix as a shell literal");
  assert.ok(script.includes("REGISTER_TOKEN='chordv_register_render'"), "the token must be a single-quoted literal");
  assert.ok(!script.includes("command -v node") || script.includes("candidate_version"), "node probing must check each candidate's version");
  assert.ok(script.includes('CHORDV_API_BASE_URL=${API_BASE%/api}'), "agent env must carry the un-prefixed origin");
  assert.ok(script.includes("^v20\\.19\\."), "script must enforce the same Node 20.19.x contract as release build");
  assert.ok(script.includes("ExecStart=${NODE_BIN@Q}"), "systemd unit must use the probed node binary");
  // The env file is shell-sourced by deploy/health-check.sh, which operators run
  // as root: it must stay root-owned so a compromised agent cannot inject
  // commands into a root shell. Group read is all the service ever needs.
  assert.ok(script.includes('chown root:"$SERVICE_USER" "$ENV_FILE"'), "env file must stay root-owned");
  assert.ok(!/chown "\$SERVICE_USER:\$SERVICE_USER" "\$ENV_FILE"/.test(script), "env file must not be service-owned");
  assert.ok(script.includes('chmod 0640 "$ENV_FILE"'), "env file must not be world/group writable");
  assert.ok(script.includes("install -d -m 0750 -o root -g root /etc/chordv"), "env directory must be root-owned");
  // A legacy env-only identity must not be silently replaced: the new node
  // would inherit the old node's /var/lib state.
  assert.ok(
    /CHORDV_AGENT_ID\|CHORDV_AGENT_TOKEN\|CHORDV_NODE_ID/.test(script),
    "installer must detect an existing environment identity before overwriting it"
  );
  assert.ok(script.indexOf("已存在以环境变量配置的 Agent 身份") < script.indexOf("agent-download"),
    "the identity guard must run BEFORE anything is downloaded or installed");
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

  // 3b) The origin is derived from ATTACKER-CONTROLLED headers and lands in a
  //     script that runs as root. Only a bare, validated http(s) origin passes,
  //     and it is emitted as a single-quoted literal — a Host header carrying
  //     command substitution must never reach executable code.
  for (const hostile of [
    "https://$(id>/tmp/pwn).example.com", "https://`id`.example.com", "https://a.example.com/../x",
    "https://a.example.com/?x=1", "https://a.example.com#f", "https://user:pw@a.example.com",
    "https://a.example.com\nrm -rf /", 'https://a.example.com"; id; "', "file:///etc/passwd",
    "javascript:alert(1)", "not a url", "", "   ", undefined
  ]) {
    assert.equal(normalizeOrigin(hostile), "", `hostile origin must be rejected: ${String(hostile)}`);
  }
  assert.equal(normalizeOrigin("https://v.example.com/"), "https://v.example.com");
  assert.equal(normalizeOrigin("https://[2001:db8::1]:8443"), "https://[2001:db8::1]:8443");
  // Plain HTTP is loopback-only: a remote-HTTP installer would fetch an
  // executable package over unauthenticated transport, and the installed agent
  // would then refuse that same base URL and never register.
  assert.equal(normalizeOrigin("http://10.0.0.4:8080"), "");
  assert.equal(normalizeOrigin("http://v.example.com"), "");
  assert.equal(normalizeOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(normalizeOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeOrigin("http://[::1]:3000"), "http://[::1]:3000");
  // The installer's policy must not drift from the agent's own check: anything
  // the script would configure has to be accepted by assertSafeApiBaseUrl.
  const { assertSafeApiBaseUrl } = await import("../../node-agent/src/config.js");
  for (const candidate of [
    "https://v.example.com", "http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000",
    "http://10.0.0.4:8080", "http://v.example.com"
  ]) {
    const accepted = normalizeOrigin(candidate) !== "";
    let agentAccepts = true;
    try { assertSafeApiBaseUrl(candidate); } catch { agentAccepts = false; }
    assert.equal(accepted, agentAccepts, `installer/agent policy mismatch for ${candidate}`);
  }
  // Rendering enforces the same contract even if a caller forgets to validate.
  assert.throws(() => renderInstallScript({ token: "t", apiBase: "https://a.example.com/$(id)" }), /公网地址无效/);
  assert.throws(() => renderInstallScript({ token: "$(id)", apiBase: "https://a.example.com" }), /注册令牌格式无效/);

  // End to end through the controller with a hostile Host header: the operator
  // gets a configuration-error script, not injected commands.
  const controller = new AgentInstallController(service as never);
  const captured: string[] = [];
  const fakeResponse = () => ({ status: () => {}, setHeader: () => {}, end: (body: string) => captured.push(body) });
  const previousBase = process.env.CHORDV_PUBLIC_BASE_URL;
  delete process.env.CHORDV_PUBLIC_BASE_URL;
  try {
    await controller.installScript(
      { token: "chordv_install_ok" }, undefined, "$(id>/tmp/pwn).example.com", fakeResponse() as never
    );
    assert.equal(captured.length, 1);
    assert.ok(!captured[0].includes("$(id"), "header-derived shell syntax must never reach the script");
    assert.match(captured[0], /未配置有效的公网访问地址/);
    assert.equal(spawnSync("bash", ["-n"], { input: captured[0], encoding: "utf8" }).status, 0);

    // A legitimate Host header still renders a working script, quoted safely.
    await controller.installScript(
      { token: "chordv_install_ok" }, "https, http", "v.example.com", fakeResponse() as never
    );
    assert.ok(captured[1].includes("API_BASE='https://v.example.com/api'"), captured[1].slice(0, 200));
    assert.equal(spawnSync("bash", ["-n"], { input: captured[1], encoding: "utf8" }).status, 0);

    // A configured origin wins, and an invalid configured origin is refused too.
    process.env.CHORDV_PUBLIC_BASE_URL = "https://cfg.example.com/";
    await controller.installScript({ token: "chordv_install_ok" }, undefined, "v.example.com", fakeResponse() as never);
    assert.ok(captured[2].includes("API_BASE='https://cfg.example.com/api'"));
    process.env.CHORDV_PUBLIC_BASE_URL = "https://cfg.example.com/$(id)";
    await controller.installScript({ token: "chordv_install_ok" }, undefined, "v.example.com", fakeResponse() as never);
    assert.match(captured[3], /未配置有效的公网访问地址/);
  } finally {
    if (previousBase === undefined) delete process.env.CHORDV_PUBLIC_BASE_URL;
    else process.env.CHORDV_PUBLIC_BASE_URL = previousBase;
  }
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
