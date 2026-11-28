import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadLocalEnvironment, localPort, validateLocalDatabase } from "./mygo-local-config.mjs";

test("本地数据库拒绝远端、旧库及连接参数绕过", () => {
  for (const value of [
    "postgresql://user:secret@server.example:5432/chordv_mygo_local",
    "postgresql://user:secret@127.0.0.1:5432/chordv",
    "postgresql://user:secret@127.0.0.1:5432/chordv_mygo_local?host=server.example",
    "postgresql://user:secret@127.0.0.1:5432/chordv_mygo_local?service=production"
  ]) assert.throws(() => validateLocalDatabase(value));
  assert.equal(validateLocalDatabase("postgresql://u:p@127.0.0.1:55437/chordv_mygo_local?sslmode=disable").port, "55437");
});

test("端口必须有效且不能与已有组件重叠", async () => {
  for (const value of ["abc", 0, -1, 65536, 1023, 3100.5]) assert.throws(() => localPort(value, 3100));
  assert.equal(localPort(undefined, 3100), 3100);
  const root = await mkdtemp(path.join(os.tmpdir(), "chordv-config-"));
  try {
    await assert.rejects(loadLocalEnvironment({ root, env: { CHORDV_LOCAL_API_PORT: "5174" } }), /不能相同/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("只生成独立本地凭据，忽略根.env和旧生产环境变量", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chordv-config-"));
  try {
    await writeFile(path.join(root, ".env"), "DATABASE_URL=postgresql://production/production\nVITE_API_BASE_URL=https://production.example\n");
    const config = await loadLocalEnvironment({ root, env: {
      DATABASE_URL: "postgresql://production/production",
      CHORDV_MODE: "production",
      VITE_API_BASE_URL: "https://production.example",
      CHORDV_API_BASE_URL: "https://production.example"
    } });
    assert.equal(config.VITE_API_BASE_URL, "http://127.0.0.1:3100");
    assert.equal(config.CHORDV_MODE, "local");
    assert.equal(config.CHORDV_API_BASE_URL, config.VITE_API_BASE_URL);
    assert.match(config.CHORDV_LOCAL_DATABASE_URL, /127\.0\.0\.1:55437\/chordv_mygo_local/);
    const file = path.join(root, ".data/mygo/local-env.json");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    const again = await loadLocalEnvironment({ root, env: {} });
    assert.equal(again.CHORDV_LOCAL_JWT_SECRET, config.CHORDV_LOCAL_JWT_SECRET);
    assert.ok((await readFile(file, "utf8")).includes("CHORDV_LOCAL_DATABASE_URL"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("已有损坏配置不被静默重置，远端本地变量覆盖也拒绝", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chordv-config-"));
  try {
    await loadLocalEnvironment({ root, env: {} });
    await assert.rejects(loadLocalEnvironment({ root, env: {
      CHORDV_LOCAL_DATABASE_URL: "postgresql://user:secret@production.example:5432/chordv_mygo_local"
    } }), /只允许连接本机/);
    const file = path.join(root, ".data/mygo/local-env.json");
    await writeFile(file, "not-json");
    await assert.rejects(loadLocalEnvironment({ root, env: {} }), /不会覆盖/);
    assert.equal(await readFile(file, "utf8"), "not-json");
  } finally { await rm(root, { recursive: true, force: true }); }
});
