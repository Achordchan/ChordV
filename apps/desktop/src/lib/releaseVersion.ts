export type ParsedSemver = { major: number; minor: number; patch: number; prerelease: string[] };

export function parseSemver(version: string): ParsedSemver | null {
  const match = version.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease };
}

export function compareVersion(left: string, right: string) {
  const a = parseSemver(left), b = parseSemver(right);
  if (!a || !b) return left.localeCompare(right);
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) return a[field] > b[field] ? 1 : -1;
  }
  if (!a.prerelease.length && b.prerelease.length) return 1;
  if (a.prerelease.length && !b.prerelease.length) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return x.length === y.length ? (x > y ? 1 : -1) : (x.length > y.length ? 1 : -1);
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
