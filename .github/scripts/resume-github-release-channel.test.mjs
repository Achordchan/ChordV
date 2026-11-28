import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as publication from "./publish-github-release.mjs";
import { assertChannelWritesOnly, recoveryFixture, recoveryRemote, signed } from "./fixtures/resume-release.mjs";
import { github } from "./github-release-client.mjs";

const resume = (local, remote, extra) => publication.resumeChannel({ ...local.options, fetchImpl: remote.fetchImpl, ...extra });
test("recovery: explicit resume audits every remote byte and writes only one channel tree", async t => {
  const local = await recoveryFixture(t), remote = recoveryRemote(local);
  assert.deepEqual(await resume(local, remote), { tag: local.manifest.tag, changed: true });
  assert.deepEqual(remote.downloads.sort(), [...local.payloads.keys()].sort());
  assert.equal(assertChannelWritesOnly(remote).filter(call => call.url.pathname.endsWith("/git/trees")).length, 1);
  assert.ok(remote.calls.findIndex(call => call.method !== "GET") > remote.calls.findLastIndex(call => call.url.pathname.startsWith("/repos/fixture/releases/releases/")));
});
test("recovery: exact channel bytes are an audited no-op, not permission to skip remote validation", async t => {
  const local = await recoveryFixture(t), remote = recoveryRemote(local, { snapshots: [{ body: local.body, signature: local.signature }] });
  assert.deepEqual(await resume(local, remote), { tag: local.manifest.tag, changed: false });
  assert.equal(assertChannelWritesOnly(remote).length, 0);
  assert.equal(remote.downloads.length, local.payloads.size);
  const broken = recoveryRemote(local, { snapshots: [{ body: local.body, signature: local.signature }], download: asset => asset.name === "server-x64.tar.gz" ? new Response("tampered") : null });
  await assert.rejects(resume(local, broken), /asset|length|integrity|SHA/i);
  assert.equal(assertChannelWritesOnly(broken).length, 0);
});
test("recovery: same version/build with different signed original bytes never counts as idempotent", async t => {
  const local = await recoveryFixture(t);
  for (const snapshot of [{ body: Buffer.from(`${local.body} `) }, { body: local.body, signature: Buffer.from(`${local.signature}\n`) }]) {
    const remote = recoveryRemote(local, { snapshots: [snapshot] });
    await assert.rejects(resume(local, remote), /backwards|immutable|different/i);
    assert.equal(assertChannelWritesOnly(remote).length, 0);
  }
});
test("recovery: normal publication still refuses the existing release", async t => {
  const local = await recoveryFixture(t), remote = recoveryRemote(local);
  await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /already exists/);
  assert.equal(assertChannelWritesOnly(remote).length, 0);
});
test("recovery: absent/draft/misidentified release and missing/conflicting actual tag all fail before writes", async t => {
  const local = await recoveryFixture(t);
  for (const config of [{ missingRelease: true }, { release: { draft: true } }, { release: { tag_name: "server-v9.0.0" } }, { release: { prerelease: true } }, { release: { published_at: null } }, { missingTag: true }, { tagCommit: "b".repeat(40) }]) {
    const remote = recoveryRemote(local, config);
    await assert.rejects(resume(local, remote), /release|tag|commit|published/i);
    assert.equal(assertChannelWritesOnly(remote).length, 0);
  }
});
test("recovery: missing/extra/duplicate-name/duplicate-ID/foreign-URL assets fail before writes", async t => {
  const local = await recoveryFixture(t);
  for (const list of [assets => assets.slice(1), assets => [...assets, { ...assets[0], id: 999, name: "extra.dat" }], assets => [...assets.slice(0, -1), assets[0]], assets => assets.map((asset, index) => index === 1 ? { ...asset, id: assets[0].id } : asset), assets => assets.map((asset, index) => index === 0 ? { ...asset, url: "https://api.github.com/repos/foreign/repo/releases/assets/100" } : asset)]) {
    const remote = recoveryRemote(local, { list });
    await assert.rejects(resume(local, remote), /asset|list|duplicate|repository/i);
    assert.equal(assertChannelWritesOnly(remote).length, 0);
  }
});
test("recovery: actual manifest/signature/checksums and each streamed package must match local original bytes", async t => {
  const local = await recoveryFixture(t);
  for (const file of local.payloads.keys()) {
    const remote = recoveryRemote(local, { download: (asset, bytes) => asset.name === file ? new Response(Buffer.from(bytes).fill(0x78)) : null });
    await assert.rejects(resume(local, remote), /asset|signature|original|integrity|SHA/i);
    assert.equal(assertChannelWritesOnly(remote).length, 0);
  }
});
test("recovery: oversize, early EOF, stream errors and stalled readers fail closed", async t => {
  const local = await recoveryFixture(t);
  for (const response of [() => new Response("x"), () => new Response("x".repeat(1000)), () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("stream disconnected")); } })), () => new Response(new ReadableStream({ cancel() {} }))]) {
    const remote = recoveryRemote(local, { download: asset => asset.name === "server-x64.tar.gz" ? response() : null });
    await assert.rejects(resume(local, remote, { assetReadTimeoutMs: 10 }), /asset|length|exceed|stream|stalled/i);
    assert.equal(assertChannelWritesOnly(remote).length, 0);
  }
});
test("recovery: metadata/ID replacement during streaming is detected by final reread", async t => {
  const local = await recoveryFixture(t);
  for (const change of [remote => { remote.assets[0].id++; }, remote => { remote.assets[0].updated_at = "2026-11-18T01:00:00Z"; }, remote => { remote.release.draft = true; }]) {
    let changed = false, remote;
    remote = recoveryRemote(local, { download: () => { if (!changed) { changed = true; change(remote); } } });
    await assert.rejects(resume(local, remote), /changed|asset|release|draft/i);
    assert.equal(assertChannelWritesOnly(remote).length, 0);
  }
});
test("recovery: only pinned GitHub asset CDN redirects are followed without Authorization", async t => {
  const local = await recoveryFixture(t);
  let pending;
  const remote = recoveryRemote(local, { download: (asset, bytes) => { pending = bytes; return new Response(null, { status: 302, headers: { Location: `https://release-assets.githubusercontent.com/fixture/${asset.id}` } }); }, cdnReply: () => new Response(pending) });
  await resume(local, remote);
  assert.equal(remote.calls.filter(call => call.url.hostname === "release-assets.githubusercontent.com").length, local.payloads.size);
  for (const location of ["not-a-url", "https://evil.example/asset", "http://release-assets.githubusercontent.com/a", "https://release-assets.githubusercontent.com:8443/a", "https://token@release-assets.githubusercontent.com/a", "https://api.github.com/repos/foreign/repo/releases/assets/1"]) {
    const broken = recoveryRemote(local, { download: () => new Response(null, { status: 302, headers: { Location: location } }) });
    await assert.rejects(resume(local, broken), /redirect|download|origin/i);
    assert.equal(broken.calls.some(call => call.url.hostname !== "api.github.com"), false);
    assert.equal(assertChannelWritesOnly(broken).length, 0);
  }
});
test("recovery: paginated assets are complete and duplicate IDs across page boundaries fail", async t => {
  const local = await recoveryFixture(t, { kind: "desktop", runtimeCount: 96 }), remote = recoveryRemote(local);
  await resume(local, remote);
  assert.ok(remote.calls.some(call => call.url.pathname.endsWith("/assets") && call.url.searchParams.get("page") === "2"));
  const duplicate = recoveryRemote(local, { list: (assets, _read, page) => page === 1 ? assets.slice(0, 100) : [assets[0], ...assets.slice(101)] });
  await assert.rejects(resume(local, duplicate), /duplicate|asset/i);
  assert.equal(assertChannelWritesOnly(duplicate).length, 0);
});
test("recovery: each CAS retry reaudits all assets and the newly signed channel floor", async t => {
  const local = await recoveryFixture(t);
  const remote = recoveryRemote(local, { snapshots: [{}, { manifest: { version: "2.0.1", tag: "server-v2.0.1", build: 1 } }], conflicts: 1 });
  await assert.rejects(resume(local, remote), /backwards/);
  assert.equal(remote.downloads.length, local.payloads.size * 2);
  assert.equal(assertChannelWritesOnly(remote).filter(call => call.url.pathname.endsWith("/git/trees")).length, 1);
  const corrupt = recoveryRemote(local, { snapshots: [{}, {}], conflicts: 1, download: (asset, bytes) => corrupt.downloads.length > local.payloads.size && asset.name === "server-x64.tar.gz" ? new Response(Buffer.from(bytes).fill(0x78)) : null });
  await assert.rejects(resume(local, corrupt), /asset|integrity|SHA/i);
  assert.equal(assertChannelWritesOnly(corrupt).filter(call => call.url.pathname.endsWith("/git/trees")).length, 1);
});
test("recovery: a concurrent identical promotion becomes an audited no-op on retry", async t => {
  const local = await recoveryFixture(t), remote = recoveryRemote(local, { snapshots: [{}, { body: local.body, signature: local.signature }], conflicts: 1 });
  assert.deepEqual(await resume(local, remote), { tag: local.manifest.tag, changed: false });
  assert.equal(remote.downloads.length, local.payloads.size * 2);
  assert.equal(assertChannelWritesOnly(remote).filter(call => call.url.pathname.endsWith("/git/trees")).length, 1);
});
test("recovery: local tampering, wrong signatures and legacy transitions remain hard failures", async t => {
  const local = await recoveryFixture(t), remote = recoveryRemote(local);
  await writeFile(join(local.directory, "server-x64.tar.gz"), "tampered");
  await assert.rejects(resume(local, remote), /integrity/);
  assert.equal(remote.calls.length, 0);
  const unsigned = await recoveryFixture(t), wrongSignature = recoveryRemote(unsigned);
  await writeFile(join(unsigned.directory, `${unsigned.name}.sig`), "invalid-local-signature");
  await assert.rejects(resume(unsigned, wrongSignature), /signature/);
  assert.equal(wrongSignature.calls.length, 0);
  const desktop = await recoveryFixture(t, { kind: "desktop" });
  const body = Buffer.from(JSON.stringify({ ...desktop.manifest, legacyTransitions: [{ format: "tauri-nsis-v1" }] }));
  await writeFile(join(desktop.directory, desktop.name), body);
  await writeFile(join(desktop.directory, `${desktop.name}.sig`), signed(body));
  const blocked = recoveryRemote(desktop);
  await assert.rejects(resume(desktop, blocked), /cannot unlock|blocked/);
  assert.equal(blocked.calls.length, 0);
});

test("recovery: transport rejects release/asset/non-channel/force writes before calling fetch", async () => {
  let called = false;
  const api = github({ repository: "fixture/releases", token: "test-only-token", channelOnly: true, fetchImpl: () => { called = true; throw new Error("must not fetch"); } });
  for (const [path, method, body] of [["/releases", "POST", {}], ["/releases/51", "PATCH", { draft: false }], ["/releases/assets/100", "DELETE", {}], ["/git/refs/heads/main", "PATCH", { force: false }], ["/git/refs/heads/release-channels", "PATCH", { force: true }], ["/git/refs", "POST", { ref: "refs/heads/main" }]]) {
    await assert.rejects(api(`/repos/fixture/releases${path}`, { method, body }), /forbids/);
  }
  await assert.rejects(api("https://uploads.github.com/anything", { method: "GET", upload: true }), /forbids/);
  await assert.rejects(api("/repos/foreign/repository/releases/assets/1", { download: true }), /outside/);
  await assert.rejects(api("/repos/fixture/releases/git/refs", { method: "POST", body: { ref: "refs/heads/release-channels", force: true } }), /forbids/);
  assert.equal(called, false);
});

test("recovery: desktop and server beta identities promote only their own signed channel paths", async t => {
  for (const kind of ["desktop", "server"]) {
    const local = await recoveryFixture(t, { kind, version: "2.0.0-beta.1" }), remote = recoveryRemote(local);
    assert.deepEqual(await resume(local, remote), { tag: local.manifest.tag, changed: true });
    const tree = assertChannelWritesOnly(remote).find(call => call.url.pathname.endsWith("/git/trees"));
    assert.deepEqual(tree.body.tree.map(value => value.path), [`${kind === "server" ? "server-" : ""}beta.json`, `${kind === "server" ? "server-" : ""}beta.json.sig`]);
  }
});

test("recovery: broken/orphaned/newer signed floor rejects before initial writes or a second CAS attempt", async t => {
  const local = await recoveryFixture(t);
  for (const snapshot of [{ signature: Buffer.from("broken-signature") }, { missingSignature: true }, { missingJson: true }, { manifest: { version: "2.0.1", tag: "server-v2.0.1", build: 1 } }]) {
    for (const retry of [false, true]) {
      const remote = recoveryRemote(local, { snapshots: retry ? [{}, snapshot] : [snapshot], conflicts: retry ? 1 : 0 });
      await assert.rejects(resume(local, remote), /signature|both exist|backwards/);
      assert.equal(assertChannelWritesOnly(remote).filter(call => call.url.pathname.endsWith("/git/trees")).length, retry ? 1 : 0);
    }
  }
});

test("recovery: valid CAS retry advances the new parent, persistent conflict exits after three audited attempts", async t => {
  const local = await recoveryFixture(t), remote = recoveryRemote(local, { snapshots: [{}, { manifest: { version: "1.9.1", tag: "server-v1.9.1" } }], conflicts: 1 });
  assert.deepEqual(await resume(local, remote), { tag: local.manifest.tag, changed: true });
  const commits = assertChannelWritesOnly(remote).filter(call => call.url.pathname.endsWith("/git/commits"));
  assert.deepEqual(commits.map(call => call.body.parents), [["1".repeat(40)], ["2".repeat(40)]]);
  assert.equal(remote.downloads.length, local.payloads.size * 2);
  const conflicted = recoveryRemote(local, { snapshots: [{}], conflicts: 3 });
  await assert.rejects(resume(local, conflicted), /422/);
  assert.equal(conflicted.downloads.length, local.payloads.size * 3);
  assert.equal(assertChannelWritesOnly(conflicted).filter(call => call.url.pathname.endsWith("/git/trees")).length, 3);
});

test("recovery: concurrent creation of the missing channel branch is audited again before no-op", async t => {
  const local = await recoveryFixture(t), remote = recoveryRemote(local, { snapshots: [null, { body: local.body, signature: local.signature }], conflicts: 1 });
  assert.deepEqual(await resume(local, remote), { tag: local.manifest.tag, changed: false });
  assert.equal(remote.downloads.length, local.payloads.size * 2);
  assert.equal(assertChannelWritesOnly(remote).filter(call => call.url.pathname.endsWith("/git/refs") && call.method === "POST").length, 1);
});

test("recovery: local SHA256SUMS must exactly cover signed unique payloads before network access", async t => {
  const local = await recoveryFixture(t), original = local.payloads.get("SHA256SUMS").toString(), first = original.split("\n")[0];
  for (const value of [`${original}${"0".repeat(64)}  unknown.dat\n`, `${original}${first}\n`, `${first}\n`, original.replace(/^[a-f0-9]{64}/, "0".repeat(64)), ""]) {
    await writeFile(join(local.directory, "SHA256SUMS"), value);
    const remote = recoveryRemote(local);
    await assert.rejects(resume(local, remote), /checksum|SHA256SUMS/i);
    assert.equal(remote.calls.length, 0);
  }
});
