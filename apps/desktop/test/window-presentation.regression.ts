import assert from "node:assert/strict";
import { initialWindowLayoutState, reduceWindowLayout, resolveWindowPresentation } from "../src/lib/windowPresentation.ts";

// Restored authentication can arrive before the native resize finishes.
assert.equal(resolveWindowPresentation(true, true, null).mainLayoutReady, false);
assert.equal(resolveWindowPresentation(true, false, null).mainLayoutReady, false);
assert.equal(resolveWindowPresentation(true, true, true).mainLayoutReady, false);
assert.deepEqual(resolveWindowPresentation(true, false, true), { mainLayoutReady: true, windowTransitioning: false });
// Manual login remains on the compact surface until expansion is confirmed.
assert.deepEqual(resolveWindowPresentation(true, false, false), { mainLayoutReady: false, windowTransitioning: true });
// Logout never renders an authenticated dashboard during contraction.
assert.deepEqual(resolveWindowPresentation(false, false, true), { mainLayoutReady: false, windowTransitioning: true });
assert.deepEqual(resolveWindowPresentation(false, false, false), { mainLayoutReady: false, windowTransitioning: false });
console.log("window presentation regression checks passed");

// A failed native resize preserves the gate but exposes an actionable retry state.
let layout = reduceWindowLayout(initialWindowLayoutState, { type: "success", signedIn: false });
layout = reduceWindowLayout(layout, { type: "start" });
layout = reduceWindowLayout(layout, { type: "failure" });
assert.equal(layout.busy, false);
assert.ok(layout.error);
assert.equal(resolveWindowPresentation(true, false, layout.settled).mainLayoutReady, false);
layout = reduceWindowLayout(layout, { type: "start" });
assert.equal(layout.busy, true);
layout = reduceWindowLayout(layout, { type: "success", signedIn: true });
assert.equal(layout.error, null);
assert.equal(resolveWindowPresentation(true, false, layout.settled).mainLayoutReady, true);
console.log("window resize retry regression checks passed");

// Returning to the previous auth state cannot treat an in-flight resize as settled.
let switching = reduceWindowLayout(initialWindowLayoutState, { type: "success", signedIn: false });
switching = reduceWindowLayout(switching, { type: "start" });
assert.equal(switching.settled, null);
assert.deepEqual(resolveWindowPresentation(false, false, switching.settled), { mainLayoutReady: false, windowTransitioning: true });
switching = reduceWindowLayout(switching, { type: "success", signedIn: false });
assert.deepEqual(resolveWindowPresentation(false, false, switching.settled), { mainLayoutReady: false, windowTransitioning: false });
console.log("superseded window transition regression checks passed");
