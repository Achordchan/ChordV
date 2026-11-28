import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { loadLocalEnvironment, PROJECT_ROOT } from "./mygo-local-config.mjs";
import { createStartupReadinessBarrier } from "../tests/e2e/startup-readiness-barrier.mjs";

const execute = promisify(execFile);

async function freePorts() {
  const servers = await Promise.all(Array.from({ length: 4 }, async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    return server;
  }));
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}
async function assertPortClosed(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  await new Promise((resolve) => server.close(resolve));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`数据库启动过程中${signal}必须等自有PG关闭后退出，不继续构建`, { timeout: 45_000, skip: process.platform === "win32" }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chordv-startup-stop-"));
    let child, barrier, closed, timeout;
    let ports = [];
    let output = "";
    try {
      await mkdir(path.join(root, "scripts"));
      for (const name of ["mygo-local.mjs", "mygo-local-config.mjs", "mygo-local-db.mjs", "agent-release-assets.mjs"]) {
        await cp(path.join(PROJECT_ROOT, "scripts", name), path.join(root, "scripts", name));
      }
      ports = await freePorts();
      const local = await loadLocalEnvironment({ root, env: {} });
      const url = new URL(local.CHORDV_LOCAL_DATABASE_URL); url.port = String(ports[0]);
      await writeFile(path.join(root, ".data/mygo/local-env.json"), JSON.stringify({
        CHORDV_LOCAL_DATABASE_URL: url.href,
        CHORDV_LOCAL_JWT_SECRET: local.CHORDV_LOCAL_JWT_SECRET,
        CHORDV_LOCAL_AGENT_PEPPER: local.CHORDV_LOCAL_AGENT_PEPPER
      }), { mode: 0o600 });
      barrier = await createStartupReadinessBarrier(root, signal);
      child = spawn(process.execPath, ["--import", barrier.observer, "scripts/mygo-local.mjs"], {
        cwd: root,
        env: { ...process.env, CHORDV_LOCAL_PG_BIN: barrier.bin, CHORDV_LOCAL_DATABASE_URL: url.href, CHORDV_LOCAL_JWT_SECRET: local.CHORDV_LOCAL_JWT_SECRET, CHORDV_LOCAL_AGENT_PEPPER: local.CHORDV_LOCAL_AGENT_PEPPER, CHORDV_LOCAL_API_PORT: String(ports[1]), CHORDV_LOCAL_ADMIN_PORT: String(ports[2]), CHORDV_LOCAL_DESKTOP_PORT: String(ports[3]) },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
      const stopAtReady = (async () => {
        const message = await barrier.ready;
        assert.ok(message.pid > 0);
        const lines = (await readFile(path.join(root, ".data/mygo/postgres/postmaster.pid"), "utf8")).split("\n");
        assert.equal(await realpath(lines[1]), await realpath(path.join(root, ".data/mygo/postgres")));
        process.kill(Number(lines[0]), 0);
        t.diagnostic(`真实pg_isready已成功且其退出被私有IPC暂挂；自有PG PID=${lines[0]}，readiness PID=${message.pid}`);
        child.kill(signal);
        assert.equal((await barrier.dispatched).pid, child.pid);
        t.diagnostic(`${signal}已由真实supervisor事件循环派发，再释放readiness结果`);
        barrier.release();
      })();
      const result = await Promise.race([Promise.all([stopAtReady, closed]).then(([, result]) => result), new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`启动停止超时：${output}`)), 30_000); })]);
      assert.equal(result.signal, null);
      assert.equal(result.code, 1);
      assert.match(output, /本地启动已取消/);
      assert.doesNotMatch(output, /ENOENT|无法读取本地源码提交|本地 Go API：/);
      await assert.rejects(readFile(path.join(root, ".data/mygo/postgres/postmaster.pid")), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(root, "output/local/agent-dist/manifest.json")), { code: "ENOENT" });
      for (const port of ports) await assertPortClosed(port);
    } finally {
      clearTimeout(timeout);
      barrier?.release();
      try {
        // pg_ctl -w waits for this verified private cluster, including when
        // the supervisor failed early. Never remove a live cluster directory.
        const dir = path.join(root, ".data/mygo/postgres");
        const pidFile = path.join(dir, "postmaster.pid");
        try {
          const lines = (await readFile(pidFile, "utf8")).split("\n");
          assert.equal(await realpath(lines[1]), await realpath(dir));
          assert.match(lines[0], /^[1-9][0-9]*$/);
          try {
            await execute(path.join(barrier.bin, "pg_ctl"), ["-D", dir, "-m", "fast", "-w", "-t", "10", "stop"], { timeout: 12_000 });
          } catch (error) {
            // The production shutdown may have won the race with pg_ctl.
            let removed = false;
            try { await readFile(pidFile); } catch (missing) { if (missing.code === "ENOENT") removed = true; else throw missing; }
            if (!removed) throw error;
          }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await closed;
        }
        for (const port of ports) await assertPortClosed(port);
        await rm(root, { recursive: true, force: true });
      } finally {
        await barrier?.close();
      }
    }
  });
}
