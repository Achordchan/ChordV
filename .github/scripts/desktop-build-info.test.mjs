import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectMacInstaller, verifyDesktopInstaller } from "./desktop-build-info.mjs";
import { stageDesktop } from "./release-artifacts.mjs";
import { parseDesktopBuildID } from "../../scripts/mygo-desktop-build-identity.mjs";

test("original macOS DMG must contain the same sealed application as the build output", async t => {
  const image = process.env.CHORDV_TEST_FULL_GUI_DMG, app = process.env.CHORDV_TEST_FULL_GUI_APP;
  if (!image && !app) { t.skip("requires the original local DMG and its local app"); return; }
  assert.ok(image && app && process.platform === "darwin");
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
  const binary = join("Contents", "MacOS", "ChordV MyGo Local");
  const expected = parseDesktopBuildID(run("go", ["tool", "buildid", join(app, binary)]).trim());
  assert.equal(expected.mode, "local");
  assert.equal(expected.platform, "macos");
  const result = await inspectMacInstaller(image, app, expected);
  assert.deepEqual(result.identity, expected);
  await assert.rejects(verifyDesktopInstaller(image, "", expected), /Only release-mode/);

  const temp = await mkdtemp(join(tmpdir(), "chordv-mac-staging-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const input = join(temp, "input"), output = join(temp, "release-assets");
  const directory = join(input, `darwin-${expected.architecture === "x64" ? "amd64" : "arm64"}`);
  await mkdir(directory, { recursive: true });
  await copyFile(image, join(directory, "local.dmg"));
  await assert.rejects(stageDesktop({ ...expected, input, output }), /Installer must contain exactly one regular application bundle/);
  assert.deepEqual(await readdir(temp), ["input"], "local QA installers cannot leave a release or private snapshot");

  const alternate = join(temp, "ChordV MyGo Local.app");
  run("/usr/bin/ditto", [app, alternate]);
  await writeFile(join(alternate, "Contents/Resources/local-staging-test.txt"), "local-only seal comparison fixture\n", { flag: "wx" });
  run("/usr/bin/codesign", ["--force", "--sign", "-", alternate]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", alternate]);
  assert.equal(run("go", ["tool", "buildid", join(alternate, binary)]).trim(), run("go", ["tool", "buildid", join(app, binary)]).trim());
  await assert.rejects(inspectMacInstaller(image, alternate, expected), /differs from the actual sealed build output/);
});
