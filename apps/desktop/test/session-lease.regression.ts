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


function testNativeLeaseHeartbeatOwnership() {
  const appSource = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
  assert.match(appSource, /classifyNativeLeaseHeartbeat\(event, activeSessionId\)/);
  assert.match(appSource, /decision === "ignore" \|\| decision === "transient"\) return/,
    "Native临时失败不得由界面另计宽限或判停，行为用lease-heartbeat回归及完整App浏览器覆盖");
  const nativeEffect = appSource.slice(appSource.indexOf("void subscribeNativeLeaseHeartbeat"), appSource.indexOf("void subscribeNativeSessionRefreshed"));
  assert.doesNotMatch(nativeEffect, /leaseHeartbeatFailedAtRef|definitiveInvalid|leaseGraceSeconds/,
    "旧桌面双重判停状态必须移除");
  const clientSource = readFileSync(resolve(import.meta.dirname, "../src/api/client-events.ts"), "utf8");
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

function main() {
  testResolveProtectedAccessReason();
  testBuildProtectedAccessNotice();
  testResolveProactiveAccessTokenRefreshDelay();
  testNativeLeaseHeartbeatOwnership();
  console.log("desktop session lease regression checks passed");
}

main();
