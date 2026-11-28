import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { prepareRelease } from "./github-release-contract.mjs";
import { recoveryFixture } from "./fixtures/resume-release.mjs";

const modulePath = new URL("./release-recovery-bundle.mjs", import.meta.url);
async function bundle(options) {
  const implementation = await import(modulePath).catch(() => null);
  assert.equal(typeof implementation?.createRecoveryBundle, "function", "the explicit recovery bundle builder must exist");
  return implementation.createRecoveryBundle(options);
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "chordv-recovery-bundle-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function tar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("delivery: backend workflow exports its normalized version through build, staging and manifest", async t => {
  const directory = await temporary(t), workflow = await readFile(new URL("../workflows/release-backend.yml", import.meta.url), "utf8");
  const match = workflow.match(/node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS/);
  assert.ok(match);
  const script = match[1].split("\n").map(line => line.slice(10)).join("\n"), version = (await readFile("SYSTEM_VERSION", "utf8")).trim();
  for (const raw of [version, `v${version}`]) {
    const output = join(directory, "outputs"), environment = join(directory, "environment");
    await writeFile(output, ""); await writeFile(environment, "");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: resolve("."), encoding: "utf8", env: { ...process.env, VERSION: raw, VITE_GITHUB_RELEASE_REPOSITORY: "fixture/releases", VITE_GITHUB_RELEASE_PUBLIC_KEY: Buffer.alloc(32, 1).toString("base64"), GITHUB_OUTPUT: output, GITHUB_ENV: environment } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, "utf8"), `version=${version}\n`);
    assert.equal(await readFile(environment, "utf8"), `VERSION=${version}\n`);
  }
  assert.match(workflow, /outputs:\s+version: \$\{\{ steps\.configuration\.outputs\.version \}\}/);
  assert.match(workflow, /VERSION: \$\{\{ needs\.build\.outputs\.version \}\}/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf("  publish:")), /VERSION: \$\{\{ inputs\.version \}\}/);
});

test("delivery: desktop workflow rejects malformed API origins before accepting release configuration", async t => {
  const directory = await temporary(t), workflow = await readFile(new URL("../workflows/release-desktop.yml", import.meta.url), "utf8");
  const match = workflow.match(/node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS/);
  assert.ok(match);
  const script = match[1].split("\n").map(line => line.slice(10)).join("\n");
  const { macos: version } = JSON.parse(await readFile("apps/desktop/config/platform-versions.json", "utf8"));
  const output = join(directory, "outputs");
  for (const [origin, valid] of [["https://api.example.test:8443/", true], ["https://api.example.test/api", false],
    ["https://api.example.test/?test=1", false], ["https://api.example.test/#", false], ["http://api.example.test", false],
    ["https://user:fixture@api.example.test", false], ["https://api.example.test/a/..", false], ["https://api.example.test:65536/", false], ["", false]]) {
    await writeFile(output, "");
    const env = { ...process.env, RAW_VERSION: version, MINIMUM_VERSION: "0.0.0", VITE_API_BASE_URL: origin,
      VITE_GITHUB_RELEASE_REPOSITORY: "fixture/releases", VITE_GITHUB_RELEASE_PUBLIC_KEY: Buffer.alloc(32, 1).toString("base64"), GITHUB_OUTPUT: output };
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolve("."), encoding: "utf8", timeout: 5000, env
    });
    assert.equal(result.status, valid ? 0 : 1, origin);
    assert.equal(await readFile(output, "utf8"), valid ? `version=${version}\n` : "", origin);
    if (!valid) {
      assert.match(result.stderr, /HTTPS API 来源/);
      assert.doesNotMatch(result.stderr, /user:fixture/);
    }
    const build = spawnSync(process.execPath, ["scripts/mygo-desktop.mjs", "--release", "--build-only", "--platform", "windows", "--arch", "x64"], {
      cwd: resolve("."), encoding: "utf8", timeout: 5000,
      env: { ...env, CHORDV_BUILD_NUMBER: "17", CHORDV_RELEASE_API_BASE_URL: origin, CHORDV_WINDOWS_CERTIFICATE: "", MYGO_WINDOWS_CERTIFICATE_PASSWORD: "" }
    });
    assert.equal(build.status, 1, origin);
    assert.match(build.stderr, valid ? /需要代码签名证书/ : /HTTPS API 来源/);
    assert.doesNotMatch(build.stderr, /user:fixture/);
  }
});

test("delivery: both workflows durably save a white-listed bundle before any Release write", async () => {
  for (const name of ["release-desktop", "release-backend"]) {
    const workflow = await readFile(new URL(`../workflows/${name}.yml`, import.meta.url), "utf8"), publish = workflow.slice(workflow.indexOf("  publish:"));
    const sign = publish.indexOf("node .github/scripts/release-artifacts.mjs manifest"), bundle = publish.indexOf("node .github/scripts/release-recovery-bundle.mjs"), upload = publish.indexOf("uses: actions/upload-artifact@v4"), release = publish.indexOf("node .github/scripts/publish-github-release.mjs");
    assert.ok(sign >= 0 && bundle > sign && upload > bundle && release > upload, name);
    const persistence = publish.slice(bundle, release);
    assert.match(persistence, /path: \$\{\{ steps\.recovery\.outputs\.bundle_path \}\}/);
    assert.match(persistence, /if-no-files-found: error/);
    assert.doesNotMatch(persistence, /continue-on-error|if: always\(\)|resume-channel/);
    assert.doesNotMatch(persistence, /path:\s+(?:release-assets\/\*|\*\*|\.)\s*\n/);
  }
});

test("delivery: recovery archive contains exactly signed payloads and original metadata, never secrets or leftovers", async t => {
  for (const kind of ["server", "desktop"]) {
    const local = await recoveryFixture(t, { kind }), output = await temporary(t);
    for (const file of ["signing.pfx", "private.pem", ".env", "stale.bin", "unrelated.json"]) await writeFile(join(local.directory, file), "must-not-be-in-the-bundle");
    if (process.platform === "darwin") {
      const tagged = spawnSync("/usr/bin/xattr", ["-w", "com.chordv.qa.buildhost", "fixture", join(local.directory, "SHA256SUMS")]);
      assert.equal(tagged.status, 0);
    }
    const result = await bundle({ ...local.options, output });
    const archiveBytes = gunzipSync(await readFile(result.path));
    assert.doesNotMatch(archiveBytes.toString("latin1"), /(?:LIBARCHIVE|SCHILY)\.xattr\.|\._SHA256SUMS/);
    const listed = tar(["-tzf", result.path]).trim().split("\n");
    assert.deepEqual(listed.sort(), [...local.payloads.keys()].sort());
    const restored = join(output, "restored"); await mkdir(restored);
    tar(["-xzf", result.path, "-C", restored]);
    const context = await prepareRelease({ ...local.options, directory: restored });
    assert.ok(context.body.equals(local.body)); assert.ok(context.signature.equals(local.signature));
    for (const [file, bytes] of local.payloads) assert.ok((await readFile(join(restored, file))).equals(bytes), file);
    assert.ok(result.sizeBytes > 0); assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual((await readdir(output)).sort(), [result.path.split(/[\\/]/).at(-1), "restored"].sort());
  }
});

test("delivery: tampered payload and invalid SUMS cannot produce a recovery archive", async t => {
  for (const name of ["server-x64.tar.gz", "SHA256SUMS"]) {
    const local = await recoveryFixture(t), output = await temporary(t);
    await writeFile(join(local.directory, name), "tampered");
    await assert.rejects(bundle({ ...local.options, output }), /integrity|SHA256SUMS/);
    assert.deepEqual(await readdir(output), []);
  }
});

test("delivery: matching bytes reached through a filesystem link are not silently bundled", async t => {
  if (process.platform === "win32") { t.skip("unprivileged Windows symlink creation is not assumed"); return; }
  const local = await recoveryFixture(t), output = await temporary(t), original = join(output, "original.tar.gz"), file = join(local.directory, "server-x64.tar.gz");
  await writeFile(original, await readFile(file)); await rm(file); await symlink(original, file);
  await assert.rejects(bundle({ ...local.options, output }), /regular|link/);
  assert.deepEqual(await readdir(output), ["original.tar.gz"]);
});
