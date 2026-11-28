import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const LOCAL_DATABASE_NAME = "chordv_mygo_local";

export function validateLocalDatabase(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("本地数据库地址格式无效"); }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== `/${LOCAL_DATABASE_NAME}` || url.hash || !url.port
  ) throw new Error("只允许连接本机独立数据库 chordv_mygo_local，不能连接线上或旧库");
  for (const key of url.searchParams.keys()) {
    if (key !== "sslmode") throw new Error("本地数据库连接参数不受支持");
  }
  return url;
}

export function localPort(raw, fallback) {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("本地端口必须为 1024..65535 的整数");
  return value;
}

export function validateLocalEnvironment(config) {
  const database = validateLocalDatabase(config.CHORDV_LOCAL_DATABASE_URL);
  for (const key of ["CHORDV_LOCAL_JWT_SECRET", "CHORDV_LOCAL_AGENT_PEPPER"]) {
    if (typeof config[key] !== "string" || config[key].length < 32) throw new Error(`${key} 至少需要 32 字符`);
  }
  if (database.username !== "chordv_local") throw new Error("独立数据库只能使用本地专用角色 chordv_local");
  return config;
}

export async function loadLocalEnvironment({ root = PROJECT_ROOT, env = process.env } = {}) {
  const dir = path.join(root, ".data", "mygo");
  const file = path.join(dir, "local-env.json");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let config;
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("本地配置读取失败，不会覆盖已有文件", { cause: error });
    const password = randomBytes(32).toString("hex");
    config = {
      CHORDV_LOCAL_DATABASE_URL: `postgresql://chordv_local:${password}@127.0.0.1:55437/${LOCAL_DATABASE_NAME}?sslmode=disable`,
      CHORDV_LOCAL_JWT_SECRET: randomBytes(48).toString("hex"),
      CHORDV_LOCAL_AGENT_PEPPER: randomBytes(48).toString("hex")
    };
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  await chmod(file, 0o600);
  for (const key of Object.keys(config)) {
    if (!key.startsWith("CHORDV_LOCAL_")) throw new Error("本地配置包含非本地环境变量");
    if (env[key] !== undefined) config[key] = env[key];
  }
  validateLocalEnvironment(config);
  const apiPort = localPort(env.CHORDV_LOCAL_API_PORT, 3100);
  const adminPort = localPort(env.CHORDV_LOCAL_ADMIN_PORT, 5174);
  const desktopPort = localPort(env.CHORDV_LOCAL_DESKTOP_PORT, 5173);
  const databasePort = Number(new URL(config.CHORDV_LOCAL_DATABASE_URL).port);
  if (new Set([apiPort, adminPort, desktopPort, databasePort]).size !== 4) throw new Error("API、后台、客户端和数据库端口不能相同");
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const dataDir = path.join(dir, "server");
  const frontendEnvDir = path.join(dir, "frontend-env");
  await mkdir(frontendEnvDir, { recursive: true, mode: 0o700 });
  return {
    ...config,
    CHORDV_MODE: "local",
    CHORDV_LOCAL_DATA_DIR: dataDir,
    CHORDV_LOCAL_LISTEN: `127.0.0.1:${apiPort}`,
    CHORDV_LOCAL_ORIGINS: `http://127.0.0.1:${adminPort},http://127.0.0.1:${desktopPort}`,
    CHORDV_API_BASE_URL: apiBase,
    CHORDV_DEV_API_TARGET: apiBase,
    CHORDV_API_PORT: String(apiPort),
    CHORDV_ADMIN_PORT: String(adminPort),
    CHORDV_LOCAL_DESKTOP_PORT: String(desktopPort),
    CHORDV_MYGO_DATA_DIR: path.join(dir, "desktop"),
    CHORDV_LOCAL_FRONTEND_ENV_DIR: frontendEnvDir,
    VITE_API_BASE_URL: apiBase
  };
}
