import assert from "node:assert/strict";
import { test } from "node:test";
import { requiredMacRecoveryTests, verifyMacRecoveryLog } from "./mygo-verify-mac-recovery-log.mjs";

const native = "github.com/Achordchan/ChordV/apps/desktop/native";
const row = (action, test, packageName = native) => ({ Package: packageName, Action: action, Test: test });
const body = () => requiredMacRecoveryTests.flatMap(name => [row("run", name), row("pass", name)]);
const encode = rows => rows.map(event => JSON.stringify(event)).join("\n");

test("macOS release gate requires the real native package to run and pass every recovery case", () => {
  assert.equal(verifyMacRecoveryLog(encode([...body(), row("run", "TestOptionalExternalFixture"), row("skip", "TestOptionalExternalFixture"), row("pass")])), requiredMacRecoveryTests.length);
  const logs = body();
  logs[0] = row("run", requiredMacRecoveryTests[0], "another/package");
  assert.throws(() => verifyMacRecoveryLog(encode([...logs, row("pass")])), /必须执行并通过/);
});

test("macOS release gate rejects a skipped, absent, or duplicated recovery case", () => {
  const name = requiredMacRecoveryTests[0], [start, , ...other] = body();
  for (const [actions, expected] of [
    [[row("skip", name)], /必须执行并通过/],
    [[], /必须执行并通过/],
    [[row("pass", name), row("pass", name)], /结果重复/]
  ]) {
    assert.throws(() => verifyMacRecoveryLog(encode([start, ...actions, ...other, row("pass")])), expected);
  }
});

test("individual passes are not a successful native package result", () => {
  for (const terminal of [[], [row("fail")], [row("pass"), row("pass")], [row("pass", undefined, "another/package")]]) {
    assert.throws(() => verifyMacRecoveryLog(encode([...body(), ...terminal])), /未唯一成功结束/);
  }
  assert.throws(() => verifyMacRecoveryLog(encode([...body(), row("fail", "TestUnrelatedFailure"), row("pass")])), /原生测试失败/);
  assert.throws(() => verifyMacRecoveryLog(encode([...body(), row("pass")]) + "\n{"), SyntaxError);
});
