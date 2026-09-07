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

/**
 * Moves the previous node's identity AND its runtime state aside under one
 * timestamp. The sqlite database must travel with the identity: it holds the
 * old node's desired users, command history and unsettled usage batches, and
 * reusing it under new credentials would mix two nodes' state and could replay
 * the old node's work. Nothing is deleted — the archived files stay for
 * recovery/reconciliation. Runs before the store is opened, with the service
 * stopped (the installer restarts it), so no descriptor is live here.
 */
function archiveIdentity(config: AgentConfig): string[] {
  const stamp = Date.now();
  const archived: string[] = [];
  const directories = new Set<string>();
  const candidates = [
    config.credentialsPath,
    `${config.credentialsPath}.pending`,
    config.databasePath,
    `${config.databasePath}-wal`,
    `${config.databasePath}-shm`,
  ];
  for (const file of candidates) {
    const source = resolve(file);
    if (!fs.existsSync(source)) continue;
    const target = `${source}.replaced.${stamp}`;
    fs.renameSync(source, target);
    archived.push(target);
    directories.add(dirname(source));
  }
  for (const directory of directories) syncDirectory(directory);
  return archived;
}

/**
 * READ-ONLY credential lookup for `--health`. Health checks are normally run by
 * an operator as root, so this path must never register, generate or persist
 * anything: a root-owned credential file (or sqlite WAL) inside the service's
 * data directory would be unreadable/unwritable for the chordv-agent service
 * and break its next start, and a second generated secret would race the
 * service's own registration. Returns null when the host is not registered yet
 * and throws when the saved identity cannot be used as-is.
 */
export function readExistingCredentials(config: AgentConfig): AgentCredentials | null {
  const explicit = [config.agentId, config.nodeId, config.token];
  if (explicit.some(nonempty)) {
    if (!explicit.every(nonempty)) throw new Error('环境凭据必须完整，且不能与注册令牌同时配置');
    return { agentId: config.agentId, nodeId: config.nodeId, token: config.token };
  }
  const saved = readSecret(config.credentialsPath);
  if (!saved) return null;
  if (!nonempty(saved.agentId) || !nonempty(saved.nodeId) || !nonempty(saved.token)) throw new Error('Agent 凭据文件字段不完整');
  if (config.registerToken && saved.registerTokenFingerprint !== registerTokenFingerprint(config.registerToken)) {
    throw new Error('本机保存的 Agent 身份与当前注册令牌不匹配，服务无法启动，请先完成迁移或重置');
  }
  return { agentId: saved.agentId, nodeId: saved.nodeId, token: saved.token };
}

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
      const archived = archiveIdentity(config);
      console.warn(
        `[node-agent] 已按 CHORDV_AGENT_RESET_IDENTITY 归档旧身份及运行状态（${archived.join('、')}），将以新注册令牌重新接入`
      );
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
