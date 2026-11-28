import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The real pg_isready must succeed before the test pauses its exit. This
// controls delivery timing, never substitutes the PostgreSQL readiness result.
export async function runReadinessProbe(executable, args, socketPath) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (code !== 0) { process.exitCode = code; return; }
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify({ type: "ready", pid: process.pid }) + "\n"));
    socket.once("data", () => { socket.end(); resolve(); });
  });
}

export async function createStartupReadinessBarrier(root, signal) {
  const gateRoot = await mkdtemp("/tmp/chordv-startup-gate-");
  const socketPath = path.join(gateRoot, "gate.sock");
  let readyResolve, signalResolve, held;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const dispatched = new Promise((resolve) => { signalResolve = resolve; });
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk;
      if (!pending.includes("\n")) return;
      const message = JSON.parse(pending.slice(0, pending.indexOf("\n")));
      if (message.type === "ready") { held = socket; readyResolve(message); }
      if (message.type === "signal" && message.signal === signal) { signalResolve(message); socket.end(); }
    });
  });
  const close = async () => {
    held?.end("release\n");
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(gateRoot, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
    const candidates = [process.env.CHORDV_LOCAL_PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/local/opt/postgresql@17/bin", "/Applications/Postgres.app/Contents/Versions/latest/bin"].filter(Boolean);
    let actual;
    for (const candidate of candidates) {
      try { await access(path.join(candidate, "postgres")); actual = candidate; break; }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
    }
    if (!actual) throw new Error("真实启动测试需要已安装的PostgreSQL工具");
    const bin = path.join(root, "postgres-tools");
    await mkdir(bin);
    for (const name of ["postgres", "initdb", "psql", "createdb", "pg_ctl"]) await symlink(path.join(actual, name), path.join(bin, name));
    const probe = path.join(bin, "pg_isready");
    const module = pathToFileURL(fileURLToPath(import.meta.url)).href;
    await writeFile(probe, `#!${process.execPath}\nimport { runReadinessProbe } from ${JSON.stringify(module)};\nawait runReadinessProbe(${JSON.stringify(path.join(actual, "pg_isready"))}, process.argv.slice(2), ${JSON.stringify(socketPath)});\n`);
    await chmod(probe, 0o700);
    const observer = path.join(root, "signal-observer.mjs");
    await writeFile(observer, `import net from "node:net";\nprocess.once(${JSON.stringify(signal)}, () => { const socket = net.createConnection(${JSON.stringify(socketPath)}); socket.once("error", () => {}); socket.once("connect", () => socket.end(JSON.stringify({type:"signal",signal:${JSON.stringify(signal)},pid:process.pid})+String.fromCharCode(10))); });\n`);
    return { bin, observer, ready, dispatched, release: () => held?.end("release\n"), close };
  } catch (error) { await close(); throw error; }
}
