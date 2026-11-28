import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nativePackage = "github.com/Achordchan/ChordV/apps/desktop/native";
const terminals = new Set(["pass", "fail", "skip"]);

export const requiredMacRecoveryTests = Object.freeze([
  "TestMacRecoveryStoreFailureRejectsBeforeReady",
  "TestMacRecoverySlotTransitionsUseExactRevisionAndScope",
  ...["startup-failure", "changed-before-live-rollback", "health-ack-lost"].map(sub => `TestMacRecoveryArmBindsRealHelperTransactionBeforeSwap/${sub}`),
  ...["valid", "wrong-intent-ready", "wrong-armed-ack"].map(sub => `TestMacStartupRollbackUsesRealSignedWorkerAndParentExit/${sub}`),
  "TestMacRollbackRealProcessThenRetiresOriginalCheckpoint",
  ...["original-updater", "independent-worker"].map(sub => `TestMacRestoredOriginalWaitsForLiveHelper/${sub}`),
  ...["journal-retired", "journal-retained"].map(sub => `TestMacStartupReportFollowsRecoveryDisposition/${sub}`),
  ...["updating-candidate", "armed-recovery-exit"].map(sub => `TestStartupReportLeavesOutcomeForTheNextOrdinaryLaunch/${sub}`),
  "TestStartupReportCancellationDoesNotConsume"
]);

export function verifyMacRecoveryLog(text) {
  const running = new Map(), finished = new Map(), packageResults = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row?.Package !== nativePackage) continue;
    const { Action: action, Test: test } = row;
    if (!test) {
      if (terminals.has(action)) packageResults.push(action);
      continue;
    }
    if (action === "run") running.set(test, (running.get(test) ?? 0) + 1);
    if (terminals.has(action)) {
      if (action === "fail") throw new Error(`macOS 原生测试失败：${test}`);
      if (finished.has(test)) throw new Error(`macOS 原生测试结果重复：${test}`);
      finished.set(test, action);
    }
  }
  if (packageResults.length !== 1 || packageResults[0] !== "pass") throw new Error("macOS 原生测试包未唯一成功结束");
  const missing = requiredMacRecoveryTests.filter(test => running.get(test) !== 1 || finished.get(test) !== "pass");
  if (missing.length) throw new Error(`macOS 恢复必须执行并通过：${missing.join(", ")}`);
  return requiredMacRecoveryTests.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/mygo-verify-mac-recovery-log.mjs GO_TEST_JSON_LOG");
    const count = verifyMacRecoveryLog(await readFile(process.argv[2], "utf8"));
    process.stdout.write(`macOS 更新恢复 ${count} 项必测用例已执行并通过。\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
