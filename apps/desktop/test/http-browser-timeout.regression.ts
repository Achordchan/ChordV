import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { ApiRequestError, requestBrowserWithMeta } from "../src/api/http";

async function localServer(t: TestContext, status = 200) {
  let headersSent!: () => void;
  const headers = new Promise<void>(resolve => { headersSent = resolve; });
  const sockets = new Set<Socket>();
  const requests: IncomingMessage[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(req);
    res.writeHead(status, { "Content-Type": "application/json" });
    if (req.url === "/api/complete") res.end('{"ok":true}');
    else { res.flushHeaders(); res.write('{"ok":'); }
    headersSent();
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, headers, requests };
}
function trackExternalListeners(signal: AbortSignal) {
  const counts = { added: 0, removed: 0 };
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type, listener, options) => { if (type === "abort") counts.added++; add(type, listener, options); }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type, listener, options) => { if (type === "abort") counts.removed++; remove(type, listener, options); }) as typeof signal.removeEventListener;
  return counts;
}

test("真实HTTP响应头已到但正文停滞时仍按内部超时中断", { timeout: 4000 }, async t => {
  const server = await localServer(t);
  const external = new AbortController(), counts = trackExternalListeners(external.signal);
  const pending = requestBrowserWithMeta(server.url, "/stalled", { signal: external.signal }, 350);
  await server.headers;
  await assert.rejects(pending, error => error instanceof ApiRequestError && /请求超时/.test(error.message));
  assert.equal(external.signal.aborted, false, "外部signal存在不能替代内部截止时间，也不能反向取消调用方signal");
  assert.deepEqual(counts, { added: 1, removed: 1 });
});

test("错误HTTP状态的正文停滞同样受完整请求超时覆盖", { timeout: 4000 }, async t => {
  const server = await localServer(t, 503);
  const pending = requestBrowserWithMeta(server.url, "/error-stalled", undefined, 350);
  await server.headers;
  await assert.rejects(pending, error => error instanceof ApiRequestError && error.status === null && /请求超时/.test(error.message));
});

test("响应头已到后外部取消立即中断正文，保留原取消原因", { timeout: 4000 }, async t => {
  const server = await localServer(t);
  const external = new AbortController(), counts = trackExternalListeners(external.signal);
  const reason = new Error("test-only user cancellation");
  const pending = requestBrowserWithMeta(server.url, "/cancel-stalled", { signal: external.signal }, 3000);
  await server.headers; external.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.deepEqual(counts, { added: 1, removed: 1 });
});

test("正常正文完整读取后清理监听并保留Headers输入", { timeout: 4000 }, async t => {
  const server = await localServer(t);
  const external = new AbortController(), counts = trackExternalListeners(external.signal);
  const result = await requestBrowserWithMeta<{ ok: boolean }>(server.url, "/complete", { signal: external.signal, headers: new Headers({ "X-Fixture": "present" }) }, 1000);
  assert.deepEqual(result.data, { ok: true }); assert.equal(result.status, 200);
  assert.equal(server.requests[0].headers["x-fixture"], "present");
  assert.deepEqual(counts, { added: 1, removed: 1 });
});

test("已取消的外部signal不发出HTTP请求", { timeout: 4000 }, async t => {
  const server = await localServer(t), external = new AbortController();
  const reason = new Error("test-only pre-cancelled"); external.abort(reason);
  await assert.rejects(requestBrowserWithMeta(server.url, "/complete", { signal: external.signal }, 1000), error => error === reason);
  assert.equal(server.requests.length, 0);
});
