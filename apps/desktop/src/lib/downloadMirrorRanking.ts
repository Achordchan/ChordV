export type DownloadProbeResult = {
  url: string;
  ok: boolean;
  bytesReceived: number;
  bytesPerSecond: number;
  elapsedMs: number;
  error: string | null;
};

/** A mirror slower than this (after a short grace period) is abandoned while others remain. */
export const MIN_MIRROR_BYTES_PER_SECOND = 64 * 1024;
/** GEO files share the same mirrors, so one measurement serves both downloads of an update. */
export const MIRROR_RANKING_TTL_MS = 10 * 60 * 1000;

type HostRanking = { speeds: Map<string, number>; measuredAt: number };

let cachedRanking: HostRanking | null = null;

export function resetMirrorRankingCacheForTest() {
  cachedRanking = null;
}

function hostKey(url: string) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

export function rememberProbeResults(results: DownloadProbeResult[], nowMs = Date.now()) {
  const speeds = new Map(cachedRanking && nowMs - cachedRanking.measuredAt < MIRROR_RANKING_TTL_MS ? cachedRanking.speeds : []);
  for (const result of results) {
    speeds.set(hostKey(result.url), result.ok ? result.bytesPerSecond : -1);
  }
  cachedRanking = { speeds, measuredAt: nowMs };
}

/** Hosts this list needs that have no fresh measurement yet. */
export function urlsNeedingProbe(urls: string[], nowMs = Date.now()) {
  if (!cachedRanking || nowMs - cachedRanking.measuredAt >= MIRROR_RANKING_TTL_MS) {
    return urls;
  }
  const speeds = cachedRanking.speeds;
  return urls.filter((url) => !speeds.has(hostKey(url)));
}

/**
 * Fastest measured host first, unmeasured hosts after the measured working ones,
 * failed hosts last. Ties keep the server's order, which already puts the
 * administrator's mirrors before GitHub and the server copy.
 */
export function rankDownloadUrls(urls: string[], nowMs = Date.now()) {
  const speeds = cachedRanking && nowMs - cachedRanking.measuredAt < MIRROR_RANKING_TTL_MS ? cachedRanking.speeds : new Map<string, number>();
  const score = (url: string) => {
    const speed = speeds.get(hostKey(url));
    if (speed === undefined) return 0;
    return speed < 0 ? -1 : speed + 1;
  };
  return urls
    .map((url, index) => ({ url, index, score: score(url) }))
    .sort((left, right) => {
      const leftBucket = left.score > 0 ? 0 : left.score === 0 ? 1 : 2;
      const rightBucket = right.score > 0 ? 0 : right.score === 0 ? 1 : 2;
      if (leftBucket !== rightBucket) return leftBucket - rightBucket;
      if (leftBucket === 0 && right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .map((item) => item.url);
}

/** Only the last remaining URL is allowed to be slow; earlier ones give way to the next mirror. */
export function minimumSpeedForAttempt(index: number, total: number) {
  return index < total - 1 ? MIN_MIRROR_BYTES_PER_SECOND : null;
}
