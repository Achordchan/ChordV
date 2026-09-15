import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIdleUpdateDownloadState, normalizeUpdateDownloadProgress, downloadProgressPercent, updateActionLabel } from "../src/lib/updateState";

const checking = normalizeUpdateDownloadProgress(createIdleUpdateDownloadState(), {
  phase: "verifying", fileName: "update.zip", downloadedBytes: 1000, totalBytes: 1000, localPath: null, message: "校验中"
});
assert.equal(checking.phase, "verifying");
assert.equal(downloadProgressPercent(checking), 100);
assert.equal(updateActionLabel({ deliveryMode: "desktop_full_replace" } as any, checking), "正在校验更新包");
const hook = readFileSync(new URL("../src/hooks/useUpdateFlow.ts",import.meta.url),"utf8");
assert.doesNotMatch(hook,/indeterminateUpdateProgress|setIndeterminateUpdateProgress/);
const app = readFileSync(new URL("../src/App.tsx",import.meta.url),"utf8");
assert.doesNotMatch(app, /<Progress\b/);
assert.doesNotMatch(app, /runtimeAssetsDialogOpened/);
assert.match(app,/ClientUpdateProgressPanel/);
const launcher = readFileSync(new URL("../../../start-app.sh",import.meta.url),"utf8");
assert.match(launcher,/export VITE_CHORDV_LOCAL_PREVIEW=1/);
console.log("unified installer verification state, legacy progress removal and native preview gate passed");
