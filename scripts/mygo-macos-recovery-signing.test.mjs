import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { macRecoverySigningEntitlements, readMacRecoveryProfileClaims, readMacRecoveryProfileFile, requireMacRecoverySignedClaims, verifyMacRecoverySigning } from "./mygo-macos-recovery-signing.mjs";

const identity = "Developer ID Application: Test fixture (ABCDE12345)";
const app = "ABCDE12345.app.chordv.desktop";
const groups = "keychain-access-groups";
const teamKey = "com.apple.developer.team-identifier";
const appKey = "com.apple.application-identifier";
const scoped = { [appKey]: app, [teamKey]: "ABCDE12345", [groups]: [`${app}.update-recovery`] };
const now = Date.parse("2026-01-01T00:00:00Z");
const claims = () => ({ teams: ["ABCDE12345"], allDevices: true, expires: Date.parse("2090-01-01T00:00:00Z"), entitlements: structuredClone(scoped) });
const darwin = { skip: process.platform !== "darwin" };

test("profile team allowlist narrows to precisely one signed access group", () => {
  for (const allowed of [[`${app}.update-recovery`], ["ABCDE12345.*", "ABCDE12345.other"]]) {
    const profile = claims(); profile.entitlements[groups] = allowed;
    assert.deepEqual(macRecoverySigningEntitlements(profile, identity, now), scoped);
    assert.deepEqual(profile.entitlements[groups], allowed);
  }
  assert.throws(() => macRecoverySigningEntitlements(claims(), "Apple Development: Test fixture (ABCDE12345)", now), /Developer ID/);
});

test("profile team, app, distribution scope and expiry are mandatory", () => {
  for (const [change, error] of [
    [p => { p.teams = ["ZZZZZ99999"]; }, /签名团队/],
    [p => { p.entitlements[teamKey] = "ZZZZZ99999"; }, /签名团队/],
    [p => { p.entitlements[appKey] = "ABCDE12345.*"; }, /应用标识/],
    [p => { p.allDevices = false; }, /分发 profile/],
    [p => { p.expires = now; }, /未过期/],
    [p => { p.entitlements["get-task-allow"] = true; }, /分发 profile/],
    [p => { p.entitlements[groups] = ["*"]; }, /访问组/],
    [p => { p.entitlements[groups] = ["ZZZZZ99999.*"]; }, /访问组/]
  ]) {
    const value = claims(); change(value);
    assert.throws(() => macRecoverySigningEntitlements(value, identity, now), error);
  }
});

test("signed claims reject wildcards, extra groups, debug permissions and missing app identity", () => {
  requireMacRecoverySignedClaims(scoped, identity);
  for (const actual of [{ ...scoped, [groups]: ["ABCDE12345.*"] }, { ...scoped, [groups]: [...scoped[groups], "ABCDE12345.other"] },
    { ...scoped, "get-task-allow": true }, { [teamKey]: scoped[teamKey], [groups]: scoped[groups] }]) {
    assert.throws(() => requireMacRecoverySignedClaims(actual, identity), /精确的受保护更新钥匙串权限/);
  }
});

test("macOS plutil reads actual date, bool, array and dictionary fields, not strings substituted for types", darwin, () => {
  const plist = `<plist version="1.0"><dict>
    <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
    <key>ProvisionsAllDevices</key><true/>
    <key>ExpirationDate</key><date>2090-01-01T00:00:00Z</date>
    <key>Entitlements</key><dict><key>${appKey}</key><string>${app}</string><key>${teamKey}</key><string>ABCDE12345</string>
    <key>${groups}</key><array><string>ABCDE12345.*</string></array></dict></dict></plist>`;
  const decoded = readMacRecoveryProfileClaims(Buffer.from(plist));
  assert.deepEqual(macRecoverySigningEntitlements(decoded, identity, now), scoped);
  for (const wrong of [plist.replace("<true/>", "<string>true</string>"), plist.replaceAll("date>", "string>"), "not a plist"]) {
    assert.throws(() => readMacRecoveryProfileClaims(Buffer.from(wrong)), /字段不完整或格式无效/);
  }
});

test("local and non-macOS builds reject recovery signing input before running build tools", () => {
  const entry = fileURLToPath(new URL("./mygo-desktop.mjs", import.meta.url));
  for (const args of [["--build-only", "--platform", "macos"], ["--release", "--build-only", "--platform", "windows"], ["--build-only", "--check"]]) {
    const result = spawnSync(process.execPath, [entry, ...args], { env: { ...process.env, CHORDV_MACOS_RECOVERY_PROVISIONING_PROFILE: "/local-only-test/unused" }, encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /仅适用于 macOS 正式安装包构建/);
    assert.equal(result.stdout, "");
  }
});

test("actual macOS release entry rejects an invalid profile path before generation or signing", darwin, () => {
  const entry = fileURLToPath(new URL("./mygo-desktop.mjs", import.meta.url));
  const { publicKey } = generateKeyPairSync("ed25519");
  const result = spawnSync(process.execPath, [entry, "--release", "--build-only", "--platform", "macos", "--arch", "arm64"], {
    env: { PATH: process.env.PATH, CHORDV_BUILD_NUMBER: "17", CHORDV_RELEASE_API_BASE_URL: "https://release-build.local.test",
      VITE_GITHUB_RELEASE_REPOSITORY: "fixture/releases", VITE_GITHUB_RELEASE_PUBLIC_KEY: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      CHORDV_MACOS_SIGNING_IDENTITY: identity, CHORDV_MACOS_NOTARY_PROFILE: "not-used",
      CHORDV_MACOS_RECOVERY_PROVISIONING_PROFILE: "relative-fixture" }, encoding: "utf8", timeout: 5_000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /必须使用绝对路径/);
  assert.equal(result.stdout, "");
});

test("read-only profile file rejects symlinks, empty input, large input and relative paths", darwin, async t => {
  const temp = await mkdtemp(join(tmpdir(), "chordv-recovery-profile-file-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const real = join(temp, "actual");
  await writeFile(real, "fixture");
  assert.equal((await readMacRecoveryProfileFile(real)).toString(), "fixture");
  const alias = join(temp, "alias");
  await symlink(real, alias);
  await assert.rejects(readMacRecoveryProfileFile(alias), { code: "ELOOP" });
  await assert.rejects(readMacRecoveryProfileFile("not-absolute"), /绝对路径/);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    await writeFile(real, bytes);
    await assert.rejects(readMacRecoveryProfileFile(real), /不是有效的普通文件/);
  }
});

test("compare both actual bundle profile bytes and entitlements extracted by macOS codesign", darwin, async t => {
  const temp = await mkdtemp(join(tmpdir(), "chordv-recovery-signed-claims-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const appPath = join(temp, "Fixture.app"), source = join(temp, "BuildFixture.app");
  const embedded = path => join(path, "Contents", "embedded.provisionprofile");
  const profile = join(temp, "selected.profile"), entitlements = join(temp, "entitlements.plist");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(source, "Contents"), { recursive: true });
  await copyFile("/usr/bin/true", join(appPath, "Contents", "MacOS", "Fixture"));
  await writeFile(join(appPath, "Contents", "Info.plist"), `<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleIdentifier</key><string>app.chordv.recovery-signing-test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  await writeFile(profile, "synthetic profile bytes, not an Apple profile");
  await copyFile(profile, embedded(source));
  await copyFile(profile, embedded(appPath));
  const sign = async actual => {
    const xml = execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], { input: JSON.stringify(actual) });
    await writeFile(entitlements, xml);
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--entitlements", entitlements, appPath], { stdio: "pipe", timeout: 20_000 });
  };
  await sign(scoped);
  await verifyMacRecoverySigning(appPath, source, profile, identity);
  for (const bundle of [source, appPath]) {
    await writeFile(embedded(bundle), "different profile bytes");
    await assert.rejects(verifyMacRecoverySigning(appPath, source, profile, identity), /未包含本次选定/);
    await copyFile(profile, embedded(bundle));
  }
  await sign({ ...scoped, [groups]: ["ABCDE12345.*"] });
  await assert.rejects(verifyMacRecoverySigning(appPath, source, profile, identity), /精确的受保护更新钥匙串权限/);
});
