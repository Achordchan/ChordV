import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../src-tauri/src/lib.rs"), "utf8");

// A Windows full replacement must derive E:\... from the running executable,
// while its ZIP remains private staging data and is never opened as a document.
assert.match(source, /let current_exe = std::env::current_exe\(\)/);
assert.match(source, /let install_dir = current_exe\s*\.parent\(\)/);
assert.match(source, /spawn_deferred_full_update_apply\(\s*&script_path[\s\S]*?&install_dir/);
assert.match(source, /if package_kind\.as_deref\(\) == Some\("full_update"\) \{\s*return Err\("完整替换更新请使用 apply_desktop_full_update"/);
assert.match(source, /Expand-Archive -LiteralPath \$PackagePath -DestinationPath \$staging/);
assert.match(source, /Start-Process -FilePath \$exePath -WorkingDirectory \$InstallDir/);
assert.doesNotMatch(source, /open::that\([^)]*package|Command::new\("cmd"\)\.arg\("\/c"\)\.arg\([^)]*PackagePath/);

console.log("Windows full update path regression checks passed");
