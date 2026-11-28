import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { ensureLocalDatabase } from "./mygo-local-db.mjs";
import { loadLocalEnvironment, PROJECT_ROOT } from "./mygo-local-config.mjs";
import { buildAgentDistribution } from "./agent-release-assets.mjs";

const args = process.argv.slice(2);
let createAdmin = null;
if (args[0] === "--create-admin" && args.length === 2) createAdmin = args[1];
else if (args.length > 1 || (args[0] && !/^\d+$/.test(args[0]))) {
  throw new Error("用法：bash ./start.sh [后台端口]；创建管理员：CHORDV_LOCAL_ADMIN_PASSWORD=... node scripts/mygo-local.mjs --create-admin 邮箱");
}
const local = await loadLocalEnvironment({ env: {
  ...process.env,
  ...(!createAdmin && args[0] ? { CHORDV_LOCAL_ADMIN_PORT: args[0] } : {})
} });
const env = { ...process.env, ...local, NODE_ENV: "development", CGO_ENABLED: "0" };
const children = new Set();
let database;
let stopping = false;
const childStops = new Map();
// 数据库可能在首次停止请求后才完成启动，收尾必须再次纳入它。
const shutdown = async () => {
  stopping = true;
  const waits = [];
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (!childStops.has(child)) {
      childStops.set(child, new Promise((resolve) => child.once("close", resolve)));
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    waits.push(childStops.get(child));
  }
  await Promise.all(waits);
  await database?.stop();
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void shutdown().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
});

function childProcess(command, commandArgs, cwd, extraEnv) {
  if (stopping) throw new Error("本地启动已取消");
  const child = spawn(command, commandArgs, {
    cwd, env: { ...env, ...extraEnv }, stdio: "inherit", windowsHide: true,
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    detached: process.platform !== "win32"
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

async function run(command, commandArgs, cwd, extraEnv) {
  const child = childProcess(command, commandArgs, cwd, extraEnv);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} 执行失败（${signal ?? code}）`)));
  });
  if (stopping) throw new Error("本地启动已取消");
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`本地端口 ${port} 已占用，脚本不会停止已有进程`)));
    server.listen(Number(port), "127.0.0.1", () => server.close(resolve));
  });
}

async function waitForApi(child) {
  const deadline = Date.now() + 30_000;
  for (let delay = 50; Date.now() < deadline; delay = Math.min(delay * 2, 1000)) {
    if (stopping || child.exitCode !== null || child.signalCode !== null) throw new Error("本地 API 启动过程中退出");
    try {
      const response = await fetch(`${local.CHORDV_API_BASE_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("本地 API 未在 30 秒内就绪");
}

async function readAdminPassword() {
  if (process.env.CHORDV_LOCAL_ADMIN_PASSWORD) return process.env.CHORDV_LOCAL_ADMIN_PASSWORD;
  if (!process.stdin.isTTY) throw new Error("非交互运行必须用 CHORDV_LOCAL_ADMIN_PASSWORD 提供本地管理员密码");
  const ask = async (prompt) => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    process.stdout.write(prompt);
    const readline = createInterface({ input: process.stdin, output, terminal: true });
    try { return await readline.question(""); }
    finally { readline.close(); process.stdout.write("\n"); }
  };
  const password = await ask("本地管理员密码（输入不回显）：");
  if (password.length < 12) throw new Error("本地管理员密码至少需要 12 个字符");
  if (await ask("再次输入密码：") !== password) throw new Error("两次输入的密码不一致");
  return password;
}

try {
  if (!createAdmin) {
    await requireFreePort(local.CHORDV_API_PORT);
    await requireFreePort(local.CHORDV_ADMIN_PORT);
  }
  database = await ensureLocalDatabase(local);
  if (stopping) throw new Error("本地启动已取消");
  const binDir = path.join(PROJECT_ROOT, "output/local");
  await mkdir(binDir, { recursive: true });
  const binary = path.join(binDir, process.platform === "win32" ? "chordv-server.exe" : "chordv-server");
  const serverDir = path.join(PROJECT_ROOT, "apps/server");
  const version = (await readFile(path.join(PROJECT_ROOT, "SYSTEM_VERSION"), "utf8")).trim();
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" });
  const commit = revision.stdout?.trim();
  if (revision.status !== 0 || !/^[a-f0-9]{40,64}$/.test(commit ?? "")) throw new Error("无法读取本地源码提交");
  const agentManifestSHA256 = await buildAgentDistribution(path.join(binDir, "agent-dist"), { version, commit, runBuild: run });
  const pkg = "github.com/Achordchan/ChordV/apps/server/internal/buildinfo";
  const flags = `-s -w -X ${pkg}.Version=${version} -X ${pkg}.Commit=${commit} -X ${pkg}.BuiltAt=${new Date().toISOString()} -X ${pkg}.AgentManifestSHA256=${agentManifestSHA256}`;
  await run("go", ["build", `-ldflags=${flags}`, "-o", binary, "./cmd/chordv-server"], serverDir);
  await run(binary, ["--migrate"], PROJECT_ROOT);
  if (createAdmin) {
    const password = await readAdminPassword();
    await run(binary, ["--create-admin", createAdmin], PROJECT_ROOT, { CHORDV_LOCAL_ADMIN_PASSWORD: password });
    process.stdout.write("本地管理员已创建。\n");
    await shutdown();
  } else {
    const api = childProcess(binary, [], PROJECT_ROOT);
    await waitForApi(api);
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const admin = childProcess(pnpm, ["--filter", "@chordv/admin", "dev"], PROJECT_ROOT);
    process.stdout.write(`本地 Go API：${local.CHORDV_API_BASE_URL}/api\n本地管理后台：http://127.0.0.1:${local.CHORDV_ADMIN_PORT}\n数据库：独立 chordv_mygo_local；未读取根 .env。按 Ctrl+C 停止本次服务。\n`);
    await Promise.race([api, admin].map((child) => new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => stopping || code === 0 ? resolve() : reject(new Error("本地服务异常退出")));
    })));
    await shutdown();
  }
} catch (error) {
  await shutdown();
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
