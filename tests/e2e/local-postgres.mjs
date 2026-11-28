import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { validateLocalDatabase, PROJECT_ROOT } from "../../scripts/mygo-local-config.mjs";

export function sqlID(value) {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("E2E 只接受明确的 UUID 记录");
  return `'${value}'`;
}

export async function localPostgres(local, { root = PROJECT_ROOT } = {}) {
  const url = validateLocalDatabase(local.CHORDV_LOCAL_DATABASE_URL);
  const pgBin = process.env.CHORDV_LOCAL_PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C",
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: "chordv_mygo_local", PGCONNECT_TIMEOUT: "3"
  };
  const sql = (query) => new Promise((resolve, reject) => {
    const child = spawn(path.join(pgBin, "psql"), ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`本地 E2E SQL 失败: ${error.trim()}`)));
    child.stdin.end(query);
  });
  const dir = await sql("SHOW data_directory;");
  if (await realpath(dir) !== await realpath(path.join(root, ".data/mygo/postgres"))) throw new Error("E2E 数据库不是指定测试根目录的独立实例");
  return {
    sql,
    async json(query) { return JSON.parse(await sql(query)); }
  };
}
