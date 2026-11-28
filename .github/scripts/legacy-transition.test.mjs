import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { legacyPublicKey, legacyTransitions, stageLegacyTransition, verifyLegacySignature } from "./legacy-transition.mjs";

test("legacy package signature remains distinct from the new manifest key and rejects byte/comment substitution", async t => {
  const directory = await mkdtemp(join(tmpdir(), "chordv-legacy-signature-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = JSON.parse(await readFile(new URL("./fixtures/legacy-minisign.json", import.meta.url)));
  const file = join(directory, "payload"); await writeFile(file, fixture.payload);
  await verifyLegacySignature(file, fixture.signature, fixture.publicKey);
  await assert.rejects(verifyLegacySignature(file, fixture.signature), /pinned Tauri key/);
  await assert.rejects(verifyLegacySignature(file, Buffer.alloc(64).toString("base64"), fixture.publicKey), /format/);
  const changed = Buffer.from(Buffer.from(fixture.signature, "base64").toString().replace("trusted comment: timestamp", "trusted comment: changedtimestamp")).toString("base64");
  await assert.rejects(verifyLegacySignature(file, changed, fixture.publicKey), /verification failed/);
  await writeFile(file, fixture.payload + "changed");
  await assert.rejects(verifyLegacySignature(file, fixture.signature, fixture.publicKey), /verification failed/);
  const source = await readFile(new URL("../../packages/shared/src/windows-updater-key.ts", import.meta.url), "utf8");
  assert.ok(source.includes(JSON.stringify(legacyPublicKey)), "server/build packager must retain the actual released old key");
});

test("neither a key nor manifest declarations unlock legacy production delivery, and stale descriptors are removed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "chordv-legacy-disabled-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "legacy-windows-x64.json"), "stale");
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
  try {
    delete process.env.TAURI_SIGNING_PRIVATE_KEY;
    assert.deepEqual(await stageLegacyTransition({ directory, platform: "windows", architecture: "x64" }), { enabled: false, reason: "Windows legacy installer semantics have not been accepted; automatic transition remains disabled" });
    process.env.TAURI_SIGNING_PRIVATE_KEY = "test-only-present-key-must-not-unlock";
    assert.equal((await stageLegacyTransition({ directory, platform: "windows", architecture: "x64" })).enabled, false);
    assert.deepEqual(await legacyTransitions(directory, []), []);
    await writeFile(join(directory, "legacy-windows-x64.json"), JSON.stringify({ verified: true, signature: "test-only-declaration" }));
    await assert.rejects(legacyTransitions(directory, []), /cannot unlock/);
    await assert.rejects(stageLegacyTransition({ directory, platform: "macos", architecture: "arm64" }), /only supports Windows/);
  } finally { if (key === undefined) delete process.env.TAURI_SIGNING_PRIVATE_KEY; else process.env.TAURI_SIGNING_PRIVATE_KEY = key; }
});
