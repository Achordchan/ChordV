import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { publishRelease, resumeChannel } from "./publish-github-release.mjs";
import { readReleaseArtifacts } from "./github-release-contract.mjs";
import { createRecoveryBundle } from "./release-recovery-bundle.mjs";
import { recoveryFixture, signed } from "./fixtures/resume-release.mjs";
import { gitReleaseAPI } from "./fixtures/git-release-api.mjs";
import { github } from "./github-release-client.mjs";

test("schema2 publishing: private source absent; actual metadata tag/bytes and original resume are bound", async t => {
  const local = await recoveryFixture(t, { binding: true }), remote = await gitReleaseAPI(t);
  assert.equal(await publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), local.manifest.tag);
  const target = remote.git(["rev-parse", `refs/tags/${local.manifest.tag}`]);
  assert.notEqual(target, local.manifest.sourceCommit);
  assert.notEqual(remote.git(["cat-file", "-e", `${local.manifest.sourceCommit}^{commit}`], undefined, true).status, 0);
  assert.equal(remote.git(["rev-list", "--objects", "--no-object-names", target]).split("\n").length, 4);
  assert.ok(remote.calls.find(call => call.path.endsWith("/releases") && call.method === "POST").body.target_commitish === target);
  const before = remote.calls.length;
  assert.deepEqual(await resumeChannel({ ...local.options, fetchImpl: remote.fetchImpl }), { tag: local.manifest.tag, changed: false });
  assert.ok(remote.calls.slice(before).every(call => call.method === "GET"));
  await assert.rejects(publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /already exists|backwards/);
});

test("schema2 publishing: public release with channel failure resumes only channel writes, never rewrites tag", async t => {
  const local = await recoveryFixture(t, { binding: true }), remote = await gitReleaseAPI(t); remote.state.failChannel = true;
  await assert.rejects(publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /422/);
  assert.equal(remote.release().draft, false); const target = remote.git(["rev-parse", `refs/tags/${local.manifest.tag}`]);
  remote.state.failChannel = false; const before = remote.calls.length;
  assert.deepEqual(await resumeChannel({ ...local.options, fetchImpl: remote.fetchImpl }), { tag: local.manifest.tag, changed: true });
  assert.equal(remote.git(["rev-parse", `refs/tags/${local.manifest.tag}`]), target);
  assert.ok(remote.calls.slice(before).filter(call => call.method !== "GET").every(call => /\/git\/(blobs|trees|commits|refs)/.test(call.path)));
});

test("schema2 publishing: schema1 impersonation, wrong signed repo and invalid schema fail before any write", async t => {
  for (const change of [{ schemaVersion: 1 }, { schemaVersion: 3 }, { tagBinding: { mode: "source-commit" } }, { tagBinding: { mode: "signed-manifest-tree", repository: "other/repo" } }]) {
    const local = await recoveryFixture(t, { binding: true }), remote = await gitReleaseAPI(t), body = Buffer.from(JSON.stringify({ ...local.manifest, ...change }));
    await writeFile(join(local.directory, local.name), body); await writeFile(join(local.directory, local.name + ".sig"), signed(body));
    await assert.rejects(publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /schema|mode|repository|binding/i);
    assert.equal(remote.calls.length, 0);
  }
});

test("schema2 publishing: resumed tag with parent history, extra file, truncated tree or changed bytes fails read-only", async t => {
  const local = await recoveryFixture(t, { binding: true }), remote = await gitReleaseAPI(t);
  await publishRelease({ ...local.options, fetchImpl: remote.fetchImpl });
  for (const mutate of [
    (path, value) => path.includes("/git/commits/") ? { ...value, parents: [{ sha: "b".repeat(40) }] } : value,
    (path, value) => path.includes("/git/trees/") ? { ...value, tree: [...value.tree, { path: "source.go", mode: "100644", type: "blob", sha: "b".repeat(40) }] } : value,
    (path, value) => path.includes("/git/trees/") ? { ...value, truncated: true } : value,
    (path, value) => path.includes("/git/blobs/") ? { ...value, content: Buffer.from("wrong-original").toString("base64") } : value
  ]) {
    remote.state.mutate = mutate; const before = remote.calls.length;
    await assert.rejects(resumeChannel({ ...local.options, fetchImpl: remote.fetchImpl }), /metadata|manifest|signature|blob|tree|parent/i);
    assert.ok(remote.calls.slice(before).every(call => call.method === "GET"));
  }
});

test("schema2 publishing: tag create race reuses only an actually matching projection and never overwrites", async t => {
  for (const bad of [false, true]) {
    const local = await recoveryFixture(t, { binding: true }), remote = await gitReleaseAPI(t); let chosen;
    remote.state.beforeTagCreate = ({ ref, sha }) => {
      const tree = remote.git(["rev-parse", `${sha}^{tree}`]);
      chosen = remote.git(["commit-tree", tree, ...(bad ? ["-p", sha] : []), "-m", "concurrent public metadata"]);
      remote.git(["update-ref", ref, chosen, "0".repeat(40)]);
    };
    if (bad) await assert.rejects(publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /parent/);
    else assert.equal(await publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), local.manifest.tag);
    assert.equal(remote.git(["rev-parse", `refs/tags/${local.manifest.tag}`]), chosen);
    assert.ok(remote.calls.every(call => !(call.method === "PATCH" && call.path.includes("/git/refs/tags/"))));
    if (bad) assert.ok(!remote.calls.some(call => call.method === "POST" && call.path.endsWith("/releases")));
  }
});

test("schema2 publishing: canonical identity permits configured case without losing exact public asset scope", async t => {
  const local = await recoveryFixture(t, { binding: true }), remote = await gitReleaseAPI(t);
  const input = { ...local.options, repository: "Fixture/Releases", fetchImpl: remote.fetchImpl };
  await publishRelease(input);
  assert.equal((await resumeChannel(input)).changed, false);
});

test("schema2 metadata JSON is bounded before parsing even at an authorized API path", async () => {
  const api = github({ repository: "owner/repo", token: "test-only-token", fetchImpl: async () => new Response(JSON.stringify({ padding: "x".repeat(65537) })) });
  await assert.rejects(api("/repos/owner/repo/git/trees/" + "a".repeat(40), { maxBytes: 65536 }), /bounded limit/);
});

test("schema2 publishing: actual annotated tag resolves through the same strict metadata verifier", async t => {
  const local = await recoveryFixture(t, { binding: true }), remote = await gitReleaseAPI(t);
  const input = { ...local.options, fetchImpl: remote.fetchImpl }; await publishRelease(input);
  const ref = `refs/tags/${local.manifest.tag}`, commit = remote.git(["rev-parse", ref]);
  const annotated = remote.git(["mktag"], `object ${commit}\ntype commit\ntag ${local.manifest.tag}\ntagger Release Test <test@example.invalid> 1794960000 +0000\n\npublic metadata tag\n`);
  remote.git(["update-ref", ref, annotated, commit]); const before = remote.calls.length;
  assert.equal((await resumeChannel(input)).changed, false);
  assert.ok(remote.calls.slice(before).some(call => call.path.endsWith(`/git/tags/${annotated}`)));
  assert.ok(remote.calls.slice(before).every(call => call.method === "GET"));
});
