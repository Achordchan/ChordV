/**
 * What a node may serve on its own word while the control plane cannot be
 * reached.
 *
 * A node keeps serving from its last known configuration when the control plane
 * is unreachable, and meters into a local queue. The offline allowance is the
 * per-user, per-node cap on that: once a user has moved this many bytes with
 * nothing acknowledged, the agent disables them locally and only takes them
 * back when the control plane has seen the whole queue.
 *
 * It was 64 MiB, a figure chosen when the only question was "how much may go
 * unbilled". That is a few minutes of video, so in practice it meant every
 * active user was cut off within minutes of ANY control-plane outage — a
 * restart for an upgrade included — which is the opposite of what running on
 * cached configuration is for.
 *
 * The cap is not what protects the quota: the agent also counts every byte
 * against the user's remaining quota locally and stops at zero whatever the
 * allowance is. What the allowance bounds is the exposure the local count
 * cannot see — a user spending the same quota on several nodes at once, and a
 * revocation that could not be delivered. The default trades that for riding
 * out an outage of a day or so at ordinary usage.
 */
export const DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES = 10n * 1024n * 1024n * 1024n;

/**
 * Reads CHORDV_AGENT_OFFLINE_ALLOWANCE_BYTES: a positive decimal integer of
 * bytes. Anything else — empty, zero, negative, a unit suffix — falls back to
 * the default rather than failing startup or, worse, being sent to the agents:
 * a zero allowance would disable every user the moment a heartbeat failed.
 */
export function resolveAgentOfflineAllowanceBytes(
  raw: string | undefined,
  warn: (message: string) => void = () => undefined
): bigint {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES;
  if (!/^[1-9]\d*$/.test(value)) {
    warn(
      `CHORDV_AGENT_OFFLINE_ALLOWANCE_BYTES="${value}" 不是正整数字节数，已改用默认值 ${DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES}`
    );
    return DEFAULT_AGENT_OFFLINE_ALLOWANCE_BYTES;
  }
  return BigInt(value);
}

/**
 * Read once at load, like the session lease settings: every payload this
 * process builds — ENSURE_USER commands and config snapshots alike — must name
 * the same figure, or an agent would see its allowance flip between the two.
 */
export const AGENT_OFFLINE_ALLOWANCE_BYTES = resolveAgentOfflineAllowanceBytes(
  process.env.CHORDV_AGENT_OFFLINE_ALLOWANCE_BYTES,
  (message) => console.warn(message)
);
