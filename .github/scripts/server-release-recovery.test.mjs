import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { makeManifest } from "./release-artifacts.mjs";
import { readReleaseArtifacts } from "./github-release-contract.mjs";
import { createRecoveryBundle } from "./release-recovery-bundle.mjs";
import { publishRelease, completeDraft, resumeChannel } from "./publish-github-release.mjs";
import { httpReleaseAPI } from "./fixtures/release-http.mjs";

test("actual server archives survive both draft upload and channel interruption", { timeout: 120_000 }, async t => {
  const source = process.env.CHORDV_TEST_SERVER_RELEASE_DIR;
  if (!source) { t.skip("requires both staged Linux archives and their build descriptors"); return; }
  const workspace = await mkdtemp(join(tmpdir(), "chordv-server-recovery-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const input = join(workspace, "input"), restored = join(workspace, "restored");
  await cp(resolve(source), input, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const base = { kind: "server", repository: "fixture/releases", directory: input, token: "test-only-token",
    pinnedPublicKey: publicKey.export({ type: "spki", format: "pem" }) };
  const version = (await readFile(new URL("../../SYSTEM_VERSION", import.meta.url), "utf8")).trim();
  await makeManifest({ ...base, version, build: 1, tagBindingMode: "signed-manifest-tree",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const original = await readReleaseArtifacts(base);
  const bundle = await createRecoveryBundle({ ...base, output: join(workspace, "recovery") });
  await mkdir(restored);
  execFileSync("tar", ["-xzf", bundle.path, "-C", restored], { timeout: 60_000 });
  const remote = await httpReleaseAPI(t);
  const incoming = { ...base, fetchImpl: remote.fetchImpl }, recovery = { ...incoming, directory: restored };

  let uploads = 0;
  remote.faults.after = ({ url }) => url.hostname === "uploads.github.com" && ++uploads === 2 ? new Response("{}", { status: 502 }) : null;
  await assert.rejects(publishRelease(incoming), /502.*complete-draft 51/s);
  assert.equal(remote.release().draft, true);
  assert.deepEqual([...remote.assets.values()].map(asset => asset.name).sort(), original.manifest.servers.map(asset => asset.fileName).sort());
  const retained = new Map(remote.assets), tagRef = `refs/tags/${original.manifest.tag}`;
  const tag = remote.git(["rev-parse", tagRef]);

  remote.faults.after = null;
  remote.faults.before = ({ url, options }) => options.method === "POST" && url.pathname.endsWith("/git/refs") ? new Response("{}", { status: 502 }) : null;
  const draftStart = remote.requests.length;
  await assert.rejects(completeDraft({ ...recovery, releaseId: 51 }), /502.*resume-channel/s);
  assert.equal(remote.release().draft, false);
  assert.equal(remote.assets.size, original.files.length);
  for (const [id, asset] of retained) assert.strictEqual(remote.assets.get(id), asset);
  const repaired = remote.requests.slice(draftStart).filter(item => item.host === "uploads.github.com");
  assert.deepEqual(repaired.map(item => item.name).sort(), ["SHA256SUMS", original.name, `${original.name}.sig`].sort());
  assert.ok(repaired.every(item => Number(item.contentLength) === item.bodyBytes));
  assert.notEqual(remote.git(["show-ref", "--verify", "refs/heads/release-channels"], undefined, true).status, 0);

  remote.faults.before = null;
  const channelStart = remote.requests.length;
  assert.deepEqual(await resumeChannel(recovery), { tag: original.manifest.tag, changed: true });
  assert.ok(remote.requests.slice(channelStart).filter(item => item.method !== "GET")
    .every(item => item.host === "api.github.com" && /\/git\/(blobs|trees|commits|refs)$/.test(item.path)));
  assert.equal(remote.git(["rev-parse", tagRef]), tag);
  const blob = name => execFileSync("git", [`--git-dir=${remote.directory}`, "show", `refs/heads/release-channels:${name}`]);
  const channel = `server-${original.manifest.channel}.json`;
  assert.ok(blob(channel).equals(original.body));
  assert.ok(blob(`${channel}.sig`).equals(original.signature));
  for (const asset of remote.assets.values()) assert.ok((await readFile(join(restored, asset.name))).equals(asset.bytes));
  const repeated = remote.requests.length;
  assert.deepEqual(await resumeChannel(recovery), { tag: original.manifest.tag, changed: false });
  assert.ok(remote.requests.slice(repeated).every(item => item.method === "GET"));
  assert.ok(!remote.requests.some(item => item.method === "DELETE"));
});
