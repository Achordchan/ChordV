import { spawn } from "node:child_process";
import { access, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment, PROJECT_ROOT, validateLocalDatabase } from "./mygo-local-config.mjs";

function run(program, args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-16_384); });
    child.stderr.on("data", (chunk) => { error = (error + chunk).slice(-16_384); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${path.basename(program)} 执行失败：${error.trim()}`)));
    child.stdin.end(input);
  });
}

async function findPostgresBin(env) {
  const candidates = [
    env.CHORDV_LOCAL_PG_BIN,
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@17/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin"
  ].filter(Boolean);
  for (const dir of candidates) {
    try { await access(path.join(dir, process.platform === "win32" ? "postgres.exe" : "postgres")); return dir; }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  }
  throw new Error("未找到 PostgreSQL 服务端工具，请设置 CHORDV_LOCAL_PG_BIN；脚本不会使用 Docker 或连接旧数据库。");
}

async function portOccupied(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => error.code === "EADDRINUSE" ? resolve(true) : reject(error));
    server.listen(port, host, () => server.close(() => resolve(false)));
  });
}

export async function ensureLocalDatabase(local, { root = PROJECT_ROOT, env = process.env } = {}) {
  const url = validateLocalDatabase(local.CHORDV_LOCAL_DATABASE_URL);
  const bin = await findPostgresBin(env);
  const dir = path.join(root, ".data", "mygo", "postgres");
  const pgEnv = {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("PG"))),
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: "postgres",
    PGCONNECT_TIMEOUT: "3",
    LC_ALL: "C"
  };
  const exec = (name, args, input) => run(path.join(bin, name), args, pgEnv, input);
  let child = null;
  let log = null;
  let stopPromise;
  const stop = () => stopPromise ??= (async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGINT");
      await closed;
    }
    await log?.close();
  })();
  if (!await portOccupied(pgEnv.PGHOST, Number(url.port))) {
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    try { await access(path.join(dir, "PG_VERSION")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const passwordFile = path.join(root, ".data/mygo/postgres-password");
      await writeFile(passwordFile, `${pgEnv.PGPASSWORD}\n`, { mode: 0o600, flag: "wx" });
      try {
        await exec("initdb", ["-D", dir, "-U", pgEnv.PGUSER, "--pwfile", passwordFile, "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--no-locale"]);
      } finally { await rm(passwordFile, { force: true }); }
    }
    log = await open(path.join(root, ".data/mygo/postgres.log"), "a", 0o600);
    child = spawn(path.join(bin, "postgres"), ["-D", dir, "-h", pgEnv.PGHOST, "-p", url.port, "-k", ""], {
      env: pgEnv, stdio: ["ignore", log.fd, log.fd], windowsHide: true
    });
    let startupError;
    child.once("error", (error) => { startupError = error; });
    const deadline = Date.now() + 20_000;
    let ready = false;
    for (let delay = 50; Date.now() < deadline; delay = Math.min(delay * 2, 1000)) {
      if (startupError || child.exitCode !== null || child.signalCode !== null) break;
      try { await exec("pg_isready", ["-q"]); ready = true; break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (!ready) {
      await stop();
      throw new Error("独立 PostgreSQL 启动失败，请检查 .data/mygo/postgres.log", { cause: startupError });
    }
  }
  try {
    const actualDir = await exec("psql", ["-X", "-At", "-c", "SHOW data_directory"]);
    if (await realpath(actualDir) !== await realpath(dir)) throw new Error("数据库端口属于其他实例，已停止，不会访问其业务数据");
    const exists = await exec("psql", ["-X", "-At", "-c", "SELECT 1 FROM pg_database WHERE datname = 'chordv_mygo_local'"]);
    if (exists !== "1") await exec("createdb", ["--encoding=UTF8", "chordv_mygo_local"]);
  } catch (error) { await stop(); throw error; }
  return { child, stop, bin, port: Number(url.port) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const local = await loadLocalEnvironment();
  const db = await ensureLocalDatabase(local);
  process.stdout.write(`独立本地数据库已就绪：127.0.0.1:${db.port}/chordv_mygo_local\n`);
  if (db.child) {
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await db.stop(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise((resolve) => db.child.once("close", resolve));
  }
}
