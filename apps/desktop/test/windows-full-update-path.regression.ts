import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const native = readFileSync(resolve(import.meta.dirname, "../src-tauri/src/lib.rs"), "utf8");
const updater = readFileSync(resolve(import.meta.dirname, "../src-tauri/src/windows_update.rs"), "utf8");
const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8"));
assert.equal(config.plugins.updater.windows.installMode, "passive");
assert.ok(config.plugins.updater.pubkey);
assert.match(updater, /update\.download\(/);
assert.match(updater, /pending\.update\.install\(&pending\.bytes\)/);
assert.ok(updater.indexOf("shutdown_runtime_state(app)?") < updater.indexOf("pending.update.install"));
assert.doesNotMatch(native, /apply_desktop_full_update|spawn_deferred_full_update_apply|write_full_update_script/);
assert.doesNotMatch(updater.split("\n#[cfg(test)]")[0], /Command::new|Copy-Item|Remove-Item/);
console.log("Windows official updater integration and retired replacement command checks passed");

const hooks = readFileSync(resolve(import.meta.dirname, "../src-tauri/windows/chordv-installer-hooks.nsh"), "utf8");
assert.doesNotMatch(hooks, /CheckIfAppIsRunning "\$INSTDIR/);
assert.match(hooks, /CheckIfAppIsRunning "chordv-desktop\.exe"/);
// An exiting client still maps its image; File must not race it (无法打开要写入的文件).
const preinstall = hooks.slice(hooks.indexOf("!macro NSIS_HOOK_PREINSTALL"), hooks.indexOf("!macro NSIS_HOOK_POSTINSTALL"));
assert.ok(preinstall.indexOf("--installer-maintenance") < preinstall.indexOf('ChordVWaitUntilWritable "${MAINBINARYNAME}.exe"'));
assert.match(hooks, /!macro ChordVWaitUntilWritable[\s\S]*FileOpen \$R9 "\$INSTDIR\\\$\{NAME\}" a[\s\S]*Sleep 250[\s\S]*\$\{LoopUntil\} \$R8 >= 60/);
console.log("Windows installer waits for the old binary to be writable");
