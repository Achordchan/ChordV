import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
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
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** No registration request may run before its replay credential is safely persisted. */
export async function resolveCredentials(config: AgentConfig, register = requestRegister): Promise<AgentCredentials> {
  const saved = readSecret(config.credentialsPath);
  if (saved) {
    if (!nonempty(saved.agentId) || !nonempty(saved.nodeId) || !nonempty(saved.token)) throw new Error('Agent 凭据文件字段不完整');
    return { agentId: saved.agentId, nodeId: saved.nodeId, token: saved.token };
  }
  if (config.registerToken) {
    const pendingFile = `${config.credentialsPath}.pending`;
    const pending = readSecret(pendingFile);
    if (pending && (typeof pending.agentToken !== 'string' || !/^chordv_agent_[A-Za-z0-9_-]{43,128}$/.test(pending.agentToken))) {
      throw new Error('Agent 待注册凭据文件损坏，请恢复原凭据后重试');
    }
    const agentToken = pending ? pending.agentToken as string : generateAgentToken();
    // Re-sync on every attempt: an earlier rename may be visible after a directory
    // sync error. Reusing the bytes alone is not proof of successful persistence.
    writeSecret(pendingFile, { agentToken });
    console.log('[node-agent] 待注册凭据已持久化，正在接入…');
    const response = await register(config.apiBaseUrl, {
      registerToken: config.registerToken, agentToken, hostname: hostname(),
      arch: process.platform === 'linux' && process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64',
      agentVersion: AGENT_VERSION, bootId: randomUUID(),
    });
    if (!response.accepted || !nonempty(response.agentId) || !nonempty(response.nodeId)) throw new Error('注册接口返回的 Agent 身份无效');
    const credentials = { agentId: response.agentId, nodeId: response.nodeId, token: agentToken };
    writeSecret(config.credentialsPath, credentials);
    console.log(`[node-agent] 注册成功 agent=${response.agentId} node=${response.nodeId}（凭据已持久化）`);
    return credentials;
  }
  if (config.agentId && config.nodeId && config.token) return { agentId: config.agentId, nodeId: config.nodeId, token: config.token };
  throw new Error('无可用凭据：本地凭据文件缺失且未提供 CHORDV_REGISTER_TOKEN');
}
