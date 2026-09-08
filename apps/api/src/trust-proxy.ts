/**
 * Whose X-Forwarded-For entries this API may trust, as an express/proxy-addr
 * setting. The supplied deployment chains TWO proxies in front of the api
 * (openresty terminating TLS → the admin container's nginx → api), each
 * appending to the chain, so the address a node agent dialed from is TWO
 * entries away from the socket. Trusting a single hop resolved `request.ip`
 * to the openresty-side address: `whoami` then returned a private bridge
 * address and ENSURE_INBOUND failed its public-address check — or worse,
 * published the proxy host's own public address as the node's.
 *
 * The default trusts exactly the private perimeter (loopback, private and
 * CGNAT ranges, link-local): every proxy in that topology lives there, and
 * agents dial in from public addresses — the walk stops at the first public
 * address, so an agent cannot push its own forged entries past the entries
 * the proxies legitimately appended. Topologies differ per deployment, so
 * CHORDV_API_TRUSTED_PROXIES narrows or replaces the list (comma-separated
 * proxy-addr terms); "false" trusts nothing but the socket.
 */
export const DEFAULT_TRUSTED_PROXIES = [
  "loopback",
  "linklocal",
  "uniquelocal",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10"
].join(",");

export function resolveTrustProxy(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env.CHORDV_API_TRUSTED_PROXIES?.trim();
  if (!value) return DEFAULT_TRUSTED_PROXIES;
  if (value.toLowerCase() === "false" || value.toLowerCase() === "none") return undefined;
  return value;
}
