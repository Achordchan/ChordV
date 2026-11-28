import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageServer } from "./release-artifacts.mjs";
import { sourceCommit, verifyServerBuild } from "./server-build-info.mjs";
import { testCommit, writeServerBuild } from "./fixtures/server-build.mjs";

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chordv-build-info-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input"), build = join(input, "linux-x64"), output = join(directory, "output");
  const info = await writeServerBuild(build, options);
  return { directory, input, build, output, info };
}
const expected = info => ({ version: info.version, commit: info.commit, platform: info.platform, architecture: info.architecture });

test("release staging rejects local-only output, missing deployment instructions and invented binaries", async t => {
  const f = await fixture(t);
  const stage = () => stageServer({ platform: "linux", architecture: "x64", version: "2.0.0", input: f.input, output: f.output, commit: testCommit });
  await writeFile(join(f.build, "LOCAL-ONLY.txt"), "test-only local marker");
  await assert.rejects(stage(), /Local-only/);
  await rm(join(f.build, "LOCAL-ONLY.txt")); await rm(join(f.build, "DEPLOYMENT.txt"));
  await assert.rejects(stage(), /ENOENT.*DEPLOYMENT/);
  await writeFile(join(f.build, "DEPLOYMENT.txt"), "test-only explicit production configuration");
  await writeFile(join(f.build, "chordv-server"), "test-only-not-a-go-executable");
  await assert.rejects(stage(), /verification failed|Actual Go binary/);
  await assert.rejects(access(f.output));
});

test("actual Go binary rejects fabricated version, commit, build time and target sidecars", async t => {
  const { build, info } = await fixture(t);
  for (const overrides of [{ version: "2.0.1" }, { commit: "b".repeat(40) }, { builtAt: "2026-11-17T00:00:00.000Z" }, { architecture: "arm64" }]) {
    const changed = { ...info, ...overrides };
    await writeFile(join(build, "build-info.json"), JSON.stringify(changed));
    await assert.rejects(verifyServerBuild(build, expected(changed)), /Actual Go binary/);
  }
  await writeFile(join(build, "build-info.json"), JSON.stringify({ ...info, builtAt: "not-a-date" }));
  await assert.rejects(verifyServerBuild(build, expected(info)), /build-info.*mismatch/);
});

test("same-platform release verification executes real --version before any configuration or database access", async t => {
  const platform = process.platform === "darwin" ? "macos" : process.platform;
  assert.ok(["macos", "linux"].includes(platform), "release tooling tests run on macOS or Linux");
  const { build, info } = await fixture(t, { platform, architecture: process.arch === "x64" ? "x64" : "arm64" });
  assert.deepEqual(await verifyServerBuild(build, expected(info)), info);
  const bad = await fixture(t, { platform, architecture: info.architecture, runtimeVersion: "0.0.1" });
  await assert.rejects(verifyServerBuild(bad.build, expected(bad.info)), /Actual server --version/);
});

test("failed archive verification cleans partial files and refuses links outside the release tree", async t => {
  const f = await fixture(t);
  await symlink("../../outside-credentials", join(f.build, "admin/unexpected-link"));
  await assert.rejects(stageServer({ platform: "linux", architecture: "x64", version: "2.0.0", input: f.input, output: f.output, commit: testCommit }), /links or special/);
  assert.deepEqual(await readdir(f.output), [], "failed staging leaves no publishable archive or descriptor");
});

test("expected source commit must match the checkout, not caller environment metadata", () => {
  const previous = process.env.GITHUB_SHA;
  try {
    delete process.env.GITHUB_SHA;
    assert.match(sourceCommit(), /^[a-f0-9]{40,64}$/);
    process.env.GITHUB_SHA = "0".repeat(40);
    assert.throws(sourceCommit, /differs from the checked-out/);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previous;
  }
});

test("actual Agent distribution is mandatory and bound to the running server build, not mutable sidecars", async t => {
  const { build, info } = await fixture(t);
  const manifest = join(build, "agent-dist/manifest.json"), binary = join(build, "agent-dist/chordv-agent-linux-arm64");
  const originalManifest = await readFile(manifest), originalBinary = await readFile(binary);
  await verifyServerBuild(build, expected(info));
  await writeFile(manifest, `${originalManifest} `);
  await assert.rejects(verifyServerBuild(build, expected(info)), /embedded trust anchor/);
  await writeFile(manifest, originalManifest);
  await writeFile(binary, "test-only-tampered-Agent");
  await assert.rejects(verifyServerBuild(build, expected(info)), /Agent binary SHA256/);
  await rm(binary);
  await assert.rejects(verifyServerBuild(build, expected(info)), /ENOENT.*arm64/);
  await writeFile(binary, originalBinary);
  await verifyServerBuild(build, expected(info));
  await rm(manifest); await symlink("../build-info.json", manifest);
  await assert.rejects(verifyServerBuild(build, expected(info)), /regular files/);
});

test("server staging rejects a legacy admin entry and an admin entry without its JS or CSS", async t => {
  const f = await fixture(t), file = join(f.build, "admin/index.html");
  const verify = () => verifyServerBuild(f.build, expected(f.info));
  const index = await readFile(file, "utf8");
  await writeFile(file, '<!doctype html><script type="module" src="/assets/old.js"></script>');
  await assert.rejects(verify(), /admin version/i);
  await writeFile(file, index.replace('content="2.0.0"', 'content="1.0.0"'));
  await assert.rejects(verify(), /admin version/i);
  await writeFile(file, index);
  for (const name of ["fixture.js", "fixture.css"]) {
    const asset = join(f.build, "admin/assets", name), bytes = await readFile(asset);
    await rm(asset); await assert.rejects(verify(), /ENOENT/); await writeFile(asset, bytes);
  }
  await verify();
});
