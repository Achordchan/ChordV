import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { credentials, loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { fetch as undiciFetch } from "undici";
import type { EdgeSessionCloseInputDto, EdgeSessionOpenInputDto, EdgeTrafficReportInputDto } from "@chordv/shared";

loadEnvFiles();

const API_BASE_URL = normalizeApiBaseUrl(process.env.CHORDV_API_BASE_URL?.trim() || "http://127.0.0.1:3000/api");
const EDGE_INTERNAL_PORT = Number(process.env.CHORDV_EDGE_INTERNAL_PORT ?? 3011);
const EDGE_INTERNAL_TOKEN = process.env.CHORDV_EDGE_INTERNAL_TOKEN?.trim() || "chordv-edge-internal";
const EDGE_REQUEST_TIMEOUT_MS = Number(process.env.CHORDV_EDGE_REQUEST_TIMEOUT_MS ?? 15000);
const EDGE_REPORT_INTERVAL_SECONDS = Number(process.env.CHORDV_EDGE_REPORT_INTERVAL_SECONDS ?? 30);
const EDGE_LISTEN_HOST = process.env.CHORDV_EDGE_LISTEN_HOST?.trim() || "0.0.0.0";
const EDGE_LISTEN_PORT = Number(process.env.CHORDV_EDGE_LISTEN_PORT ?? 8443);
const EDGE_SERVER_NAME = process.env.CHORDV_EDGE_SERVER_NAME?.trim() || "edge.chordv.app";
const EDGE_REALITY_DEST = process.env.CHORDV_EDGE_REALITY_DEST?.trim() || "www.microsoft.com:443";
const EDGE_FLOW = process.env.CHORDV_EDGE_PUBLIC_FLOW?.trim() || "xtls-rprx-vision";
const EDGE_XRAY_API_PORT = Number(process.env.CHORDV_EDGE_XRAY_API_PORT ?? 11085);
const EDGE_XRAY_STATS_PATTERN = process.env.CHORDV_EDGE_XRAY_STATS_PATTERN?.trim() || "user>>>";
const RUNTIME_ROOT = path.resolve(__dirname, "..", ".runtime");
const CONFIG_PATH = path.join(RUNTIME_ROOT, "edge-gateway.json");
const LOG_PATH = path.join(RUNTIME_ROOT, "edge-gateway.log");
const REALITY_STATE_PATH = path.join(RUNTIME_ROOT, "reality.json");

const protoRoot = resolveProtoRoot();
const statsProtoPath = resolveProtoPath("stats.proto");

const grpcPackageDefinition = loadSync([statsProtoPath], {
  keepCase: true,
  longs: String,
  defaults: true,
  includeDirs: [protoRoot]
});
const grpcLoaded = loadPackageDefinition(grpcPackageDefinition) as unknown as GrpcRoot;
const statsClient = new grpcLoaded.xray.app.stats.command.StatsService(
  `127.0.0.1:${EDGE_XRAY_API_PORT}`,
  credentials.createInsecure()
);

const sessions = new Map<string, RelaySession>();
const warningTimestamps = new Map<string, number>();
let xrayChild: ChildProcessByStdio<null, Readable, Readable> | null = null;
let operationQueue = Promise.resolve();
let xrayBinaryPath: string | null = null;
let edgeRealityPrivateKey = process.env.CHORDV_EDGE_REALITY_PRIVATE_KEY?.trim() || "";
let edgeRealityPublicKey = process.env.CHORDV_EDGE_REALITY_PUBLIC_KEY?.trim() || "";
let edgeRealityShortId = process.env.CHORDV_EDGE_REALITY_SHORT_ID?.trim() || "";

void bootstrap();

async function bootstrap() {
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  xrayBinaryPath = ensureXrayBinary();
  const realityState = ensureRealityState(xrayBinaryPath);
  edgeRealityPrivateKey = realityState.privateKey;
  edgeRealityPublicKey = realityState.publicKey;
  edgeRealityShortId = realityState.shortId;
  await startInternalServer();
  setInterval(() => {
    void enqueue(async () => {
      try {
        await reportTraffic();
      } catch (error) {
        warnThrottled("report-traffic", `上报中心计费样本失败: ${readError(error)}`);
      }
    });
  }, Math.max(10, EDGE_REPORT_INTERVAL_SECONDS) * 1000);
  console.info(`[edge-gateway] 已启动 internal=${EDGE_INTERNAL_PORT} public=${EDGE_LISTEN_HOST}:${EDGE_LISTEN_PORT}`);
}

function startInternalServer() {
  return new Promise<void>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      void handleRequest(request, response);
    });

    server.once("error", (error) => {
      reject(error);
    });
    server.listen(EDGE_INTERNAL_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  if (!isAuthorized(request.headers.authorization)) {
    writeJson(response, 401, { message: "缺少访问令牌" });
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, {
      ok: true,
      sessions: sessions.size,
      xrayRunning: Boolean(xrayChild && !xrayChild.killed)
    });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 404, { message: "未找到接口" });
    return;
  }

  try {
    const body = await readJson(request);
    if (request.url === "/internal/sessions/open") {
      await enqueue(async () => {
        await upsertSession(body as EdgeSessionOpenInputDto);
      });
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.url === "/internal/sessions/close") {
      await enqueue(async () => {
        await removeSession(body as EdgeSessionCloseInputDto);
      });
      writeJson(response, 200, { ok: true });
      return;
    }
    writeJson(response, 404, { message: "未找到接口" });
  } catch (error) {
    writeJson(response, 500, { message: readError(error) });
  }
}

function isAuthorized(authorization?: string) {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  return Boolean(token && token === EDGE_INTERNAL_TOKEN);
}

async function upsertSession(input: EdgeSessionOpenInputDto) {
  const current = sessions.get(input.leaseId);
  sessions.set(input.leaseId, {
    ...input,
    uplinkBaseBytes: current?.uplinkBaseBytes ?? 0n,
    downlinkBaseBytes: current?.downlinkBaseBytes ?? 0n
  });
  await rebuildGateway();
}

async function removeSession(input: EdgeSessionCloseInputDto) {
  try {
    await reportTraffic();
  } catch (error) {
    warnThrottled("report-before-close", `关闭会话前上报流量失败: ${readError(error)}`);
  }
  sessions.delete(input.leaseId);
  await rebuildGateway();
}

async function rebuildGateway() {
  await mergeCurrentCounters();
  await stopXray();
  if (sessions.size === 0) {
    return;
  }

  writeXrayConfig();
  const child = spawn(xrayBinaryPath!, ["run", "-config", CONFIG_PATH], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  xrayChild = child;
  const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("exit", (code) => {
    warnThrottled("xray-exit", `中心中转 xray 已退出: ${code ?? "unknown"}`);
    xrayChild = null;
  });

  await sleep(900);
}

async function mergeCurrentCounters() {
  if (!xrayChild || sessions.size === 0) {
    return;
  }

  try {
    const counters = await queryTrafficCounters();
    for (const session of sessions.values()) {
      const current = counters.get(session.xrayUserEmail) ?? { uplinkBytes: 0n, downlinkBytes: 0n };
      session.uplinkBaseBytes += current.uplinkBytes;
      session.downlinkBaseBytes += current.downlinkBytes;
    }
  } catch (error) {
    warnThrottled("merge-counters", `合并转发计数失败: ${readError(error)}`);
  }
}

async function stopXray() {
  if (!xrayChild) {
    return;
  }

  const child = xrayChild;
  xrayChild = null;
  child.kill("SIGTERM");
  await sleep(500);
  if (!child.killed) {
    child.kill("SIGKILL");
  }
}

async function reportTraffic() {
  if (sessions.size === 0 || !xrayChild) {
    return;
  }

  const counters = await queryTrafficCounters();
  const records: EdgeTrafficReportInputDto["records"] = [];
  const groupedNodeIds = new Set<string>();

  for (const session of sessions.values()) {
    const current = counters.get(session.xrayUserEmail) ?? { uplinkBytes: 0n, downlinkBytes: 0n };
    const uplinkBytes = session.uplinkBaseBytes + current.uplinkBytes;
    const downlinkBytes = session.downlinkBaseBytes + current.downlinkBytes;
    groupedNodeIds.add(session.node.nodeId);
    records.push({
      sessionId: session.sessionId,
      leaseId: session.leaseId,
      xrayUserEmail: session.xrayUserEmail,
      xrayUserUuid: session.xrayUserUuid,
      uplinkBytes: uplinkBytes.toString(),
      downlinkBytes: downlinkBytes.toString(),
      sampledAt: new Date().toISOString()
    });
  }

  const recordsByNode = new Map<string, EdgeTrafficReportInputDto["records"]>();
  for (const record of records) {
    const session = sessions.get(record.leaseId);
    if (!session) {
      continue;
    }
    const bucket = recordsByNode.get(session.node.nodeId) ?? [];
    bucket.push(record);
    recordsByNode.set(session.node.nodeId, bucket);
  }

  for (const nodeId of groupedNodeIds) {
    const payload: EdgeTrafficReportInputDto = {
      nodeId,
      reportedAt: new Date().toISOString(),
      records: recordsByNode.get(nodeId) ?? []
    };
    await postJson("/internal/edge/sessions/report-traffic", payload);
  }
}

async function queryTrafficCounters() {
  const response = await queryStats({
    pattern: EDGE_XRAY_STATS_PATTERN,
    reset: false
  });
  const counters = new Map<string, { uplinkBytes: bigint; downlinkBytes: bigint }>();
  for (const stat of response.stat ?? []) {
    const parsed = parseStatName(stat.name ?? "");
    if (!parsed) {
      continue;
    }
    const current = counters.get(parsed.email) ?? { uplinkBytes: 0n, downlinkBytes: 0n };
    if (parsed.direction === "uplink") {
      current.uplinkBytes = parseBytes(stat.value);
    } else {
      current.downlinkBytes = parseBytes(stat.value);
    }
    counters.set(parsed.email, current);
  }
  return counters;
}

function writeXrayConfig() {
  const config = {
    log: {
      loglevel: "warning",
      error: LOG_PATH
    },
    api: {
      tag: "api",
      services: ["StatsService"]
    },
    stats: {},
    policy: {
      levels: {
        "0": {
          statsUserUplink: true,
          statsUserDownlink: true
        }
      },
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true
      }
    },
    inbounds: [
      {
        tag: "edge-in",
        listen: EDGE_LISTEN_HOST,
        port: EDGE_LISTEN_PORT,
        protocol: "vless",
        settings: {
          clients: Array.from(sessions.values()).map((session) => ({
            id: session.xrayUserUuid,
            flow: EDGE_FLOW,
            email: session.xrayUserEmail
          })),
          decryption: "none"
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            show: false,
            dest: EDGE_REALITY_DEST,
            xver: 0,
            serverNames: [EDGE_SERVER_NAME],
            privateKey: edgeRealityPrivateKey,
            shortIds: [edgeRealityShortId]
          }
        }
      },
      {
        tag: "api-in",
        listen: "127.0.0.1",
        port: EDGE_XRAY_API_PORT,
        protocol: "dokodemo-door",
        settings: {
          address: "127.0.0.1"
        }
      }
    ],
    outbounds: [
      ...Array.from(sessions.values()).map((session) => ({
        tag: outboundTag(session),
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: session.node.serverHost,
              port: session.node.serverPort,
              users: [
                {
                  id: session.node.uuid,
                  encryption: "none",
                  flow: session.node.flow
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            serverName: session.node.serverName,
            fingerprint: session.node.fingerprint,
            publicKey: session.node.realityPublicKey,
            shortId: session.node.shortId,
            spiderX: session.node.spiderX
          }
        }
      })),
      {
        tag: "api",
        protocol: "freedom"
      }
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [
        {
          type: "field",
          inboundTag: ["api-in"],
          outboundTag: "api"
        },
        ...Array.from(sessions.values()).map((session) => ({
          type: "field",
          user: [session.xrayUserEmail],
          outboundTag: outboundTag(session)
        }))
      ]
    }
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function outboundTag(session: RelaySession) {
  return `relay-${session.leaseId}`;
}

async function queryStats(request: QueryStatsRequest) {
  return new Promise<QueryStatsResponse>((resolve, reject) => {
    statsClient.QueryStats(request, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

async function postJson(pathName: string, payload: unknown) {
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(`${API_BASE_URL}${pathName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${EDGE_INTERNAL_TOKEN}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(EDGE_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`中心 API 不可用：${readError(error)}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function ensureXrayBinary() {
  const envBinary = process.env.CHORDV_XRAY_BIN?.trim();
  if (envBinary && fs.existsSync(envBinary)) {
    return envBinary;
  }

  const which = spawnSync("which", ["xray"], { encoding: "utf8" });
  const binaryFromPath = which.stdout?.trim();
  if (which.status === 0 && binaryFromPath && fs.existsSync(binaryFromPath)) {
    return binaryFromPath;
  }

  const candidates = [
    path.resolve(__dirname, "../../desktop/src-tauri/bin", targetBinaryName()),
    path.resolve(__dirname, "../../desktop/src-tauri/bin/xray")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("未找到 xray 可执行文件，请先设置 CHORDV_XRAY_BIN 或安装 xray");
}

function ensureRealityState(binaryPath: string) {
  if (edgeRealityPrivateKey && edgeRealityPublicKey && edgeRealityShortId) {
    return {
      privateKey: edgeRealityPrivateKey,
      publicKey: edgeRealityPublicKey,
      shortId: edgeRealityShortId
    };
  }

  if (fs.existsSync(REALITY_STATE_PATH)) {
    const cached = JSON.parse(fs.readFileSync(REALITY_STATE_PATH, "utf8")) as {
      privateKey?: string;
      publicKey?: string;
      shortId?: string;
    };
    if (cached.privateKey && cached.publicKey && cached.shortId) {
      return {
        privateKey: cached.privateKey,
        publicKey: cached.publicKey,
        shortId: cached.shortId
      };
    }
  }

  const generated = spawnSync(binaryPath, ["x25519"], { encoding: "utf8" });
  if (generated.status !== 0) {
    throw new Error("生成中心入口 Reality 密钥失败，请设置 CHORDV_EDGE_REALITY_PRIVATE_KEY / CHORDV_EDGE_REALITY_PUBLIC_KEY");
  }

  const privateKey = readLabeledValue(generated.stdout, ["PrivateKey", "Private key"]);
  const publicKey = readLabeledValue(generated.stdout, ["PublicKey", "Public key", "Password"]);
  const shortId = randomHex(8);
  if (!privateKey || !publicKey) {
    throw new Error("解析 Reality 密钥失败");
  }

  const payload = { privateKey, publicKey, shortId };
  fs.writeFileSync(REALITY_STATE_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

function targetBinaryName() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "xray-aarch64-apple-darwin";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "xray-x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    return "xray-x86_64-pc-windows-msvc.exe";
  }
  return "xray";
}

function readLabeledValue(source: string, labels: string[]) {
  for (const label of labels) {
    const matched = source.match(new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, "m"));
    if (matched?.[1]?.trim()) {
      return matched[1].trim();
    }
  }
  return "";
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveProtoRoot() {
  const distRoot = path.resolve(__dirname, "proto");
  if (fs.existsSync(distRoot)) {
    return distRoot;
  }
  return path.resolve(__dirname, "..", "src", "proto");
}

function resolveProtoPath(relativePath: string) {
  return path.resolve(protoRoot, relativePath);
}

function parseStatName(name: string) {
  const matched = name.match(/^user>>>(.+)>>>traffic>>>(uplink|downlink)$/);
  if (!matched) {
    return null;
  }
  return {
    email: matched[1].trim().toLowerCase(),
    direction: matched[2] === "downlink" ? "downlink" : "uplink"
  } as const;
}

function parseBytes(value: string | number | bigint | undefined) {
  if (typeof value === "bigint") {
    return value >= 0n ? value : 0n;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.max(0, Math.trunc(value)));
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function loadEnvFiles() {
  const appEnv = path.resolve(__dirname, "..", ".env");
  const rootEnv = path.resolve(__dirname, "../../../.env");
  if (fs.existsSync(rootEnv)) {
    dotenv.config({ path: rootEnv, override: false });
  }
  if (fs.existsSync(appEnv)) {
    dotenv.config({ path: appEnv, override: true });
  }
}

function normalizeApiBaseUrl(input: string) {
  const trimmed = input.replace(/\/$/, "");
  if (trimmed.endsWith("/api")) {
    return trimmed;
  }
  return `${trimmed}/api`;
}

function enqueue<T>(job: () => Promise<T>) {
  const next = operationQueue.then(job, job);
  operationQueue = next.then(() => undefined, () => undefined);
  return next;
}

function warnThrottled(key: string, message: string, intervalMs = 60_000) {
  const now = Date.now();
  const previous = warningTimestamps.get(key) ?? 0;
  if (now - previous < intervalMs) {
    return;
  }
  warningTimestamps.set(key, now);
  console.warn(`[edge-gateway] ${message}`);
}

function readError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function randomHex(length: number) {
  const alphabet = "0123456789abcdef";
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

type RelaySession = EdgeSessionOpenInputDto & {
  uplinkBaseBytes: bigint;
  downlinkBaseBytes: bigint;
};

type QueryStatsRequest = {
  pattern: string;
  reset: boolean;
};

type QueryStatsResponse = {
  stat?: Array<{
    name?: string;
    value?: string | number | bigint;
  }>;
};

type StatsServiceClient = {
  QueryStats(request: QueryStatsRequest, callback: (error: Error | null, response: QueryStatsResponse) => void): void;
};

type GrpcRoot = {
  xray: {
    app: {
      stats: {
        command: {
          StatsService: new (address: string, creds: ReturnType<typeof credentials.createInsecure>) => StatsServiceClient;
        };
      };
    };
  };
};
