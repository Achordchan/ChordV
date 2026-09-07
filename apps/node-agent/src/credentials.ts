import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { generateAgentToken, requestRegister } from './api-client.js';
import { AGENT_VERSION } from './agent-version.js';
import type { AgentCredentials, AgentConfig } from './config.js';

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** Both retry and final credentials use the same owner-only, durable write path. */
function writeSecret(file: string, value: unknown): void {
  file = resolve(file);
  const directory = dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value) + '\n');
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
    // Sync the whole path on every attempt. A parent created by an earlier failed
    // attempt may already be visible without its directory entry being durable.
    let current = directory;
    while (true) {
      syncDirectory(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* may already have been renamed */ }
    throw error;
  }
}

function readSecret(file: string): Record<string, unknown> | null {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error('Agent 凭据文件损坏，请恢复原凭据后重试'); }
}
/**
 * Binds persisted state to the registration token that produced it. Only the
 * hash is stored: the saved file must never become a second copy of the
 * one-time token.
 */
const registerTokenFingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** No registration request may run before its replay credential is safely persisted. */
export async function resolveCredentials(config: AgentConfig, register = requestRegister): Promise<AgentCredentials> {
  // A complete operator-managed tuple is an explicit override, including rotation.
  // Do not read or overwrite an unrelated saved identity while this source is set.
  const explicit = [config.agentId, config.nodeId, config.token];
  if (explicit.some(nonempty)) {
    if (!explicit.every(nonempty) || config.registerToken) throw new Error('环境凭据必须完整，且不能与注册令牌同时配置');
    return { agentId: config.agentId, nodeId: config.nodeId, token: config.token };
  }
  const fingerprint = config.registerToken ? registerTokenFingerprint(config.registerToken) : '';
  let saved = readSecret(config.credentialsPath);
  if (saved) {
    if (!nonempty(saved.agentId) || !nonempty(saved.nodeId) || !nonempty(saved.token)) throw new Error('Agent 凭据文件字段不完整');
    // A registration token that did not produce this identity means the host is
    // being re-onboarded (node deleted/recreated, VPS repurposed) on top of a
    // stale identity. Silently keeping the old one leaves the new node pending
    // forever while retrying a possibly revoked credential, so stop and require
    // an explicit reset instead of guessing which identity the operator meant.
    if (fingerprint && saved.registerTokenFingerprint !== fingerprint) {
      if (!config.resetIdentity) {
        throw new Error(
          `本机已存在其他注册令牌签发的 Agent 身份（${saved.agentId} / 节点 ${saved.nodeId}），拒绝用新的注册令牌静默复用。` +
            `若确认要把本机重新接入为新节点：先在后台撤销旧节点的 Agent 凭据，再以 CHORDV_AGENT_RESET_IDENTITY=1 启动一次（旧凭据会被改名保留为 ${config.credentialsPath}.replaced.<时间戳>），` +
            `或停止服务后删除 ${config.credentialsPath} 与 ${config.credentialsPath}.pending 后重启`
        );
      }
      const archived = `${config.credentialsPath}.replaced.${Date.now()}`;
      fs.renameSync(config.credentialsPath, archived);
      syncDirectory(dirname(resolve(config.credentialsPath)));
      console.warn(`[node-agent] 已按 CHORDV_AGENT_RESET_IDENTITY 归档旧身份至 ${archived}，将以新注册令牌重新接入`);
      saved = null;
    }
  }
  if (saved) {
    return { agentId: saved.agentId as string, nodeId: saved.nodeId as string, token: saved.token as string };
  }
  if (config.registerToken) {
    const pendingFile = `${config.credentialsPath}.pending`;
    const pendingRaw = readSecret(pendingFile);
    if (pendingRaw && (typeof pendingRaw.agentToken !== 'string' || !/^chordv_agent_[A-Za-z0-9_-]{43,128}$/.test(pendingRaw.agentToken))) {
      throw new Error('Agent 待注册凭据文件损坏，请恢复原凭据后重试');
    }
    // Never carry a client secret across registration tokens: replaying it for
    // another node is exactly the cross-node credential reuse the control plane
    // rejects. Only a retry of the SAME token may reuse the persisted secret.
    const pending = pendingRaw && pendingRaw.registerTokenFingerprint === fingerprint ? pendingRaw : null;
    const agentToken = pending ? pending.agentToken as string : generateAgentToken();
    // Re-sync on every attempt: an earlier rename may be visible after a directory
    // sync error. Reusing the bytes alone is not proof of successful persistence.
    writeSecret(pendingFile, { agentToken, registerTokenFingerprint: fingerprint });
    console.log('[node-agent] 待注册凭据已持久化，正在接入…');
    const response = await register(config.apiBaseUrl, {
      registerToken: config.registerToken, agentToken, hostname: hostname(),
      arch: process.platform === 'linux' && process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64',
      agentVersion: AGENT_VERSION, bootId: randomUUID(),
    });
    if (!response.accepted || !nonempty(response.agentId) || !nonempty(response.nodeId)) throw new Error('注册接口返回的 Agent 身份无效');
    const credentials = { agentId: response.agentId, nodeId: response.nodeId, token: agentToken };
    writeSecret(config.credentialsPath, { ...credentials, registerTokenFingerprint: fingerprint });
    console.log(`[node-agent] 注册成功 agent=${response.agentId} node=${response.nodeId}（凭据已持久化）`);
    return credentials;
  }
  throw new Error('无可用凭据：本地凭据文件缺失且未提供 CHORDV_REGISTER_TOKEN');
}
