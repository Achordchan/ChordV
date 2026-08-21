import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const required = [
  "CHORDV_AGENT_ID",
  "CHORDV_NODE_ID",
  "CHORDV_AGENT_TOKEN",
  "CHORDV_LOCAL_XRAY_BINARY",
  "CHORDV_LOCAL_XRAY_CONFIG"
];

for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`启用本地 Node Agent 时必须配置 ${name}`);
}

const xrayBinary = path.resolve(process.env.CHORDV_LOCAL_XRAY_BINARY);
const xrayConfig = path.resolve(process.env.CHORDV_LOCAL_XRAY_CONFIG);
if (!existsSync(xrayBinary)) throw new Error(`找不到本地 Xray：${xrayBinary}`);
if (!existsSync(xrayConfig)) throw new Error(`找不到本地 Xray 配置：${xrayConfig}`);

const apiUrl = new URL(process.env.CHORDV_API_BASE_URL ?? "http://127.0.0.1:3000");
const xrayTarget = parseLoopbackAddress(process.env.XRAY_API_ADDRESS?.trim() ?? "127.0.0.1:10085");
const children = new Set();
let stopping = false;

const xray = startChild(xrayBinary, ["run", "-config", xrayConfig], "Xray");
await waitForPort(xrayTarget.host, xrayTarget.port, 30_000, "Xray API");
await waitForPort(apiUrl.hostname, Number(apiUrl.port || 80), 60_000, "ChordV API");

const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
const agent = startChild(corepack, ["pnpm", "--filter", "@chordv/node-agent", "dev"], "Node Agent");

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));

const exitCode = await new Promise((resolve) => {
  xray.once("exit", (code) => resolve(code ?? 1));
  agent.once("exit", (code) => resolve(code ?? 1));
});
await stop(Number(exitCode));

function startChild(command, args, label) {
  const child = spawn(command, args, { env: process.env, stdio: "inherit", windowsHide: true });
  children.add(child);
  child.once("error", (error) => {
    console.error(`${label} 启动失败：${error.message}`);
    void stop(1);
  });
  child.once("exit", () => children.delete(child));
  return child;
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const child of children) child.kill("SIGKILL");
  process.exit(exitCode);
}

function parseLoopbackAddress(value) {
  const match = value.match(/^(127\.0\.0\.1|localhost):(\d{1,5})$/i);
  if (!match) throw new Error("本地测试的 XRAY_API_ADDRESS 必须是 127.0.0.1 或 localhost TCP 地址");
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error("XRAY_API_ADDRESS 端口无效");
  return { host: match[1], port };
}

async function waitForPort(host, port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} 在 ${timeoutMs / 1000} 秒内未就绪`);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(500);
    socket.once("connect", () => socket.end(() => resolve(true)));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}
