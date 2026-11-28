import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWindowsPayload, inspectWindowsPayload } from "./desktop-build-info.mjs";
import { sourceCommit } from "./server-build-info.mjs";

if (process.platform !== "win32" || process.arch !== "x64" || process.env.PROCESSOR_ARCHITECTURE?.toUpperCase() !== "AMD64" || process.env.PROCESSOR_ARCHITEW6432) {
  throw new Error("Windows x64 native runner required for the packaged client smoke test");
}
const { windows: version } = JSON.parse(await readFile("apps/desktop/config/platform-versions.json", "utf8"));
const build = Number(process.env.CHORDV_BUILD_NUMBER);
assert.ok(Number.isSafeInteger(build) && build > 0, "Expected a positive local CI build number");
const info = { version, build, mode: "local", platform: "windows", architecture: "x64" };
const directory = "output/mygo/windows-amd64", temporary = await mkdtemp(join(tmpdir(), "chordv-local-client-"));
try {
  const executable = await extractWindowsPayload(join(process.env.ProgramFiles, "7-Zip", "7z.exe"),
    join(directory, `chordv-mygo-local-setup-${version}-amd64.exe`), temporary, "local");
  await inspectWindowsPayload(temporary, join(directory, "ChordV MyGo Local.exe"), { ...info, commit: sourceCommit() });
  const raw = execFileSync(executable, ["--chordv-build-info"], { cwd: temporary, encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 16_384 });
  assert.deepEqual(JSON.parse(raw), info);
  console.info("Verified build identity from the actual packaged Windows x64 process", info);
} finally { await rm(temporary, { recursive: true, force: true }); }
