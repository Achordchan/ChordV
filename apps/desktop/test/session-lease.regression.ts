import assert from "node:assert/strict";
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

function main() {
  testResolveProtectedAccessReason();
  testBuildProtectedAccessNotice();
  console.log("desktop session lease regression checks passed");
}

main();
