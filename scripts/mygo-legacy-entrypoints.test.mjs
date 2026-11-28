import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = path.dirname(fileURLToPath(import.meta.url));

function runAlias(entry, target, args) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chordv-legacy-alias-"));
  try {
    copyFileSync(path.join(scripts, entry), path.join(dir, entry));
    writeFileSync(path.join(dir, target), `process.stdout.write(JSON.stringify({ entry: ${JSON.stringify(target)}, args: process.argv.slice(2) }));`);
    writeFileSync(path.join(dir, "guard.mjs"), `globalThis.fetch = () => { throw new Error("legacy alias must not use network"); };`);
    const result = spawnSync(process.execPath, ["--import", path.join(dir, "guard.mjs"), path.join(dir, entry), ...args], { encoding:"utf8", timeout:3000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally { rmSync(dir, { recursive:true, force:true }); }
}

test("old desktop name delegates in-process to the MyGo development entry and forwards arguments", () => {
  assert.deepEqual(runAlias("local-desktop-dev.mjs", "mygo-desktop.mjs", ["--check", "--platform", "macos"]), {
    entry:"mygo-desktop.mjs", args:["--dev", "--check", "--platform", "macos"]
  });
});

test("old backend name delegates in-process to the sole local Go/API entry and forwards the selected port", () => {
  assert.deepEqual(runAlias("local-backend-dev.mjs", "mygo-local.mjs", ["5188"]), { entry:"mygo-local.mjs", args:["5188"] });
});

test("compatibility aliases contain no old stack, downloads, online defaults or subprocess launch", () => {
  for (const name of ["local-desktop-dev.mjs", "local-backend-dev.mjs"]) {
    const source = readFileSync(path.join(scripts, name), "utf8");
    assert.doesNotMatch(source, /tauri|nestjs|concurrently|setup:xray|runtime-components|https?:|fetch\s*\(|child_process|spawn\s*\(|exec\s*\(|\bgit\b|\.env\b/i);
    assert.equal((source.match(/import\(/g) ?? []).length, 1);
  }
});

test("desktop shell entry delegates to MyGo from another working directory and a path with spaces", (t) => {
  if (process.platform === "win32") return t.skip("需要 bash；Windows 不将跳过当作已验证");
  const root = mkdtempSync(path.join(os.tmpdir(), "chordv desktop entry "));
  try {
    mkdirSync(path.join(root,"scripts"));
    copyFileSync(path.resolve(scripts,"../start-app.sh"),path.join(root,"start-app.sh"));
    writeFileSync(path.join(root,"scripts/mygo-desktop.mjs"),"process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const result=spawnSync("/bin/bash",[path.join(root,"start-app.sh"),"--check","--platform","macos"],{cwd:os.tmpdir(),encoding:"utf8",timeout:3000});
    assert.equal(result.error,undefined);
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),["--check","--platform","macos"]);
    assert.doesNotMatch(readFileSync(path.resolve(scripts,"../start-app.sh"),"utf8"),/tauri|cargo|rustc|src-tauri/i);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("retired desktop release always fails with the manual workflow entry and runs no Git or network commands", (t) => {
  if (process.platform === "win32") return t.skip("需要 bash；Windows 不将跳过当作已验证");
  const dir = mkdtempSync(path.join(os.tmpdir(), "chordv-retired-release-"));
  try {
    const bin = path.join(dir, "bin");
    const marker = path.join(dir, "unexpected-command");
    mkdirSync(bin);
    for (const command of ["git", "node", "curl", "wget", "gh"]) {
      const file = path.join(bin, command);
      writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${marker}'\nexit 95\n`);
      chmodSync(file, 0o755);
    }
    const result = spawnSync("/bin/bash", [path.join(scripts, "release-desktop.sh"), "--force", "--push"], {
      cwd:dir, encoding:"utf8", timeout:3000,
      env:{ PATH:bin, HOME:dir, GIT_REMOTE:"https://example.invalid/no-network" }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /已退役/);
    assert.match(result.stderr, /Release MyGo Desktop/);
    assert.match(result.stderr, /\.github\/workflows\/release-desktop\.yml/);
    assert.match(result.stderr, /workflow_dispatch/);
    assert.equal(existsSync(marker), false, "retired entry launched an external command");
    const source = readFileSync(path.join(scripts, "release-desktop.sh"), "utf8");
    assert.doesNotMatch(source, /\bgit\b|\b(?:curl|wget|gh|node)\s|https?:|src-tauri/);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
