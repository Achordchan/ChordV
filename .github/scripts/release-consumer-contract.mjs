export function assertConsumerFields(kind, { version, minimumVersion, changelog }) {
  if (kind !== "desktop") return;
  for (const value of [version, minimumVersion]) {
    const numbers = value.split(/[+-]/, 1)[0].split(".");
    if (numbers.some(number => BigInt(number) > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error("Desktop consumer version fields must be safe integers");
  }
  if (!Array.isArray(changelog) || !changelog.every(line => typeof line === "string" && line.length <= 4000)) throw new Error("Desktop consumer changelog entries must be strings of at most 4000 characters");
}
export function assertConsumerBody(kind, body) {
  if (kind === "desktop" && Buffer.byteLength(body) > 1024 * 1024) throw new Error("Desktop consumer manifest exceeds the one MiB byte limit");
}
