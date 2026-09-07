import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { InboundSpec } from './types.js';
import { writeSecretDurable } from './durable-write.js';

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const MAX_RESULT_BYTES = 16 * 1024;

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`入站参数 ${key} 缺失或不是字符串`);
  return value.trim();
}

function hostname(value: string, label: string): string {
  if (!value || value.length > 253 || !HOSTNAME.test(value)) throw new Error(`入站参数 ${label} 不是合法域名：${value}`);
  return value;
}

function port(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new Error(`入站参数 ${label} 不是 1-65535 的端口`);
  }
  return value as number;
}

/**
 * Validates the control plane's inbound spec before anything is written for the
 * root helper to read. The helper validates again from scratch — it must never
 * trust this process — but rejecting here turns a malformed command into a
 * clear failed command result instead of a helper-side error to dig for.
 */
export function parseInboundSpec(payload: Record<string, unknown>, expectedTag: string): InboundSpec {
  const inboundTag = text(payload, 'inboundTag');
  // Metering reads counters from exactly one tag (XRAY_INBOUND_TAG), so an
  // inbound deployed under a different tag would be live but never billed.
  // Refuse rather than silently split the two.
  if (inboundTag !== expectedTag) {
    throw new Error(`入站 tag ${inboundTag} 与本机计量使用的 ${expectedTag} 不一致，拒绝部署`);
  }
  const destination = text(payload, 'dest');
  const separator = destination.lastIndexOf(':');
  if (separator <= 0) throw new Error(`入站参数 dest 必须是 host:port：${destination}`);
  hostname(destination.slice(0, separator), 'dest');
  port(Number(destination.slice(separator + 1)), 'dest 端口');

  const rawNames = payload.serverNames;
  if (!Array.isArray(rawNames) || rawNames.length < 1 || rawNames.length > 8) {
    throw new Error('入站参数 serverNames 必须是 1-8 个域名');
  }
  const serverNames = rawNames.map((name) => hostname(typeof name === 'string' ? name.trim() : '', 'serverNames'));

  const flow = text(payload, 'flow');
  if (flow !== '' && flow !== 'xtls-rprx-vision') throw new Error(`入站参数 flow 不支持：${flow}`);
  const fingerprint = text(payload, 'fingerprint');
  if (!/^[a-z0-9]{1,16}$/.test(fingerprint)) throw new Error(`入站参数 fingerprint 不合法：${fingerprint}`);
  const spiderX = text(payload, 'spiderX');
  if (!spiderX.startsWith('/') || spiderX.length > 64 || /[\s"'\\]/.test(spiderX)) {
    throw new Error(`入站参数 spiderX 不合法：${spiderX}`);
  }

  return {
    inboundTag,
    listenPort: port(payload.listenPort, 'listenPort'),
    dest: destination,
    serverNames,
    flow: flow as InboundSpec['flow'],
    fingerprint,
    spiderX,
    rotateKeys: payload.rotateKeys === true,
  };
}

/**
 * Identity of a deployed inbound. `rotateKeys` is deliberately excluded: it is
 * an action, not part of what is deployed, and including it would make every
 * repeat of a rotation command look like a different inbound forever.
 */
export function inboundSpecHash(spec: InboundSpec): string {
  const identity = {
    inboundTag: spec.inboundTag,
    listenPort: spec.listenPort,
    dest: spec.dest,
    serverNames: [...spec.serverNames].sort(),
    flow: spec.flow,
    fingerprint: spec.fingerprint,
    spiderX: spec.spiderX,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export interface HelperResult {
  requestId: string;
  ok: boolean;
  changed: boolean;
  restarted: boolean;
  realityPublicKey: string;
  shortId: string;
  serverName: string;
  listenPort: number;
  xrayVersion: string;
}

export interface InboundApplier {
  apply(spec: InboundSpec, requestId: string): Promise<HelperResult>;
  reset(requestId: string): Promise<HelperResult>;
}

function parseHelperResult(raw: string, requestId: string): HelperResult | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Xray 配置助手返回的结果不是合法 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Xray 配置助手返回的结果格式错误');
  const value = parsed as Record<string, unknown>;
  // A result left over from an earlier request is not an answer to this one.
  if (value.requestId !== requestId) return null;
  if (value.ok !== true) {
    const stage = typeof value.stage === 'string' ? value.stage : 'unknown';
    const error = typeof value.error === 'string' ? value.error : '未提供原因';
    throw new Error(`Xray 入站部署失败（阶段 ${stage}）：${error}`);
  }
  const publicKey = typeof value.realityPublicKey === 'string' ? value.realityPublicKey : '';
  const shortId = typeof value.shortId === 'string' ? value.shortId : '';
  const serverName = typeof value.serverName === 'string' ? value.serverName : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey)) throw new Error('Xray 配置助手返回的 Reality 公钥格式错误');
  if (!/^(?:[0-9a-f]{2}){1,8}$/.test(shortId)) throw new Error('Xray 配置助手返回的 shortId 格式错误');
  if (!serverName) throw new Error('Xray 配置助手未返回 serverName');
  if (!Number.isInteger(value.listenPort)) throw new Error('Xray 配置助手未返回有效端口');
  return {
    requestId,
    ok: true,
    changed: value.changed === true,
    restarted: value.restarted === true,
    realityPublicKey: publicKey,
    shortId,
    serverName,
    listenPort: value.listenPort as number,
    xrayVersion: typeof value.xrayVersion === 'string' ? value.xrayVersion : '',
  };
}

/**
 * Request/response over the agent-owned directory: the agent writes
 * `pending.json`, a systemd path unit runs the root helper, the helper writes
 * `result.json`. The agent gains no privilege of its own — it can only cause
 * one fixed root-owned script to run — and never sees the Reality private key,
 * which stays in root-owned files it cannot read.
 */
export class FileInboundApplier implements InboundApplier {
  constructor(
    private readonly directory: string,
    private readonly timeoutMs = 120_000,
    private readonly pollIntervalMs = 250,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  ) {}

  apply(spec: InboundSpec, requestId: string): Promise<HelperResult> {
    return this.request({ requestId, mode: 'ensure', ...spec });
  }

  /**
   * Publishes an EMPTY inbound. Used when this host carries a configured
   * inbound belonging to an identity this agent no longer has: serving a
   * stranger's node with its keys is worse than serving nothing.
   */
  reset(requestId: string): Promise<HelperResult> {
    return this.request({ requestId, mode: 'reset' });
  }

  private async request(payload: Record<string, unknown>): Promise<HelperResult> {
    const requestId = payload.requestId as string;
    writeSecretDurable(join(this.directory, 'pending.json'), payload);
    const deadline = Date.now() + this.timeoutMs;
    const resultPath = join(this.directory, 'result.json');
    while (Date.now() < deadline) {
      await this.sleep(this.pollIntervalMs);
      let raw: string;
      try {
        const stat = fs.statSync(resultPath);
        if (!stat.isFile()) throw new Error('Xray 配置助手的结果文件不是普通文件');
        if (stat.size > MAX_RESULT_BYTES) throw new Error('Xray 配置助手返回的结果过大');
        raw = fs.readFileSync(resultPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const result = parseHelperResult(raw, requestId);
      if (result) return result;
    }
    throw new Error(`等待 Xray 配置助手超时（${Math.round(this.timeoutMs / 1000)} 秒），请检查 chordv-xray-apply 服务`);
  }
}
