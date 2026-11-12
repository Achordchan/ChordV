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

/** The native downloader's message when a mirror stays under the minimum speed. */
export const SLOW_MIRROR_MARKER = "download too slow on this mirror";

export function isSlowMirrorRejection(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  return message.includes(SLOW_MIRROR_MARKER);
}

/**
 * Tries each URL with the minimum-speed guard, so a slow source gives way while
 * others remain. If every URL fails, the sources rejected only for being slow
 * are retried without the guard: a slow download beats no download.
 */
export async function downloadWithMirrorFallback(
  urls: string[],
  attempt: (url: string, minBytesPerSecond: number | null) => Promise<unknown>,
  shouldStop: (reason: unknown) => boolean = () => false
) {
  let lastError: unknown = new Error("没有可用下载地址");
  const slow: string[] = [];
  for (const [index, url] of urls.entries()) {
    try {
      await attempt(url, minimumSpeedForAttempt(index, urls.length));
      return url;
    } catch (reason) {
      if (shouldStop(reason)) throw reason;
      if (isSlowMirrorRejection(reason)) slow.push(url);
      lastError = reason;
    }
  }
  for (const url of slow) {
    try {
      await attempt(url, null);
      return url;
    } catch (reason) {
      if (shouldStop(reason)) throw reason;
      lastError = reason;
    }
  }
  throw lastError;
}
