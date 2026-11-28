import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Run the actual transport with a controlled clock and HTTP responses. No network or real timers.
const source = readFileSync(new URL("../src/api/client.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("client.ts", source, ts.ScriptTarget.Latest, true);
const functions = tree.statements.filter(s => ts.isFunctionDeclaration(s) && ["connectAdminRuntimeEvents", "parseAdminEventStreamBuffer"].includes(s.name?.text ?? ""));
assert.equal(functions.length, 2);
const js = ts.transpileModule(functions.map(s => s.getText(tree)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let ticks = 0, next = 0, mode = 503, refreshes = 0;
let endStream!: () => void;
const timers = new Map<number, { ms: number; run: () => void }>();
const requests: Array<Record<string, string>> = [];
const window = { setInterval: () => 1, clearInterval() {}, setTimeout(run: () => void, ms: number) { timers.set(++next, { ms, run }); return next; }, clearTimeout(id: number) { timers.delete(id); } };
const stop = new Function("captureAdminSession", "window", "fetch", "Date", "getStoredAdminAccessToken", "refreshAdminAccessToken", "clearStoredAdminSession", "API_BASE", "ADMIN_EVENT_STREAM_STALE_MS", "console", `${js};return connectAdminRuntimeEvents(()=>{});`)(() => () => {}, window,
  async (_: string, req: RequestInit) => { requests.push(req.headers as Record<string, string>); return mode === 200 ? new Response(new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode('id: server:7\ndata: {"type":"resync"}\n\n')); endStream = () => c.close(); }}),{headers:{'Content-Type':'text/event-stream'}}) : new Response(null, { status: mode }); },
  { now: () => ticks }, () => "test-token", async () => { refreshes++; return "refreshed"; }, () => assert.fail("unexpected logout"), "http://localhost", 60_000, { warn() {} });
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }
async function retry(low: number, high: number) { await settle(); assert.equal(timers.size, 1); const [id, timer] = [...timers][0]; assert.ok(timer.ms >= low && timer.ms <= high, `delay ${timer.ms} outside ${low}..${high}`); timers.delete(id); ticks += timer.ms; timer.run(); }
await retry(3000, 3500); await retry(6000, 6500); await retry(12000, 12500); await retry(24000, 24500);
mode = 200; await retry(30000, 30000); await settle(); ticks += 60_001; endStream();
mode = 401; await retry(3000, 3500); assert.equal(requests.at(-1)?.['Last-Event-ID'], 'server:7');
await retry(0, 0); await retry(6000, 6500); await settle(); assert(refreshes >= 2);
stop(); assert.equal(timers.size, 0, "unsubscribe must cancel the remaining reconnect");

// Change accounts after headers, while the old stream is waiting for its next frame.
let generation = 1, delivered = 0;
let pendingFrame!: ReadableStreamDefaultController<Uint8Array>;
const staleStop = new Function("captureAdminSession", "window", "fetch", "getStoredAdminAccessToken", "API_BASE", "ADMIN_EVENT_STREAM_STALE_MS", "console", "receive", `${js};return connectAdminRuntimeEvents(receive);`)(
  () => { const at = generation; return () => { if (at !== generation) throw Error("session changed"); }; }, window,
  async () => new Response(new ReadableStream<Uint8Array>({start(c){pendingFrame=c;}})), () => "old", "http://localhost", 60_000, {warn(){}}, () => delivered++);
await settle(); generation++;
pendingFrame.enqueue(new TextEncoder().encode('id: old:9\ndata: {"type":"resync"}\n\n')); await settle();
assert.equal(delivered, 0); staleStop(); pendingFrame.close(); assert.equal(timers.size, 0);
