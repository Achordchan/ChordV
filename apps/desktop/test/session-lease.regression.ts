import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProactiveAccessTokenRefreshDelay } from "../src/lib/desktopSessionRecovery";
import { buildProtectedAccessNotice, resolveProtectedAccessReason } from "../src/lib/sessionLeaseState";

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
    /reasonCode === "session_invalid"[\s\S]*?leaseGraceSeconds/,
    "desktop native lease errors must wait for grace before forcing reconnect"
  );
  assert.match(
    appSource,
    /heartbeat_failed[\s\S]*?leaseHeartbeatFailedAtRef|!definitiveInvalid[\s\S]*?leaseHeartbeatFailedAtRef/,
    "transient heartbeat failures should accumulate grace instead of immediate disconnect"
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

  const actionsSource = readFileSync(resolve(import.meta.dirname, "../src/hooks/useRuntimeActions.ts"), "utf8");
  assert.match(
    actionsSource,
    /isSyntheticTicketEvent && !runtimeEvent\.ticketId/,
    "synthetic ticket events without ticketId must be ignored"
  );
}

function main() {
  testResolveProtectedAccessReason();
  testBuildProtectedAccessNotice();
  testResolveProactiveAccessTokenRefreshDelay();
  testNativeLeaseHeartbeatUsesGrace();
  console.log("desktop session lease regression checks passed");
}

main();
