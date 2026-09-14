import assert from "node:assert/strict";
import { resolveWindowPresentation } from "../src/lib/windowPresentation.ts";

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
