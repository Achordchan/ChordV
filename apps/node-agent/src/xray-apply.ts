/**
 * The ROOT half of inbound deployment. The agent runs unprivileged and may
 * never write Xray's config: this script is installed root-owned outside the
 * agent's release directory and is triggered by a systemd path unit watching
 * the agent's handoff file. The agent therefore gains exactly one power —
 * causing this fixed script to run — and never sees the Reality private key.
 *
 * It has NO imports beyond node builtins on purpose: it is copied out of the
 * release as a single file, so an import of a sibling module would resolve
 * inside the agent-writable release directory at root privilege.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_REQUEST_BYTES = 8 * 1024;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export interface InboundRequest {
  requestId: string;
  /**
   * The control-plane command this request belongs to. A redelivered command
   * must not rotate keys or restart Xray a second time, and the per-execution
   * requestId cannot say that — it is new every time.
   */
  commandId: string;
  mode: 'ensure' | 'reset' | 'status';
  inboundTag: string;
  listenPort: number;
  dest: string;
  serverNames: string[];
  flow: string;
  fingerprint: string;
  spiderX: string;
  rotateKeys: boolean;
}

export interface RealityKeys { privateKey: string; publicKey: string; shortId: string }

export interface ApplyDeps {
  confDir: string;
  stateFile: string;
  xrayBin: string;
  xrayUser: string;
  restart(): void;
  /**
   * Whether XRAY is serving the port. `systemctl restart` on a Type=simple unit
   * returns before the process binds, so "the start job succeeded" says
   * nothing — and "someone is listening" says nothing either: a port already
   * taken by nginx passes the config test, starts, and exits, with the port
   * still occupied by the squatter. Readiness must be inside the rollback
   * window and must be about Xray's own socket.
   */
  isListening(port: number): boolean;
  resolveListen(): string;
  generateKeys(): RealityKeys;
  now(): string;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 缺失或不是字符串`);
  return value.trim();
}

function requirePort(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new Error(`${label} 不是 1-65535 的端口`);
  }
  return value as number;
}

function requireHostname(value: string, label: string): string {
  if (value.length > 253 || !HOSTNAME.test(value)) throw new Error(`${label} 不是合法域名：${value}`);
  return value;
}

/**
 * Parses the agent's request from scratch. The agent is UNTRUSTED here: a
 * compromised agent that could hand root a JSON blob to merge into Xray's
 * config would own the machine (a dokodemo-door of its choosing, a rewritten
 * api inbound, a log path pointing anywhere). So nothing from the request is
 * ever copied into the config — only these validated scalars are, and the
 * inbound object itself is rendered below.
 */
export function parseRequest(raw: string): InboundRequest {
  if (raw.length > MAX_REQUEST_BYTES) throw new Error('请求文件过大');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('请求不是合法 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求格式错误');
  const value = parsed as Record<string, unknown>;
  const requestId = requireString(value.requestId, 'requestId');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new Error(`requestId 不合法：${requestId}`);
  const commandId = typeof value.commandId === 'string' ? value.commandId.trim() : '';
  if (commandId && !/^[A-Za-z0-9_:-]{1,128}$/.test(commandId)) throw new Error(`commandId 不合法：${commandId}`);
  const mode = value.mode === 'reset' ? 'reset' : value.mode === 'status' ? 'status' : 'ensure';
  if (mode === 'reset' || mode === 'status') {
    return { requestId, commandId, mode, inboundTag: '', listenPort: 0, dest: '', serverNames: [], flow: '', fingerprint: '', spiderX: '', rotateKeys: false };
  }
  const inboundTag = requireString(value.inboundTag, 'inboundTag');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(inboundTag)) throw new Error(`inboundTag 不合法：${inboundTag}`);
  const dest = requireString(value.dest, 'dest');
  const separator = dest.lastIndexOf(':');
  if (separator <= 0) throw new Error(`dest 必须是 host:port：${dest}`);
  requireHostname(dest.slice(0, separator), 'dest');
  requirePort(Number(dest.slice(separator + 1)), 'dest 端口');
  const rawNames = value.serverNames;
  if (!Array.isArray(rawNames) || rawNames.length < 1 || rawNames.length > 8) throw new Error('serverNames 必须是 1-8 个域名');
  const serverNames = rawNames.map((name) => requireHostname(requireString(name, 'serverNames'), 'serverNames'));
  const flow = typeof value.flow === 'string' ? value.flow.trim() : '';
  if (flow !== '' && flow !== 'xtls-rprx-vision') throw new Error(`flow 不支持：${flow}`);
  const fingerprint = requireString(value.fingerprint, 'fingerprint');
  if (!/^[a-z0-9]{1,16}$/.test(fingerprint)) throw new Error(`fingerprint 不合法：${fingerprint}`);
  const spiderX = requireString(value.spiderX, 'spiderX');
  if (!spiderX.startsWith('/') || spiderX.length > 64 || /[\s"'\\]/.test(spiderX)) throw new Error(`spiderX 不合法：${spiderX}`);
  return {
    requestId,
    commandId,
    mode,
    inboundTag,
    listenPort: requirePort(value.listenPort, 'listenPort'),
    dest,
    serverNames,
    flow,
    fingerprint,
    spiderX,
    rotateKeys: value.rotateKeys === true,
  };
}

/** Identity of a deployed inbound; must match the agent's own hash inputs. */
export function requestHash(request: InboundRequest): string {
  return createHash('sha256').update(JSON.stringify({
    inboundTag: request.inboundTag,
    listenPort: request.listenPort,
    dest: request.dest,
    serverNames: [...request.serverNames].sort(),
    flow: request.flow,
    fingerprint: request.fingerprint,
    spiderX: request.spiderX,
  })).digest('hex');
}

/**
 * Which address family the inbound will actually accept. A node whose public
 * address is IPv6 but whose inbound listens on 0.0.0.0 passes every tag-based
 * check and hands every client an endpoint with no listener, so this is decided
 * explicitly and reported back rather than assumed.
 */
export function resolveListenAddress(readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8')): string {
  let bindV6Only: string;
  try {
    bindV6Only = readFile('/proc/sys/net/ipv6/bindv6only').trim();
  } catch {
    return '0.0.0.0'; // no IPv6 stack on this host
  }
  if (bindV6Only !== '0') {
    throw new Error('net.ipv6.bindv6only=1 会让入站只接受 IPv6：请将其设为 0，或在无 IPv6 的主机上部署');
  }
  return '::';
}

/** Renders the inbound root will run. Built here from scratch, never copied. */
export function renderInbound(request: InboundRequest, keys: RealityKeys, listen = '0.0.0.0'): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: request.inboundTag,
        listen,
        port: request.listenPort,
        protocol: 'vless',
        // No clients: users are provisioned over the gRPC HandlerService by the
        // agent, which is the same path metering reads back.
        settings: { clients: [], decryption: 'none' },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            show: false,
            dest: request.dest,
            xver: 0,
            serverNames: request.serverNames,
            privateKey: keys.privateKey,
            shortIds: [keys.shortId],
          },
        },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      },
    ],
  };
}

export function parseX25519(output: string): { privateKey: string; publicKey: string } {
  // The labels have drifted across Xray releases (Private key / PrivateKey,
  // Public key / Password). Accept the known spellings and fail loudly on an
  // unknown one — but NEVER echo the output: it holds the private key, and this
  // error travels to the agent-readable result file and on to the control
  // plane. Report the shape of what was seen instead.
  const privateKey = /(?:private\s*key|privatekey)\s*:\s*([A-Za-z0-9_-]{43})/i.exec(output)?.[1];
  const publicKey = /(?:public\s*key|publickey|password)\s*:\s*([A-Za-z0-9_-]{43})/i.exec(output)?.[1];
  if (!privateKey || !publicKey) {
    const labels = [...output.matchAll(/^\s*([A-Za-z][A-Za-z ]{0,30}?)\s*:/gm)].map((match) => match[1].trim());
    throw new Error(
      `无法解析 xray x25519 输出（未识别的标签：${labels.join('、') || '无'}），`
        + '请确认 Xray 版本；为避免泄露私钥，此处不回显原始输出',
    );
  }
  return { privateKey, publicKey };
}

function writeFileAtomic(file: string, contents: string, mode: number, owner?: { uid: number; gid: number }): void {
  const directory = dirname(file);
  // Random, not just pid-based: a predictable temporary name in a directory an
  // attacker can write is a name they can pre-empt or replace before the rename.
  const temporary = `${file}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  try { fs.unlinkSync(temporary); } catch { /* no leftover */ }
  const descriptor = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, contents);
    if (owner) fs.fchownSync(descriptor, owner.uid, owner.gid);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  const dirDescriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(dirDescriptor); } finally { fs.closeSync(dirDescriptor); }
}

function readState(file: string): { hash: string; keys: RealityKeys; serverName: string; listen: string; listenPort: number; pending: boolean; commandId: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const keys = parsed.keys as RealityKeys | undefined;
    if (typeof parsed.hash !== 'string' || !keys?.privateKey || !keys.publicKey || !keys.shortId) return undefined;
    return {
      hash: parsed.hash,
      keys,
      serverName: typeof parsed.serverName === 'string' ? parsed.serverName : '',
      listen: typeof parsed.listen === 'string' ? parsed.listen : '',
      listenPort: typeof parsed.listenPort === 'number' ? parsed.listenPort : 0,
      // Written before the config is published and cleared after: a crash in
      // between leaves this set, and the no-op branch must then refuse.
      pending: parsed.pending === true,
      commandId: typeof parsed.commandId === 'string' ? parsed.commandId : '',
    };
  } catch { return undefined; }
}

export interface ApplyOutcome {
  /** Whether an inbound is configured right now, from durable state. */
  deployed: boolean;
  listen: string;
  changed: boolean;
  restarted: boolean;
  realityPublicKey: string;
  shortId: string;
  serverName: string;
  listenPort: number;
  xrayVersion: string;
}

export function xrayVersion(xrayBin: string): string {
  try {
    return execFileSync(xrayBin, ['version'], { encoding: 'utf8' }).split('\n')[0]?.trim() ?? '';
  } catch { return ''; }
}

/**
 * Validates the MERGED configuration, not the fragment alone: a duplicate tag,
 * a port that collides with the metering api inbound, or a broken routing rule
 * only shows up once every file in the directory is combined.
 */
function assertConfigValid(deps: ApplyDeps, candidate: string): void {
  const staging = fs.mkdtempSync(join(deps.confDir, '.candidate.'));
  try {
    for (const name of fs.readdirSync(deps.confDir)) {
      if (!name.endsWith('.json') || name === '50-inbound.json') continue;
      fs.copyFileSync(join(deps.confDir, name), join(staging, name));
    }
    fs.writeFileSync(join(staging, '50-inbound.json'), candidate, { mode: 0o600 });
    try {
      execFileSync(deps.xrayBin, ['run', '-test', '-confdir', staging], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const detail = (error as { stderr?: string; stdout?: string; message?: string });
      throw new Error(`配置校验失败：${(detail.stderr || detail.stdout || detail.message || '').trim().slice(0, 400)}`);
    }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

/**
 * Inbound tags declared by the OTHER fragments in the directory. An unreadable
 * fragment fails closed: the whole point is protecting inbounds we cannot see.
 */
export function reservedInboundTags(confDir: string): Set<string> {
  const tags = new Set<string>();
  for (const name of fs.readdirSync(confDir)) {
    if (!name.endsWith('.json') || name === '50-inbound.json') continue;
    let parsed: { inbounds?: Array<{ tag?: unknown }> };
    try {
      parsed = JSON.parse(fs.readFileSync(join(confDir, name), 'utf8')) as { inbounds?: Array<{ tag?: unknown }> };
    } catch {
      throw new Error(`配置片段 ${name} 无法解析，无法确认入站 tag 是否冲突，拒绝部署`);
    }
    for (const inbound of parsed.inbounds ?? []) if (typeof inbound.tag === 'string') tags.add(inbound.tag);
  }
  return tags;
}

export function applyRequest(request: InboundRequest, deps: ApplyDeps): ApplyOutcome {
  const target = join(deps.confDir, '50-inbound.json');
  const state = readState(deps.stateFile);
  // Only root can hand the file to the xray group; when this runs unprivileged
  // (tests, or a misconfigured unit) the file simply keeps its creator, and the
  // config test below is what decides whether it is usable at all.
  const owner = process.geteuid?.() === 0 ? { uid: 0, gid: resolveGid(deps.xrayUser) } : undefined;

  if (request.mode === 'status') {
    // Read-only: whether THIS host currently serves an inbound, from durable
    // state rather than from whatever the last request happened to answer. A
    // failed deployment that rolled back leaves a failure result behind while
    // the previous inbound is still deployed.
    return {
      deployed: Boolean(state && !state.pending && fs.existsSync(target)),
      listen: state?.listen || '',
      changed: false,
      restarted: false,
      realityPublicKey: state?.keys.publicKey ?? '',
      shortId: state?.keys.shortId ?? '',
      serverName: state?.serverName ?? '',
      listenPort: state?.listenPort ?? 0,
      xrayVersion: xrayVersion(deps.xrayBin),
    };
  }

  if (request.mode === 'reset') {
    if (!fs.existsSync(target) && !state) {
      return { deployed: false, listen: '', changed: false, restarted: false, realityPublicKey: '', shortId: '', serverName: '', listenPort: 0, xrayVersion: xrayVersion(deps.xrayBin) };
    }
    const empty = JSON.stringify({ inbounds: [] }, null, 2) + '\n';
    assertConfigValid(deps, empty);
    // Journal the reset first. Dying between publishing the empty inbound and
    // dropping the state would leave the old hash and keys next to an empty
    // config: a later ensure of that same spec would take the no-op branch and
    // never restore the inbound.
    const committed = fs.existsSync(deps.stateFile) ? fs.readFileSync(deps.stateFile, 'utf8') : undefined;
    if (state) writeFileAtomic(deps.stateFile, JSON.stringify({ ...state, pending: true }, null, 2) + '\n', 0o600);
    try {
      publishAndRestart(deps, target, empty, owner, 0);
    } catch (error) {
      // The inbound was restored, so the record of it must be restored too.
      if (committed !== undefined) writeFileAtomic(deps.stateFile, committed, 0o600);
      throw error;
    }
    try { fs.unlinkSync(deps.stateFile); } catch { /* already gone */ }
    return { deployed: false, listen: '', changed: true, restarted: true, realityPublicKey: '', shortId: '', serverName: '', listenPort: 0, xrayVersion: xrayVersion(deps.xrayBin) };
  }

  // Xray's confdir merge is BY TAG: an inbound declared here under a tag another
  // fragment already uses replaces that one. A request for `api-in` would take
  // out the metering listener the agent talks to — and the agent is untrusted,
  // so this cannot be left to its own tag check.
  const reserved = reservedInboundTags(deps.confDir);
  if (reserved.has(request.inboundTag)) {
    throw new Error(`入站 tag ${request.inboundTag} 已被其它配置片段占用，拒绝部署（它会顶掉那个入站）`);
  }

  const hash = requestHash(request);
  // A redelivered command must not rotate again: the agent may have crashed
  // before recording completion, and a second rotation would invalidate every
  // subscription issued from the first one.
  // Both no-op branches also require Xray to be SERVING. A stopped service (or
  // one that exhausted systemd's restart limit) still has its config file and
  // its recorded state, and answering "nothing to do" there would leave the
  // node down with every retry repeating the same answer.
  const serving = (port: number) => port > 0 && deps.isListening(port);
  /**
   * The file on disk must be exactly what the recorded state implies. An
   * operator can restore an older 50-inbound.json (same port, different Reality
   * key) without restoring inbound-state.json: existence and a listening port
   * would both still look fine, and the helper would report a public key Xray
   * is no longer using — connection parameters that cannot work.
   */
  const configMatches = (recorded: { keys: RealityKeys; listen: string; listenPort: number }) => {
    try {
      const expected = JSON.stringify(
        renderInbound({ ...request, listenPort: recorded.listenPort || request.listenPort }, recorded.keys, recorded.listen || '0.0.0.0'),
        null,
        2,
      ) + '\n';
      return fs.readFileSync(target, 'utf8') === expected;
    } catch { return false; }
  };
  if (request.commandId && state?.commandId === request.commandId && !state.pending && configMatches(state)
      && serving(state.listenPort || request.listenPort)) {
    return {
      deployed: true,
      listen: state.listen || '0.0.0.0',
      changed: false,
      restarted: false,
      realityPublicKey: state.keys.publicKey,
      shortId: state.keys.shortId,
      serverName: state.serverName || request.serverNames[0],
      listenPort: state.listenPort || request.listenPort,
      xrayVersion: xrayVersion(deps.xrayBin),
    };
  }
  // A redelivered rotation must not rotate twice — even when the shortcut above
  // was refused because Xray is not serving. That command's rotation already
  // happened; repeating it would invalidate credentials issued from the first.
  const sameCommand = Boolean(request.commandId) && state?.commandId === request.commandId;
  const reusable = state && (!request.rotateKeys || sameCommand) ? state.keys : undefined;
  // `pending` means the recorded state may not describe what Xray is serving
  // (the process died between publishing the config and committing the state),
  // so the shortcut would answer with a port that is no longer deployed.
  if (state?.hash === hash && !state.pending && !request.rotateKeys && configMatches(state)
      && serving(state.listenPort || request.listenPort)) {
    // Nothing to do — and doing it anyway would restart Xray, dropping every
    // live connection and every gRPC-provisioned user for no reason.
    return {
      deployed: true,
      listen: state.listen || '0.0.0.0',
      changed: false,
      restarted: false,
      realityPublicKey: state.keys.publicKey,
      shortId: state.keys.shortId,
      serverName: state.serverName || request.serverNames[0],
      listenPort: state.listenPort || request.listenPort,
      xrayVersion: xrayVersion(deps.xrayBin),
    };
  }

  // Keys are preserved across a port/SNI change on purpose: rotating them would
  // silently invalidate every subscription already handed to a user. Only an
  // explicit rotateKeys asks for that.
  const keys = reusable ?? deps.generateKeys();
  const serverName = request.serverNames[0];
  const listen = deps.resolveListen();
  const rendered = JSON.stringify(renderInbound(request, keys, listen), null, 2) + '\n';
  assertConfigValid(deps, rendered);
  // Journal BEFORE publishing. If the helper dies between publishing the config
  // and recording it, Xray serves the new inbound while the state file still
  // describes the old one — and re-issuing the OLD spec would then take the
  // no-op branch and report a port nothing serves. The pending record makes
  // that window recoverable: it is never answered with, only re-applied from.
  const record = { hash, keys, serverName, listen, listenPort: request.listenPort, commandId: request.commandId, appliedAt: deps.now() };
  const committed = fs.existsSync(deps.stateFile) ? fs.readFileSync(deps.stateFile, 'utf8') : undefined;
  writeFileAtomic(deps.stateFile, JSON.stringify({ ...record, pending: true }, null, 2) + '\n', 0o600);
  try {
    publishAndRestart(deps, target, rendered, owner, request.listenPort);
  } catch (error) {
    // The configuration was rolled back, so the recorded keys must roll back
    // too: a failed rotation that left the new keys behind would be reused by
    // the next deployment and silently invalidate every issued subscription.
    if (committed === undefined) { try { fs.unlinkSync(deps.stateFile); } catch { /* nothing to remove */ } }
    else writeFileAtomic(deps.stateFile, committed, 0o600);
    throw error;
  }
  writeFileAtomic(deps.stateFile, JSON.stringify({ ...record, pending: false }, null, 2) + '\n', 0o600);
  return {
    deployed: true,
    listen,
    changed: true,
    restarted: true,
    realityPublicKey: keys.publicKey,
    shortId: keys.shortId,
    serverName,
    listenPort: request.listenPort,
    xrayVersion: xrayVersion(deps.xrayBin),
  };
}

/**
 * Publishes atomically, then keeps the rollback window open until Xray is
 * actually serving. The previous configuration is restored through the same
 * write path — a plain copy would come back root-owned and unreadable by the
 * xray service, turning one failure into two.
 */
function publishAndRestart(deps: ApplyDeps, target: string, contents: string, owner: { uid: number; gid: number } | undefined, port: number): void {
  const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
  writeFileAtomic(target, contents, 0o640, owner);
  const rollback = (reason: string): never => {
    if (previous === undefined) { try { fs.unlinkSync(target); } catch { /* nothing to remove */ } }
    else writeFileAtomic(target, previous, 0o640, owner);
    try { deps.restart(); } catch { /* report the original failure */ }
    throw new Error(`${reason}，已回滚上一份配置`);
  };
  try {
    deps.restart();
  } catch (error) {
    rollback(`重启 Xray 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  // `systemctl restart` on a Type=simple unit returns before the process binds,
  // so a taken port looks like a successful start and then exits.
  if (port > 0 && !deps.isListening(port)) rollback(`Xray 未能在端口 ${port} 上开始监听`);
}

function resolveGid(user: string): number {
  try {
    const line = execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim();
    const gid = Number(line);
    return Number.isInteger(gid) ? gid : 0;
  } catch { return 0; }
}

/**
 * Opens the agent's request ONCE and validates that descriptor, then reads a
 * bounded amount from it. Checking a path and then reading it again is two
 * different files as far as an agent that owns the directory is concerned: it
 * can swap in a symlink or a FIFO in between, and an unbounded read of a file
 * it controls is a memory-exhaustion lever against a root process.
 */
export function readRequest(file: string, expectedUid: number, limit = MAX_REQUEST_BYTES): string {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('请求文件不是普通文件');
    if (stat.uid !== expectedUid) throw new Error(`请求文件属主必须是 uid ${expectedUid}，实际 ${stat.uid}`);
    if ((stat.mode & 0o022) !== 0) throw new Error('请求文件不得被组/其他用户写入');
    if (stat.size > limit) throw new Error('请求文件过大');
    const buffer = Buffer.alloc(limit + 1);
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (read > limit) throw new Error('请求文件过大');
    return buffer.subarray(0, read).toString('utf8');
  } finally { fs.closeSync(descriptor); }
}

function resolveUid(user: string): number {
  const line = execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim();
  const uid = Number(line);
  if (!Number.isInteger(uid)) throw new Error(`无法解析用户 ${user} 的 uid`);
  return uid;
}

/**
 * Reads the kernel's socket tables directly: no ss/netstat dependency, and it
 * sees the listener regardless of which address family or interface it bound.
 */
export interface ProcReaders {
  readFile(file: string): string;
  readDir(directory: string): string[];
  readLink(file: string): string;
}

const defaultProcReaders: ProcReaders = {
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  readDir: (directory) => fs.readdirSync(directory),
  readLink: (file) => fs.readlinkSync(file),
};

/** Socket inodes listening on `port`, from both the IPv4 and IPv6 tables. */
export function listeningSocketInodes(port: number, readers: ProcReaders = defaultProcReaders): string[] {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes: string[] = [];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let contents: string;
    try { contents = readers.readFile(table); } catch { continue; }
    for (const line of contents.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/);
      // st === 0A is TCP_LISTEN; column 9 is the socket inode.
      if (columns.length > 9 && columns[1]?.endsWith(`:${hex}`) && columns[3] === '0A') inodes.push(columns[9]);
    }
  }
  return inodes;
}

/**
 * True only when XRAY holds the listening socket. "Something is listening" is
 * not the question: if nginx already owns the port, Xray fails to bind while the
 * probe still sees a listener, and the helper would commit a configuration that
 * never took effect — leaving an existing node offline with no rollback.
 */
export function isPortOwnedBy(port: number, binary: string, readers: ProcReaders = defaultProcReaders): boolean {
  const inodes = new Set(listeningSocketInodes(port, readers).map((inode) => `socket:[${inode}]`));
  if (inodes.size === 0) return false;
  let processes: string[];
  try { processes = readers.readDir('/proc'); } catch { return false; }
  for (const entry of processes) {
    if (!/^\d+$/.test(entry)) continue;
    let descriptors: string[];
    try { descriptors = readers.readDir(`/proc/${entry}/fd`); } catch { continue; }
    const owns = descriptors.some((descriptor) => {
      try { return inodes.has(readers.readLink(`/proc/${entry}/fd/${descriptor}`)); } catch { return false; }
    });
    if (!owns) continue;
    let cmdline: string;
    try { cmdline = readers.readFile(`/proc/${entry}/cmdline`); } catch { continue; }
    if (cmdline.split('\0')[0] === binary) return true;
  }
  return false;
}

function waitForListener(port: number, binary: string, attempts = 20, delayMs = 250): boolean {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (isPortOwnedBy(port, binary)) return true;
    // Sync sleep: this helper is a one-shot root script, and blocking here is
    // what keeps the rollback window open until the answer is known.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
  return isPortOwnedBy(port, binary);
}

function main(): void {
  const requestDir = process.env.CHORDV_XRAY_REQUEST_DIR?.trim() || '/var/lib/chordv-node-agent/xray';
  // Results are published into a ROOT-owned directory whose ancestors are also
  // root-owned. Writing them back into the agent's own directory would let a
  // compromised agent replace that directory with a symlink, or swap root's
  // temporary file before the rename — turning result publication into
  // "install arbitrary JSON wherever the symlink points", including Xray's
  // confdir. The agent only ever reads from here.
  const resultDir = process.env.CHORDV_XRAY_RESULT_DIR?.trim() || '/var/lib/chordv-xray';
  const confDir = process.env.CHORDV_XRAY_CONF_DIR?.trim() || '/etc/chordv/xray/conf.d';
  const stateFile = process.env.CHORDV_XRAY_STATE_FILE?.trim() || '/etc/chordv/xray/inbound-state.json';
  const xrayBin = process.env.CHORDV_XRAY_BIN?.trim() || '/usr/local/bin/xray';
  const agentUser = process.env.CHORDV_AGENT_USER?.trim() || 'chordv-agent';
  const xrayUser = process.env.CHORDV_XRAY_USER?.trim() || 'chordv-xray';
  const restartCommand = process.env.CHORDV_XRAY_RESTART_CMD?.trim() || 'systemctl restart xray';
  const deps: ApplyDeps = {
    confDir,
    stateFile,
    xrayBin,
    xrayUser,
    restart: () => {
      const [command, ...args] = restartCommand.split(/\s+/);
      execFileSync(command, args, { stdio: 'pipe' });
    },
    isListening: (port) => waitForListener(port, xrayBin),
    resolveListen: () => resolveListenAddress(),
    generateKeys: () => ({
      ...parseX25519(execFileSync(xrayBin, ['x25519'], { encoding: 'utf8' })),
      shortId: randomBytes(8).toString('hex'),
    }),
    now: () => new Date().toISOString(),
  };

  const pending = join(requestDir, 'pending.json');
  const claimed = join(requestDir, 'processing.json');
  const result = join(resultDir, 'result.json');
  const agentUid = resolveUid(agentUser);
  // A path unit does not re-trigger while its service is running, so two quick
  // requests can collapse into one run: keep draining until nothing is left.
  for (let round = 0; round < 8; round++) {
    if (!fs.existsSync(pending)) return;
    // CLAIM the request by renaming it. An apply can outlast the agent's own
    // timeout, and the agent may then write a fresh pending.json — deleting
    // that path afterwards would silently drop a command nobody ever ran.
    try { fs.renameSync(pending, claimed); } catch { return; }
    let requestId = 'unknown';
    try {
      const request = parseRequest(readRequest(claimed, agentUid));
      requestId = request.requestId;
      const outcome = applyRequest(request, deps);
      writeFileAtomic(result, JSON.stringify({ requestId, ok: true, ...outcome }) + '\n', 0o644);
    } catch (error) {
      writeFileAtomic(result, JSON.stringify({
        requestId,
        ok: false,
        stage: 'apply',
        error: error instanceof Error ? error.message : String(error),
      }) + '\n', 0o644);
    } finally {
      try { fs.unlinkSync(claimed); } catch { /* already gone */ }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
