import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const page = await readFile(new URL("./support-portal.html", import.meta.url));
const script = await readFile(new URL("./support-portal.js", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

async function body(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error("BODY_TOO_LARGE");
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

// A test-only provider, never imported by production code or configuration.
export async function createSupportProvider({ port = 0, now = Date.now, onEvent = async () => {}, nextLaunchDelayMs = 3000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("本机测试端口无效");
  if (!Number.isInteger(nextLaunchDelayMs) || nextLaunchDelayMs < 1 || nextLaunchDelayMs > 5000) throw new Error("测试签发延迟必须为1至5000毫秒");
  const credentials = { clientId: `support-e2e-${token().slice(0, 12)}`, clientSecret: token() };
  const basic = Buffer.from(`Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`);
  const tickets = new Map(), sessions = new Map(), unread = new Map();
  const nextDelays = new Map(), activeDelays = new Set();
  const events = new EventEmitter();
  const counts = { issued: 0, redeemed: 0, replayed: 0, expired: 0, unreadQueries: 0, delayArmed: 0, delayStarted: 0, delayCompleted: 0, delayCancelled: 0, bridge: [] };
  let origin;
  const sockets = new Set();
  const pendingRequests = new Set();
  const respond = (res, status, payload) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };
  const sessionFor = (req) => {
    const cookie = req.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith("support_e2e_session="))?.split("=")[1];
    const session = cookie && sessions.get(hash(cookie));
    return session && session.expiresAt > now() ? { ...session, key: hash(cookie) } : null;
  };
  const authenticate = (req) => {
    const input = Buffer.from(req.headers.authorization ?? "");
    return input.length === basic.length && timingSafeEqual(input, basic);
  };
  const waitLaunchDelay = async (res, milliseconds) => {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", disconnected);
    activeDelays.add(controller);
    counts.delayStarted++;
    events.emit("change");
    try {
      await sleep(milliseconds, undefined, { signal: controller.signal });
      counts.delayCompleted++;
      return !res.destroyed;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      counts.delayCancelled++;
      return false;
    } finally {
      res.off("close", disconnected);
      activeDelays.delete(controller);
      events.emit("change");
    }
  };
  const handler = async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const url = new URL(req.url, origin);
    if (req.headers.origin && req.headers.origin !== origin) return respond(res, 403, { code: "ORIGIN_MISMATCH" });
    if (req.method === "POST" && url.pathname === "/api/v1/integrations/universal/launch-tickets") {
      if (!authenticate(req)) return respond(res, 401, { code: "INVALID_CLIENT" });
      const input = await body(req);
      if (typeof input.user?.id !== "string" || !input.user.id || input.context?.launchMode !== "native") return respond(res, 422, { code: "INVALID_CONTACT" });
      const delayed = nextDelays.get(input.user.id);
      nextDelays.delete(input.user.id);
      if (delayed && !await waitLaunchDelay(res, delayed)) return;
      const value = token(), expiresAt = now() + 60000;
      tickets.set(hash(value), { user: { id: input.user.id, name: input.user.name }, expiresAt, consumed: false });
      counts.issued++;
      events.emit("change");
      return respond(res, 200, { data: { launchUrl: `${origin}/launch#ticket=${value}`, expiresAt: new Date(expiresAt).toISOString() } });
    }
    if (req.method === "GET" && /^\/api\/v1\/integrations\/universal\/contacts\/[^/]+\/unread$/.test(url.pathname)) {
      if (!authenticate(req)) return respond(res, 401, { code: "INVALID_CLIENT" });
      const userId = decodeURIComponent(url.pathname.split("/").at(-2));
      counts.unreadQueries++;
      return respond(res, 200, { data: { unreadCount: unread.get(userId) ?? 0 } });
    }
    if (req.method === "POST" && url.pathname === "/api/session/redeem") {
      const input = await body(req);
      const ticket = typeof input.ticket === "string" && tickets.get(hash(input.ticket));
      if (!ticket) return respond(res, 401, { code: "UNKNOWN_TICKET" });
      if (ticket.consumed) { counts.replayed++; return respond(res, 410, { code: "TICKET_ALREADY_USED" }); }
      if (ticket.expiresAt <= now()) { counts.expired++; return respond(res, 410, { code: "TICKET_EXPIRED" }); }
      ticket.consumed = true;
      const value = token();
      sessions.set(hash(value), { user: ticket.user, expiresAt: now() + 15 * 60000 });
      counts.redeemed++;
      res.setHeader("Set-Cookie", `support_e2e_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`);
      events.emit("change");
      return respond(res, 200, { data: { user: ticket.user, unreadCount: unread.get(ticket.user.id) ?? 0 } });
    }
    if (req.method === "GET" && url.pathname === "/api/session") {
      const session = sessionFor(req);
      return session ? respond(res, 200, { data: { user: session.user, unreadCount: unread.get(session.user.id) ?? 0 } }) : respond(res, 401, { code: "SESSION_EXPIRED" });
    }
    if (req.method === "POST" && url.pathname === "/api/session/next-launch-delay") {
      const session = sessionFor(req);
      if (!session) return respond(res, 401, { code: "SESSION_EXPIRED" });
      const input = await body(req);
      if (Object.keys(input).length !== 0) return respond(res, 422, { code: "DELAY_IS_FIXED_BY_TEST" });
      nextDelays.set(session.user.id, nextLaunchDelayMs);
      counts.delayArmed++;
      events.emit("change");
      return respond(res, 200, { data: { delayMs: nextLaunchDelayMs, appliesTo: "next-launch-for-this-contact" } });
    }
    if (req.method === "POST" && url.pathname === "/api/session/bridge") {
      const session = sessionFor(req);
      if (!session) return respond(res, 401, { code: "SESSION_EXPIRED" });
      const input = await body(req);
      if (!["ready", "unread-changed", "session-expired", "close-requested"].includes(input.type)) return respond(res, 422, { code: "INVALID_EVENT" });
      if (input.type === "unread-changed") {
        if (!Number.isInteger(input.unreadCount) || input.unreadCount < 0 || input.unreadCount > 99999) return respond(res, 422, { code: "INVALID_UNREAD" });
        unread.set(session.user.id, input.unreadCount);
      }
      await onEvent({ userId: session.user.id, type: input.type, unreadCount: input.unreadCount });
      counts.bridge.push({ type: input.type, ...(input.type === "unread-changed" ? { unreadCount: input.unreadCount } : {}) });
      if (input.type === "session-expired") {
        sessions.delete(session.key);
        res.setHeader("Set-Cookie", "support_e2e_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      }
      events.emit("change");
      return respond(res, 200, { data: { ok: true } });
    }
    if (req.method === "GET" && ["/launch", "/portal"].includes(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/portal.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(script);
    }
    return respond(res, 404, { code: "NOT_FOUND" });
  };
  const server = createServer((req, res) => {
    const operation = handler(req, res).catch(() => { if (res.destroyed) return; if (!res.headersSent) respond(res, 400, { code: "INVALID_REQUEST" }); else res.end(); });
    pendingRequests.add(operation);
    operation.then(() => pendingRequests.delete(operation), () => pendingRequests.delete(operation));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, credentials, events,
    snapshot: () => structuredClone({ ...counts, pendingDelays: activeDelays.size }),
    async stop() { for (const controller of activeDelays) controller.abort(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); await Promise.all(pendingRequests); tickets.clear(); sessions.clear(); nextDelays.clear(); }
  };
}
