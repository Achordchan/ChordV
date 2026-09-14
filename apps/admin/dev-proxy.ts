import type { IncomingMessage } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Only adapt the admin refresh cookie for an HTTP loopback development hop.
 * Keep production responses and all other cookies untouched. */
export function adaptLoopbackRefreshCookie(response: IncomingMessage, request: IncomingMessage) {
  if (!LOOPBACK.has(request.socket.localAddress ?? "") || !LOOPBACK.has(request.socket.remoteAddress ?? "")) return;
  if ((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted) return;
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? "")) return;
  const cookies = response.headers["set-cookie"];
  if (!cookies) return;
  response.headers["set-cookie"] = cookies.map(cookie => {
    if (!cookie.startsWith("chordv_admin_refresh=")) return cookie;
    return cookie.split(";").filter((part, index) => index === 0 || !/^\s*(?:secure\s*$|domain\s*=)/i.test(part))
      .map(part => /^\s*samesite\s*=\s*none\s*$/i.test(part) ? " SameSite=Lax" : part).join(";");
  });
}
