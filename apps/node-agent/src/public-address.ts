import { isIP } from 'node:net';

/**
 * Mirrors the control plane's address policy (apps/api/.../agent-inbound.ts).
 * The server stays the authority — this copy exists so a bad address fails the
 * command with a message naming the value, instead of surfacing later as an API
 * rejection the operator has to correlate back to a deployment.
 *
 * The comparison is on parsed BYTES: `0:0:0:0:0:0:0:1` is loopback spelled the
 * long way, and `::ffff:192.168.1.1` is a private IPv4 in IPv6 clothing.
 */
export function parseIPv6Bytes(value: string): number[] | null {
  const host = value.trim().replace(/^\[|\]$/g, '');
  if (isIP(host) !== 6) return null;
  const [head, tail] = host.split('::') as [string, string | undefined];
  const expand = (part: string): number[] => {
    if (!part) return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      if (piece.includes('.')) {
        for (const octet of piece.split('.')) groups.push(Number(octet));
        continue;
      }
      const word = Number.parseInt(piece, 16);
      groups.push(word >> 8, word & 0xff);
    }
    return groups;
  };
  const front = expand(head);
  const back = tail === undefined ? [] : expand(tail);
  const missing = 16 - front.length - back.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  return [...front, ...new Array(missing).fill(0), ...back];
}

function isPublicIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

export function isPublicUnicastAddress(host: string): boolean {
  const trimmed = host.trim().replace(/^\[|\]$/g, '');
  const family = isIP(trimmed);
  if (family === 4) return isPublicIPv4(trimmed.split('.').map(Number));
  if (family !== 6) return false;
  const bytes = parseIPv6Bytes(host);
  if (!bytes) return false;
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIPv4(bytes.slice(12));
  }
  if (bytes.every((byte) => byte === 0)) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return false;
  if ((bytes[0] & 0xfe) === 0xfc) return false;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;
  if (bytes[0] === 0xff) return false;
  return true;
}
