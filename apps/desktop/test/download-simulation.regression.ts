import assert from "node:assert/strict";
import { simulateDownload, type SimulationClock } from "../src/dev/simulateDownload";
let now = 0, nextId = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
const clock: SimulationClock = {
  now: () => now,
  schedule: (callback, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
  cancel: id => { timers.delete(id); }
};
function advance(ms: number) {
  const end = now + ms;
  while (true) {
    const next = [...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
    if (!next) break;
    now = next[1].at; timers.delete(next[0]); next[1].callback();
  }
  now = end;
}
const samples: number[] = [];
let stop = simulateDownload(5000, 0, fraction=>samples.push(fraction), clock);
advance(1000);
assert.equal(samples.at(-1), 0.2);
assert.equal(samples.length, 20, "5 second playback must publish intermediate frames before pausing");
advance(1000);
assert.equal(samples.at(-1), 0.4);
stop();
const count = samples.length;
advance(1000);
assert.equal(samples.length, count);
stop = simulateDownload(5000, 0, fraction=>samples.push(fraction), clock);
advance(50);
assert.equal(samples.at(-1), 0.01, "replay starts a fresh clock");
advance(4950);
assert.equal(samples.at(-1), 1);
assert.equal(timers.size, 0, "completed playback must stop scheduling");
stop();
// Resume from a manually selected 40%: retain speed, so the remaining 60% takes 3 seconds.
const resumed: number[] = [];
stop = simulateDownload(5000, 0.4, fraction=>resumed.push(fraction), clock);
advance(1000);
assert.ok(Math.abs(resumed.at(-1)! - 0.6) < 1e-10);
stop();
const paused = resumed.at(-1)!;
advance(2000);
assert.equal(resumed.at(-1), paused);
stop = simulateDownload(5000, paused, fraction=>resumed.push(fraction), clock);
advance(1950);
assert.ok(resumed.at(-1)! < 1);
advance(50);
assert.equal(resumed.at(-1), 1);
assert.equal(timers.size, 0);
stop();
console.log("intermediate updates, pause, replay, resume and timer cleanup passed");
