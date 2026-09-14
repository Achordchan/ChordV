import assert from "node:assert/strict";
import { initialUpdateCheckState, reduceUpdateCheckState } from "../src/lib/updateCheckState.ts";
import { shouldReportNodeAccessRevoked } from "../src/lib/startupReadiness.ts";
import type { ClientUpdateCheckResult } from "../src/api/client.ts";

// Simulate a slow first response: neither the pending nor failed state invents policy.
let state = reduceUpdateCheckState(initialUpdateCheckState, { type: "checking" });
assert.equal(state.status, "checking");
assert.equal(state.result, null);
state = reduceUpdateCheckState(state, { type: "failed" });
assert.equal(state.status, "failed");
assert.equal(state.result, null);

// A transient retry failure must not silently remove a confirmed mandatory update.
const required = { forceUpgrade: true, minimumVersion: "1.2.0" } as ClientUpdateCheckResult;
state = reduceUpdateCheckState(state, { type: "confirmed", result: required });
state = reduceUpdateCheckState(state, { type: "checking" });
state = reduceUpdateCheckState(state, { type: "failed" });
assert.equal(state.result, required);
const current = { forceUpgrade: false, minimumVersion: "1.0.0", hasUpdate: false } as ClientUpdateCheckResult;
state = reduceUpdateCheckState(state, { type: "confirmed", result: current });
assert.equal(state.status, "ready");
assert.equal(state.result?.forceUpgrade, false);
assert.deepEqual(reduceUpdateCheckState(state, { type: "reset" }), initialUpdateCheckState);

const loading = { booting: true, sessionReady: false, bootstrapReady: false, activeNodeId: "active", nodes: [] };
assert.equal(shouldReportNodeAccessRevoked(loading), false);
assert.equal(shouldReportNodeAccessRevoked({ ...loading, sessionReady: true }), false);
assert.equal(shouldReportNodeAccessRevoked({ ...loading, booting: false, sessionReady: true }), false);
const loaded = { ...loading, booting: false, sessionReady: true, bootstrapReady: true };
assert.equal(shouldReportNodeAccessRevoked({ ...loaded, nodes: [{ id: "active" }] }), false);
assert.equal(shouldReportNodeAccessRevoked(loaded), true, "a confirmed empty list still enforces revocation");
console.log("startup readiness regression checks passed");
