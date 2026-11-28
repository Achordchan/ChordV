import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadLocalEnvironment } from "./mygo-local-config.mjs";
import { ensureLocalDatabase } from "./mygo-local-db.mjs";

async function isolatedConfig(root) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const local = await loadLocalEnvironment({ root, env: {} });
  const url = new URL(local.CHORDV_LOCAL_DATABASE_URL);
  url.port = String(port);
  local.CHORDV_LOCAL_DATABASE_URL = url.toString();
  return { local, port };
}

test("独立本地数据库忽略继承的PG服务配置和远端hostaddr", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chordv-pg-env-"));
  let db;
  try {
    const { local, port } = await isolatedConfig(root);
    db = await ensureLocalDatabase(local, { root, env: {
      ...process.env,
      PGHOSTADDR: "203.0.113.10",
      PGSERVICE: "production",
      PGSERVICEFILE: "/nonexistent/production-service",
      PGOPTIONS: "-c search_path=production"
    } });
    assert.equal(db.port, port);
    assert.ok(db.child?.pid, "必须启动本轮临时实例，不能借用已有数据库");
  } finally {
    await db?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("独立实例可从空目录启动、停止并用同一数据重启，不遗留子进程", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chordv-pg-owned-"));
  let db;
  try {
    const { local } = await isolatedConfig(root);
    db = await ensureLocalDatabase(local, { root });
    assert.ok(db.child?.pid, "首次启动必须拥有实际 PostgreSQL 子进程");
    const first = db.child;
    await Promise.all([db.stop(), db.stop(), db.stop()]);
    await db.stop();
    assert.equal(first.exitCode, 0, "显式停止应正常完成数据库关闭");
    db = await ensureLocalDatabase(local, { root });
    assert.notEqual(db.child?.pid, first.pid);
    const second = db.child;
    await db.stop();
    assert.equal(second.exitCode, 0);
    db = null;
  } finally {
    await db?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
