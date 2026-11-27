// The edge half of subscription links: answers a client's refresh from the
// key-value store, so links keep working while the ChordV API is down.
//
// It returns text and nothing else. It never proxies traffic, never calls the
// API, never lists keys and never logs a request: the token in the path is the
// credential, and the only thing this file does with it is hash it.

/** A link is /s/<token>; the token is 32 random bytes in base64url. */
const LINK_PATH = /^\/s\/([A-Za-z0-9_-]{43})$/;

/** Hours between a client's automatic refreshes. Keep equal to the API's SUBSCRIPTION_LINK_UPDATE_INTERVAL_HOURS. */
export const UPDATE_INTERVAL_HOURS = 6;

/** Keep equal to the API's SUBSCRIPTION_LINK_INVALID_NOTICE (a test in apps/api holds the two together). */
export const INVALID_NOTICE = "订阅链接无效或已重置，请联系客服获取新链接";

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The status line the invalid-link answer carries. */
export const INVALID_STATUS = `⚠️ ${INVALID_NOTICE}`;

/**
 * Shadowrocket shows a leading `STATUS=` line of the decoded body on the
 * subscription card, in place of its own reading of `subscription-userinfo`.
 * Other clients would take that line for a broken node, so only Shadowrocket
 * gets it. A body that does not decode is served as stored.
 */
export function withStatus(body, status, userAgent) {
  if (!status || !/shadowrocket/i.test(userAgent ?? "")) return body;
  let text;
  try {
    text = unbase64(body);
  } catch {
    return body;
  }
  return base64(`STATUS=${status}\n${text}`);
}

/**
 * What an unknown token gets: one placeholder entry that cannot carry traffic
 * and whose name says the link is no good. A token that was reset and a token
 * that never existed are the same miss in the store, so they get the same
 * bytes — and an empty list is avoided because clients treat it as a failed
 * refresh and keep the nodes they have.
 */
export const INVALID_BODY = base64(
  `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:9?encryption=none&security=none&type=tcp&headerType=none#${encodeURIComponent(INVALID_NOTICE)}`
);

export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function plain(status, text, extra = {}) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra }
  });
}

function subscription(body, userinfo, method) {
  const headers = {
    "content-type": "text/plain; charset=utf-8",
    // A link is a credential and its content changes; nothing in between may keep a copy.
    "cache-control": "no-store",
    "profile-update-interval": String(UPDATE_INTERVAL_HOURS),
    "x-robots-tag": "noindex",
    // The body depends on the client (see withStatus).
    vary: "user-agent"
  };
  if (userinfo) headers["subscription-userinfo"] = userinfo;
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}

/** Parses a stored document; null for anything this version does not understand. */
function readDocument(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || value.v !== 1) return null;
  if (typeof value.body !== "string" || value.body === "") return null;
  if (value.userinfo !== null && typeof value.userinfo !== "string") return null;
  // A header value must stay on one line.
  if (typeof value.userinfo === "string" && /[\r\n]/.test(value.userinfo)) return null;
  // Optional: documents published before it existed have none. It becomes a
  // line of the body, so it too must stay on one line.
  const status = value.status ?? null;
  if (status !== null && (typeof status !== "string" || /[\r\n]/.test(status))) return null;
  return { body: value.body, userinfo: value.userinfo, status };
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "Method Not Allowed", { allow: "GET, HEAD" });
    }
    const match = LINK_PATH.exec(new URL(request.url).pathname);
    if (!match) return plain(404, "Not Found");

    let raw;
    try {
      raw = await env.LINKS.get(await hashToken(match[1]));
    } catch {
      // The store is unreachable. Say so with an error status: a client that
      // fails to refresh keeps the nodes it has, which is right — telling it
      // "this link is invalid" would take a paying user's nodes away.
      return plain(503, "Service Unavailable", { "retry-after": "60" });
    }
    const userAgent = request.headers.get("user-agent");
    if (raw === null || raw === undefined) {
      return subscription(withStatus(INVALID_BODY, INVALID_STATUS, userAgent), null, request.method);
    }

    const document = readDocument(raw);
    // Something is stored for this token but it is not readable by this
    // version. That is our fault, not the user's: fail the refresh rather
    // than replace their nodes with a notice.
    if (!document) return plain(503, "Service Unavailable", { "retry-after": "60" });
    return subscription(withStatus(document.body, document.status, userAgent), document.userinfo, request.method);
  }
};
