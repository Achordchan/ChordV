import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProactiveAccessTokenRefreshDelay } from "../src/lib/desktopSessionRecovery";
import {
  buildProtectedAccessNotice,
  hasLeaseSilenceRunOut,
  isDefinitiveLeaseFailure,
  resolveLeaseSilenceToleranceMs,
  resolveProtectedAccessReason
} from "../src/lib/sessionLeaseState";

function testResolveProtectedAccessReason() {
  assert.equal(resolveProtectedAccessReason("当前账号已禁用，会话已失效"), "account_disabled");
  assert.equal(resolveProtectedAccessReason("当前成员已失去团队访问权限，会话已失效"), "team_access_revoked");
  assert.equal(resolveProtectedAccessReason("当前连接已过期，请重新连接"), null);
}

function testBuildProtectedAccessNotice() {
  assert.deepEqual(buildProtectedAccessNotice("account_disabled"), {
    title: "账号已禁用",
    message: "当前账号已被管理员禁用，请联系管理员处理。"
  });
  assert.deepEqual(buildProtectedAccessNotice("team_access_revoked"), {
    title: "你已被移出团队",
    message: "当前账号已失去团队订阅，请重新登录或联系管理员处理。"
  });
}

function testResolveProactiveAccessTokenRefreshDelay() {
  const now = Date.parse("2026-06-30T02:00:00.000Z");
  assert.equal(
    resolveProactiveAccessTokenRefreshDelay(
      {
        refreshToken: "refresh",
        accessTokenExpiresAt: "2026-06-30T02:15:00.000Z"
      },
      now
    ),
    13 * 60 * 1000
  );
  assert.equal(
    resolveProactiveAccessTokenRefreshDelay(
      {
        refreshToken: "refresh",
        accessTokenExpiresAt: "2026-06-30T02:01:00.000Z"
      },
      now
    ),
    0
  );
  assert.equal(
    resolveProactiveAccessTokenRefreshDelay(
      {
        refreshToken: "",
        accessTokenExpiresAt: "2026-06-30T02:15:00.000Z"
      },
      now
    ),
    null
  );
}


function testNativeLeaseHeartbeatUsesGrace() {
  const appSource = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
  assert.match(
    appSource,
    /if \(!isDefinitiveLeaseFailure\(event\.reasonCode\)\) \{[\s\S]*?hasLeaseSilenceRunOut\(leaseHeartbeatFailedAtRef\.current, nowMs, runtimeRef\.current\)/,
    "desktop native lease errors that are not an answer must be waited out, by the lease's own tolerance"
  );
  assert.match(
    appSource,
    /heartbeat_failed[\s\S]*?leaseHeartbeatFailedAtRef/,
    "transient heartbeat failures should accumulate grace instead of immediate disconnect"
  );
  // The window between "first failure" and "give up" is decided in one place.
  // An inline grace here is how the client came to drop every connection five
  // minutes into any control-plane outage.
  const nativeHandler = appSource.slice(
    appSource.indexOf("subscribeNativeLeaseHeartbeat((event)"),
    appSource.indexOf("subscribeNativeSessionRefreshed((nextSession)")
  );
  assert.ok(nativeHandler.length > 0, "native lease heartbeat handler not found");
  assert.doesNotMatch(
    nativeHandler,
    /leaseGraceSeconds/,
    "the native heartbeat handler must not compute its own grace window"
  );
  assert.match(
    appSource,
    /if \(!leaseHeartbeatFailedAtRef\.current\) {[\s\S]*?leaseHeartbeatFailedAtRef\.current = nowMs;[\s\S]*?return;/,
    "first transient lease failure should only start the grace window"
  );

  const clientSource = readFileSync(resolve(import.meta.dirname, "../src/api/client.ts"), "utf8");
  assert.doesNotMatch(
    clientSource,
    /createClientRuntimeFallbackRefreshEventTypes[\s\S]*?"ticket_updated"/,
    "SSE fallback refresh must not synthesize ticket_updated polls"
  );

  assert.doesNotMatch(
    clientSource,
    /createClientRuntimeFallbackRefreshEventTypes\([^)]*\)[^{]*\{[^}]*"support_unread_updated"/,
    "SSE fallback refresh must not synthesize support unread polls"
  );
}

function testLeaseSilenceTolerance() {
  const minute = 60 * 1000;
  // A control plane that predates the hold: the grace alone, as before.
  assert.equal(resolveLeaseSilenceToleranceMs({ leaseGraceSeconds: 300 }), 5 * minute);
  assert.equal(resolveLeaseSilenceToleranceMs({ leaseGraceSeconds: 300, leaseOfflineHoldSeconds: null }), 5 * minute);
  // A hold of 0 is the control plane turning it off, not a missing value.
  assert.equal(resolveLeaseSilenceToleranceMs({ leaseGraceSeconds: 300, leaseOfflineHoldSeconds: 0 }), 5 * minute);
  // With a hold, the connection outlives the outage.
  assert.equal(
    resolveLeaseSilenceToleranceMs({ leaseGraceSeconds: 300, leaseOfflineHoldSeconds: 86400 }),
    (300 + 86400) * 1000
  );
  // The existing floor and default for the grace are kept.
  assert.equal(resolveLeaseSilenceToleranceMs({ leaseGraceSeconds: 5 }), 30 * 1000);
  assert.equal(resolveLeaseSilenceToleranceMs(null), 5 * minute);
  assert.equal(resolveLeaseSilenceToleranceMs(undefined), 5 * minute);
  assert.equal(resolveLeaseSilenceToleranceMs({}), 5 * minute);
  // Garbage must not become "never give up" or "give up at once".
  assert.equal(resolveLeaseSilenceToleranceMs({ leaseGraceSeconds: Number.NaN, leaseOfflineHoldSeconds: Number.NaN }), 5 * minute);
  assert.equal(
    resolveLeaseSilenceToleranceMs({ leaseGraceSeconds: 300, leaseOfflineHoldSeconds: Number.POSITIVE_INFINITY }),
    5 * minute
  );
  assert.equal(resolveLeaseSilenceToleranceMs({ leaseGraceSeconds: 300, leaseOfflineHoldSeconds: -60 }), 5 * minute);

  const policy = { leaseGraceSeconds: 300, leaseOfflineHoldSeconds: 3600 };
  const start = Date.parse("2026-11-26T04:00:00.000Z");
  assert.equal(hasLeaseSilenceRunOut(start, start, policy), false);
  // Six minutes in is past the old five-minute cutoff and must still hold.
  assert.equal(hasLeaseSilenceRunOut(start, start + 6 * minute, policy), false);
  assert.equal(hasLeaseSilenceRunOut(start, start + 3900 * 1000 - 1, policy), false);
  assert.equal(hasLeaseSilenceRunOut(start, start + 3900 * 1000, policy), true);
  assert.equal(hasLeaseSilenceRunOut(start, start + 6 * minute, { leaseGraceSeconds: 300 }), true);
  // The system clock stepping backwards is not elapsed time.
  assert.equal(hasLeaseSilenceRunOut(start, start - 24 * 60 * minute, policy), false);

  // Only an ANSWER ends the session at once. The native loop reports 403/404
  // as session_invalid; anything it could not get an answer for — and any
  // reason this build has never heard of — is silence.
  assert.equal(isDefinitiveLeaseFailure("session_invalid"), true);
  assert.equal(isDefinitiveLeaseFailure("session_expired"), true);
  assert.equal(isDefinitiveLeaseFailure("session_replaced"), true);
  assert.equal(isDefinitiveLeaseFailure("heartbeat_failed"), false);
  assert.equal(isDefinitiveLeaseFailure("auth_invalid"), false);
  assert.equal(isDefinitiveLeaseFailure("something_new"), false);
  assert.equal(isDefinitiveLeaseFailure(null), false);
  assert.equal(isDefinitiveLeaseFailure(undefined), false);
}

function testNativeRuntimeConfigKeepsTheOfflineHold() {
  // The native side stores the runtime config and hands it back to the window.
  // serde drops fields a struct does not declare, so without this one a window
  // reload during an outage would fall back to the five-minute grace.
  const nativeSource = readFileSync(resolve(import.meta.dirname, "../src-tauri/src/lib.rs"), "utf8");
  const start = nativeSource.indexOf("struct GeneratedRuntimeConfigDto {");
  assert.ok(start >= 0, "GeneratedRuntimeConfigDto not found");
  const struct = nativeSource.slice(start, nativeSource.indexOf("\n}", start));
  assert.match(
    struct,
    /#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*lease_offline_hold_seconds: Option<u64>,/,
    "the native runtime config must carry leaseOfflineHoldSeconds, and tolerate its absence"
  );

  const actionsSource = readFileSync(resolve(import.meta.dirname, "../src/hooks/useRuntimeActions.ts"), "utf8");
  assert.match(
    actionsSource,
    /leaseGraceSeconds: lease\.leaseGraceSeconds,\s*leaseOfflineHoldSeconds: lease\.leaseOfflineHoldSeconds/,
    "a foreground sync must refresh the offline hold together with the rest of the lease"
  );
}

function main() {
  testLeaseSilenceTolerance();
  testNativeRuntimeConfigKeepsTheOfflineHold();
  testResolveProtectedAccessReason();
  testBuildProtectedAccessNotice();
  testResolveProactiveAccessTokenRefreshDelay();
  testNativeLeaseHeartbeatUsesGrace();
  console.log("desktop session lease regression checks passed");
}

main();
