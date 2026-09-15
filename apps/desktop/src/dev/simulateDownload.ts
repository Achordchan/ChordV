/** Local simulation clock, independent of animation frames and React's render scheduling. */
export type SimulationClock = {
  now: () => number;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (id: number) => void;
};
const browserClock: SimulationClock = {
  now: () => performance.now(),
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: id => window.clearTimeout(id)
};

export function simulateDownload(durationMs: number, initialFraction: number, onProgress: (fraction: number) => void, clock: SimulationClock = browserClock) {
  const startedAt = clock.now();
  const initial = Math.max(0, Math.min(1, initialFraction));
  const duration = Math.max(1, durationMs);
  let active = true;
  let timer: number | undefined;
  const tick = () => {
    if (!active) return;
    const progress = Math.min(1, initial + Math.max(0, clock.now() - startedAt) / duration);
    onProgress(progress);
    if (active && progress < 1) timer = clock.schedule(tick, 50);
  };
  timer = clock.schedule(tick, 50);
  return () => { active = false; if (timer !== undefined) clock.cancel(timer); };
}
