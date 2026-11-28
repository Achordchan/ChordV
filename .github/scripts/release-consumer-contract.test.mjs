import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { makeManifest } from "./release-artifacts.mjs";
import { prepareRelease } from "./github-release-contract.mjs";
import { recoveryFixture, signed } from "./fixtures/resume-release.mjs";

async function rewrite(local, changes) {
  const manifest = { ...local.manifest, ...changes };
  manifest.tag = `${local.kind === "server" ? "server-" : ""}v${manifest.version}`;
  for (const asset of manifest.installers ?? manifest.servers) asset.buildInfo.version = manifest.version;
  const body = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(local.directory, local.name), body);
  await writeFile(join(local.directory, `${local.name}.sig`), signed(body));
  return body;
}

test("consumer contract: desktop producer rejects overlong changelog and unsafe numeric versions before signing", async t => {
  const local = await recoveryFixture(t, { kind: "desktop" });
  const { privateKey } = generateKeyPairSync("ed25519"), key = privateKey.export({ type: "pkcs8", format: "pem" });
  const before = await readFile(join(local.directory, local.name));
  for (const changes of [{ changelog: ["x".repeat(4001)] }, { version: "9007199254740992.0.0" }, { version: "1.9007199254740992.0" }, { version: "1.0.9007199254740992" }]) {
    await assert.rejects(makeManifest({ kind: "desktop", version: "2.0.0", build: 17, directory: local.directory, privateKey: key, ...changes }), /consumer|changelog|safe integer/i);
    assert.ok((await readFile(join(local.directory, local.name))).equals(before));
  }
});

test("consumer contract: signed desktop manifests hit the same changelog/version limits before publish or bundle", async t => {
  for (const changes of [{ changelog: ["x".repeat(4001)] }, { version: "9007199254740992.0.0" }, { version: "9007199254740993.0.0", minimumVersion: "9007199254740992.0.0" }]) {
    const local = await recoveryFixture(t, { kind: "desktop" }); await rewrite(local, changes);
    await assert.rejects(prepareRelease(local.options), /consumer|changelog|safe integer/i);
  }
});

test("consumer contract: desktop inclusive limits and arbitrarily long numeric prerelease remain valid", async t => {
  for (const version of ["9007199254740991.0.0", "2.0.0-900719925474099200000000"]) {
    const local = await recoveryFixture(t, { kind: "desktop" }); await rewrite(local, { version, changelog: ["x".repeat(4000)] });
    if (version.includes("-")) await rewrite(local, { version, channel: "beta", changelog: ["x".repeat(4000)] });
    assert.equal((await prepareRelease(local.options)).manifest.version, version);
  }
});

test("consumer contract: aggregate desktop metadata cannot exceed the native one MiB byte limit", async t => {
  const local = await recoveryFixture(t, { kind: "desktop" });
  await rewrite(local, { changelog: Array.from({ length: 300 }, () => "x".repeat(4000)) });
  await assert.rejects(prepareRelease(local.options), /manifest.*(large|MiB|limit)|consumer/i);
});

test("consumer contract: unrelated server metadata is not constrained by the desktop-only parser", async t => {
  const local = await recoveryFixture(t);
  await rewrite(local, { version: "9007199254740992.0.0", changelog: ["x".repeat(4001)] });
  const context = await prepareRelease(local.options);
  assert.equal(context.manifest.version, "9007199254740992.0.0");
  assert.equal(context.manifest.changelog[0].length, 4001);
});
