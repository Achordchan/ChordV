import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { createInterface } from "node:readline";

export function managedProcess(program, args, options = {}) {
  const child = spawn(program, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  const events = new EventEmitter();
  const pending = new Map();
  let sequence = 0;
  let diagnostic = "";
  let ready;
  const readyPromise = new Promise((resolve, reject) => {
    ready = resolve;
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`测试进程提前退出 (${code ?? signal})`)));
  });
  // Keep diagnostics private: agent logs can contain account identifiers.
  child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-32768); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { diagnostic = (diagnostic + line + "\n").slice(-32768); return; }
    if (message.event === "ready") ready(message.node);
    const operation = pending.get(message.id);
    if (operation) {
      pending.delete(message.id);
      message.error ? operation.reject(new Error(message.error)) : operation.resolve(message.data);
    }
    events.emit("change");
  });
  child.on("exit", () => {
    for (const operation of pending.values()) operation.reject(new Error("测试节点已退出"));
    pending.clear();
    events.emit("change");
  });
  let stopRequested = false;
  let stopPromise;
  const requestStop = () => {
    if (stopRequested || child.exitCode !== null || child.signalCode !== null) return;
    stopRequested = true;
    child.kill("SIGTERM");
  };
  return {
    child, events, ready: readyPromise, requestStop, diagnostic: () => diagnostic,
    rpc(action, values = {}, timeoutMs = 16000) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`节点操作超时: ${action}`)); }, timeoutMs);
        pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        child.stdin.write(`${JSON.stringify({ id, action, ...values })}\n`);
      });
    },
    stop(graceMs = 4000) {
      if (stopPromise) return stopPromise;
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      stopPromise = new Promise((resolve) => {
        const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
        child.once("exit", () => { clearTimeout(kill); resolve(); });
        requestStop();
      });
      return stopPromise;
    }
  };
}

export async function runBuild(program, args, options) {
  const proc = managedProcess(program, args, options);
  // Build processes never send a ready frame.
  proc.ready.catch(() => {});
  await new Promise((resolve, reject) => {
    proc.child.once("error", reject);
    proc.child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${program} 构建失败: ${proc.diagnostic()}`)));
  });
}

export async function waitForState(label, check, events, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    let running = false;
    let changed = true;
    let ended = false;
    const timer = setTimeout(() => finish(new Error(`${label}超时`)), timeoutMs);
    const finish = (error, value) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      events.off("change", update);
      error ? reject(error) : resolve(value);
    };
    const update = async () => {
      changed = true;
      if (running || ended) return;
      running = true;
      try {
        while (changed && !ended) {
          changed = false;
          const result = await check();
          if (result) { finish(null, result); break; }
        }
      } catch (error) { finish(error); }
      finally { running = false; }
    };
    events.on("change", update);
    update();
  });
}

export async function adminEvents(base, token) {
  const events = new EventEmitter();
  const controller = new AbortController();
  const response = await fetch(`${base}/api/admin/events/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  if (!response.ok) throw new Error(`管理员事件订阅失败: ${response.status}`);
  const task = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.split("\n").some((line) => line.startsWith("data:"))) events.emit("change");
      }
    }
  })();
  task.catch(() => events.emit("change"));
  return { events, stop: async () => { controller.abort(); await task.catch(() => {}); } };
}

export async function transparentAgentProxy(base) {
  const target = new URL(base);
  if (target.hostname !== "127.0.0.1" || target.protocol !== "http:") throw new Error("仅允许本机 API");
  const events = new EventEmitter();
  const batches = [];
  const sockets = new Set();
  let holdUsage = false;
  const heldRequests = [];
  const releaseUsage = () => {
    holdUsage = false;
    for (const send of heldRequests.splice(0)) send();
  };
  const server = createServer((req, res) => {
    const captured = [];
    const usage = req.method === "POST" && req.url === "/api/agent/v1/usage-batches";
    if (usage) req.on("data", (chunk) => captured.push(chunk));
    const forward = (body) => {
      if (res.destroyed) return;
      const upstream = httpRequest({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        const reply = [];
        if (usage) answer.on("data", (chunk) => reply.push(chunk));
        answer.on("end", () => {
          if (usage && answer.statusCode === 200) {
            const bytes = body ?? Buffer.concat(captured);
            batches.push({ body: bytes, authorization: req.headers.authorization, payload: JSON.parse(bytes), reply: JSON.parse(Buffer.concat(reply)) });
            events.emit("change");
          }
        });
        answer.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      body ? upstream.end(body) : req.pipe(upstream);
    };
    if (usage && holdUsage) {
      req.once("end", () => {
        const body = Buffer.concat(captured);
        heldRequests.push(() => forward(body));
        events.emit("change");
      });
    } else forward();
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    events, batches, url: `http://127.0.0.1:${server.address().port}`,
    get heldUsageRequestCount() { return heldRequests.length; },
    holdUsageRequests() { if (holdUsage) throw new Error("计量上传已暂停"); holdUsage = true; return releaseUsage; },
    async replay(batch) {
      const response = await fetch(`${base}/api/agent/v1/usage-batches`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: batch.authorization }, body: batch.body, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`原始计量批次重放失败: ${response.status}`);
      return response.json();
    },
    async stop() { releaseUsage(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
  };
}
