import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const MAX_FILE = 10 * 1024 * 1024;
const MAX_STORED = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const bearer = (req, token) => {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(req.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
function validPath(value) {
  if (!value || value.length > 512 || /[\\\x00-\x1f\x7f]/.test(value) || value.split("/").some((part) => !part || part.includes(".."))) {
    throw fail(400, "INVALID_PATH");
  }
  return value;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const clean = () => { req.off("data", data); req.off("end", end); req.off("error", error); req.off("aborted", aborted); };
    const error = (value) => { clean(); reject(value); };
    const aborted = () => error(fail(400, "REQUEST_ABORTED"));
    const end = () => { clean(); resolve(Buffer.concat(chunks)); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) { clean(); req.resume(); reject(fail(413, "BODY_TOO_LARGE")); }
      else chunks.push(chunk);
    };
    req.on("data", data).once("end", end).once("error", error).once("aborted", aborted);
  });
}
function modeOptions(mode, delayMs) {
  mode = ({ http_503: "http503", delay: "timeout" })[mode] ?? mode;
  if (!["success", "http503", "timeout"].includes(mode) || !Number.isInteger(delayMs) || delayMs < 1 || delayMs > 120000) {
    throw fail(422, "INVALID_MODE");
  }
  return { mode, delayMs };
}

// Test-only real HTTP endpoint; nothing in production imports or configures it.
export async function createImageProvider({ port = 0, mode = "success", delayMs = 30000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("本机图床测试端口无效");
  let options = modeOptions(mode, delayMs);
  const credentials = Object.freeze({ apiToken: randomBytes(32).toString("base64url"), controlToken: randomBytes(32).toString("base64url") });
  const files = new Map(), sockets = new Set(), pending = new Set(), delays = new Set();
  const events = new EventEmitter();
  const counts = { uploadRequests: 0, uploaded: 0, listRequests: 0, deleted: 0, http503: 0, delayStarted: 0, delayCompleted: 0, delayCancelled: 0 };
  let origin, stopped = false, stopping, storedBytes = 0;
  const snapshot = () => structuredClone({ ...options, ...counts, pendingDelays: delays.size, storedBytes, stopped,
    files: [...files.values()].map(({ name, originalName, bytes, createdAt }) => ({ name, originalName, mimeType: "image/png", size: bytes.length, createdAt })) });
  const respond = (res, status, payload) => {
    if (res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };
  const waitDelay = async (res, milliseconds) => {
    const controller = new AbortController();
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", closed);
    delays.add(controller);
    counts.delayStarted++;
    events.emit("change");
    try {
      await sleep(milliseconds, undefined, { signal: controller.signal });
      counts.delayCompleted++;
      return !stopped && !res.destroyed;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      counts.delayCancelled++;
      return false;
    } finally {
      res.off("close", closed);
      delays.delete(controller);
      events.emit("change");
    }
  };
  const handler = async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (stopped) return respond(res, 503, { code: "STOPPED" });
    if (req.headers.host !== new URL(origin).host || !req.url.startsWith("/") || req.url.startsWith("//")) return respond(res, 403, { code: "HOST_MISMATCH" });
    if (req.headers.origin && req.headers.origin !== origin) return respond(res, 403, { code: "ORIGIN_MISMATCH" });
    const url = new URL(req.url, origin);
    // Decode the raw path, not URL.pathname: URL parsing normalizes dot segments.
    const path = decodeURIComponent(req.url.split("?")[0]);
    if (path === "/__test/control") {
      if (!bearer(req, credentials.controlToken)) return respond(res, 401, { code: "INVALID_CONTROL_TOKEN" });
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req, 4096)).toString("utf8"));
        if (!input || Object.keys(input).some((key) => !["mode", "delayMs"].includes(key))) throw fail(422, "INVALID_MODE");
        options = modeOptions(input.mode, input.delayMs ?? options.delayMs);
        events.emit("change");
      } else if (req.method !== "GET") return respond(res, 405, { code: "METHOD_NOT_ALLOWED" });
      return respond(res, 200, snapshot());
    }
    if (path.startsWith("/file/") && req.method === "GET") {
      const file = files.get(validPath(path.slice(6)));
      if (!file) return respond(res, 404, { code: "NOT_FOUND" });
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": file.bytes.length });
      return res.end(file.bytes);
    }
    if (!bearer(req, credentials.apiToken)) return respond(res, 401, { code: "INVALID_API_TOKEN" });
    if (path === "/upload" && req.method === "POST") {
      counts.uploadRequests++;
      events.emit("change");
      if (!req.headers["content-type"]?.toLowerCase().startsWith("multipart/form-data;")) throw fail(415, "MULTIPART_REQUIRED");
      const raw = await readBody(req, MAX_FILE + 65536);
      const form = await new Request(`${origin}/upload`, { method: "POST", headers: { "Content-Type": req.headers["content-type"] }, body: raw }).formData();
      const entries = [...form.entries()];
      const file = form.get("file");
      if (entries.length !== 1 || !file || typeof file === "string" || !file.size) throw fail(400, "ONE_FILE_REQUIRED");
      if (file.size > MAX_FILE) throw fail(413, "FILE_TOO_LARGE");
      const bytes = Buffer.from(await file.arrayBuffer());
      // Go multipart.Writer.CreateFormFile emits octet-stream; validate PNG bytes too.
      if (!["image/png", "application/octet-stream"].includes(file.type) || bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") throw fail(415, "PNG_REQUIRED");
      const folder = validPath(url.searchParams.get("uploadFolder") || "e2e");
      const current = { ...options };
      if (current.mode === "http503") { counts.http503++; events.emit("change"); return respond(res, 503, { success: false, code: "TEST_UPSTREAM_UNAVAILABLE" }); }
      if (current.mode === "timeout" && !await waitDelay(res, current.delayMs)) return;
      if (stopped || res.destroyed) return;
      if (storedBytes + bytes.length > MAX_STORED || files.size >= 100) throw fail(507, "FIXTURE_CAPACITY_REACHED");
      const originalName = file.name.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-120) || "image.png";
      const name = `${folder}/${randomBytes(12).toString("hex")}-${originalName}`;
      files.set(name, { name, originalName, bytes, createdAt: new Date().toISOString() });
      storedBytes += bytes.length;
      counts.uploaded++;
      events.emit("change");
      return respond(res, 200, { success: true, url: `/file/${name.split("/").map(encodeURIComponent).join("/")}` });
    }
    if (path === "/api/manage/list" && req.method === "GET") {
      const start = Number(url.searchParams.get("start") ?? 0), count = Number(url.searchParams.get("count") ?? 50);
      if (!Number.isInteger(start) || start < 0 || start > 10000 || !Number.isInteger(count) || count < 1 || count > 100) throw fail(400, "INVALID_PAGE");
      const dir = url.searchParams.get("dir");
      if (dir) validPath(dir);
      const search = (url.searchParams.get("search") ?? "").toLocaleLowerCase();
      const recursive = url.searchParams.get("recursive") !== "false";
      const matching = [...files.values()].filter((file) => (!dir || file.name.startsWith(`${dir}/`)) &&
        (recursive || !file.name.slice(dir ? dir.length + 1 : 0).includes("/")) && file.name.toLocaleLowerCase().includes(search));
      const selected = matching.slice(start, start + count);
      counts.listRequests++;
      events.emit("change");
      return respond(res, 200, { files: selected.map((file) => ({ name: file.name, metadata: { "File-Mime": "image/png", "File-Size": file.bytes.length, TimeStamp: file.createdAt, Channel: "local" } })),
        directories: [], totalCount: matching.length, returnedCount: selected.length, indexLastUpdated: new Date().toISOString() });
    }
    if (path.startsWith("/api/manage/delete/") && ["GET", "DELETE"].includes(req.method)) {
      const name = validPath(path.slice("/api/manage/delete/".length));
      const names = url.searchParams.get("folder") === "true" ? [...files.keys()].filter((key) => key.startsWith(`${name}/`)) : files.has(name) ? [name] : [];
      if (!names.length) return respond(res, 404, { success: false, code: "NOT_FOUND" });
      for (const key of names) { storedBytes -= files.get(key).bytes.length; files.delete(key); }
      counts.deleted += names.length;
      events.emit("change");
      return respond(res, 200, { success: true, deletedCount: names.length });
    }
    return respond(res, 404, { code: "NOT_FOUND" });
  };
  const server = createServer((req, res) => {
    const operation = handler(req, res).catch((error) => respond(res, error.status ?? 400, { code: error.code ?? "INVALID_REQUEST" }));
    pending.add(operation);
    operation.finally(() => pending.delete(operation));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, credentials, events, snapshot,
    getConfig: () => ({ baseUrl: origin, apiToken: credentials.apiToken, uploadFolder: "e2e" }),
    async setMode(nextMode, next = {}) {
      const response = await fetch(`${origin}/__test/control`, { method: "POST", headers: { Authorization: `Bearer ${credentials.controlToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ mode: nextMode, ...next }) });
      if (!response.ok) throw new Error(`图床测试模式设置失败: HTTP ${response.status}`);
      return response.json();
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      stopping = (async () => {
        for (const controller of delays) controller.abort();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        await Promise.all(pending);
        files.clear();
        storedBytes = 0;
        events.emit("change");
      })();
      return stopping;
    }
  };
}
