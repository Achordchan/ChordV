import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertChannelPromotion, publishRelease, verifyManifestSignature } from "./publish-github-release.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "chordv-publish-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("test-only-server-archive"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schemaVersion: 1, version: "2.0.0", tag: "server-v2.0.0", channel: "stable", build: 17,
    minimumVersion: "0.0.0", forceUpgrade: false, title: "ChordV Server 2.0.0", changelog: ["测试发布"],
    publishedAt: "2026-11-16T00:00:00Z", sourceCommit: "a".repeat(40),
    servers: ["x64", "arm64"].map(architecture => ({
      platform: "linux", architecture, fileName: architecture === "x64" ? "server.tar.gz" : "server-arm64.tar.gz", sha256, sizeBytes: bytes.length,
      buildInfo: { version: "2.0.0", commit: "a".repeat(40), builtAt: "2026-11-16T00:00:00.000Z", platform: "linux", architecture }
    }))
  };
  const body = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(directory, "server.tar.gz"), bytes);
  await writeFile(join(directory, "server-arm64.tar.gz"), bytes);
  await writeFile(join(directory, "chordv-server-release.json"), body);
  await writeFile(join(directory, "chordv-server-release.json.sig"), sign(null, body, privateKey).toString("base64"));
  await writeFile(join(directory, "SHA256SUMS"), `${sha256}  server.tar.gz\n${sha256}  server-arm64.tar.gz\n`);
  return { directory, manifest, body };
}
const sourceCommit = "a".repeat(40), firstParent = "1".repeat(40), secondParent = "2".repeat(40);
function previousManifest(value) {
  const version = value.version || "1.9.0";
  return { schemaVersion: 1, version, tag: `server-v${version}`, channel: "stable", build: 16, minimumVersion: "0.0.0", servers: [], ...value };
}
function githubFixture({ privateRepository = false, existing = false, corruptUpload = false, current = null, channelSnapshots, existingTag = null, tagObjects = {}, refConflicts = 0 } = {}) {
  const calls = [], assets = [];
  const snapshots = (channelSnapshots ?? (current ? [{ current }] : [])).map((snapshot, index) => {
    const body = Buffer.from(JSON.stringify(previousManifest(snapshot.current || {})));
    return { sha: index ? secondParent : firstParent, ...snapshot, body, signature: snapshot.signature ?? Buffer.from(sign(null, body, privateKey).toString("base64")) };
  });
  let branchReads = 0, release = null, tagCreated = false;
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (input, options) => {
    const url = new URL(input); calls.push({ url, method: options.method, body: typeof options.body === "string" ? JSON.parse(options.body) : undefined });
    assert.ok(["api.github.com", "uploads.github.com"].includes(url.hostname));
    assert.equal(options.headers.Authorization, "Bearer test-only-repository-token");
    if (url.hostname === "uploads.github.com") {
      const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), name = url.searchParams.get("name");
      const asset = { name, size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, state: "uploaded", id: assets.length + 100,
        url: `https://api.github.com/repos/fixture/releases/releases/assets/${assets.length + 100}`, bytes };
      if (corruptUpload && name === "server.tar.gz") asset.digest = `sha256:${"0".repeat(64)}`;
      assets.push(asset); return reply(asset, 201);
    }
    const path = url.pathname.replace("/repos/fixture/releases", "");
    if (path === "") return reply({ private: privateRepository, default_branch: "main", archived: false });
    if (path.startsWith("/contents/")) {
      const snapshot = snapshots.find(item => item.sha === url.searchParams.get("ref")) ?? snapshots[Math.min(branchReads - 1, snapshots.length - 1)];
      if (!snapshot || (path.endsWith(".sig") ? snapshot.missingSignature : snapshot.missingJson)) return reply({}, 404);
      return reply({ type: "file", encoding: "base64", content: (path.endsWith(".sig") ? snapshot.signature : snapshot.body).toString("base64") });
    }
    if (path.startsWith("/releases/tags/")) return release ? reply(release) : existing ? reply({ id: 1 }) : reply({}, 404);
    if (path === "/releases" && options.method === "GET") return reply(release && Number(url.searchParams.get("page") || 1) === 1 ? [release] : []);
    if (path === "/releases" && options.method === "POST") {
      tagCreated = true; release = { id: 1, ...JSON.parse(options.body), published_at: null, upload_url: "https://uploads.github.com/repos/fixture/releases/releases/1/assets{?name,label}" };
      return reply(release, 201);
    }
    if (path === "/releases/1/assets") return reply(assets.map(({ bytes: _bytes, ...asset }) => asset).slice((Number(url.searchParams.get("page") || 1) - 1) * 100, Number(url.searchParams.get("page") || 1) * 100));
    if (path.startsWith("/releases/assets/")) {
      const asset = assets.find(item => item.id === Number(path.split("/").at(-1)));
      return new Response(asset.bytes, { headers: { "Content-Length": String(asset.bytes.length) } });
    }
    if (path === "/releases/1" && options.method === "GET") return reply(release);
    if (path === "/releases/1" && options.method === "PATCH") { Object.assign(release, JSON.parse(options.body), { published_at: "2026-11-18T00:00:00Z" }); return reply(release); }
    if (path.startsWith("/git/ref/tags/")) return existingTag || tagCreated ? reply({ object: existingTag || { type: "commit", sha: sourceCommit } }) : reply({}, 404);
    if (path.startsWith("/git/tags/")) return reply({ sha: path.split("/").at(-1), object: tagObjects[path.split("/").at(-1)] });
    if (path === "/git/ref/heads/release-channels") {
      const snapshot = snapshots[Math.min(branchReads++, snapshots.length - 1)];
      return snapshot ? reply({ object: { type: "commit", sha: snapshot.sha } }) : reply({}, 404);
    }
    if (path.startsWith("/git/commits/")) return reply({ sha: path.split("/").at(-1), tree: { sha: "3".repeat(40) } });
    if (path === "/git/refs/heads/release-channels") return refConflicts-- > 0 ? reply({}, 422) : reply({ object: { sha: "4".repeat(40) } });
    if (["/git/blobs", "/git/trees", "/git/commits", "/git/refs"].includes(path)) return reply({ sha: "test-only-git-object" }, 201);
    throw new Error(`Unexpected offline GitHub fixture request: ${options.method} ${url}`);
  };
  return { calls, assets, fetchImpl };
}
function options(directory, fetchImpl) { return { repository: "fixture/releases", token: "test-only-repository-token", directory, kind: "server", pinnedPublicKey: publicPem, fetchImpl }; }

test("even signed desktop manifests cannot relabel local, stale-build or cross-source package identities", async t => {
  const { directory } = await fixture(t);
  const commit = "a".repeat(40);
  const base = {
    schemaVersion: 1, version: "2.0.0", tag: "v2.0.0", channel: "stable", build: 17, sourceCommit: commit, minimumVersion: "0.0.0", changelog: [],
    installers: ["macos:x64", "macos:arm64", "windows:x64", "windows:arm64"].map(target => {
      const [platform, architecture] = target.split(":");
      return { platform, architecture, fileName: `${platform}-${architecture}`, buildInfo: { version: "2.0.0", build: 17, mode: "release", platform, architecture, commit } };
    }), runtimeComponents: []
  };
  for (const change of [{ mode: "local" }, { version: "1.0.0" }, { build: 16 }, { commit: "b".repeat(40) }, { architecture: "arm64" }]) {
    const manifest = structuredClone(base); Object.assign(manifest.installers[0].buildInfo, change);
    const body = Buffer.from(JSON.stringify(manifest));
    await writeFile(join(directory, "chordv-release.json"), body);
    await writeFile(join(directory, "chordv-release.json.sig"), sign(null, body, privateKey).toString("base64"));
    await assert.rejects(publishRelease({ ...options(directory, () => { throw new Error("metadata rejection must happen before any network access"); }), kind: "desktop" }), /Desktop package .* mismatch/);
  }
});

test("standard detached Ed25519 signatures validate exact bytes only", () => {
  const body = Buffer.from('{"version":"2.0.0"}'), signature = sign(null, body, privateKey).toString("base64");
  verifyManifestSignature(body, signature, publicPem);
  verifyManifestSignature(body, signature, publicKey.export({ type: "spki", format: "der" }).toString("base64"));
  assert.throws(() => verifyManifestSignature(Buffer.from(`${body} `), signature, publicPem), /verification failed/);
});

test("a signed manifest cannot self-declare that legacy Windows installation semantics were accepted", async t => {
  const { directory, manifest: server } = await fixture(t);
  const manifest = { ...server, tag: "v2.0.0", runtimeComponents: [], installers: ["macos:x64","macos:arm64","windows:x64","windows:arm64"].map(target => {
    const [platform,architecture] = target.split(":");
    return { ...server.servers[0],platform,architecture,buildInfo:{version:server.version,build:server.build,mode:"release",platform,architecture,commit:server.sourceCommit} };
  }), legacyTransitions: [{ verified:true, format:"tauri-nsis-v1" }] };
  const body=Buffer.from(JSON.stringify(manifest));
  await writeFile(join(directory,"chordv-release.json"),body);
  await writeFile(join(directory,"chordv-release.json.sig"),sign(null,body,privateKey).toString("base64"));
  await assert.rejects(publishRelease({...options(directory,()=>{throw new Error("must reject before network");}),kind:"desktop"}),/cannot unlock/);
});

test("publishes verified immutable assets then commits same manifest+signature to one channel tree", async t => {
  const { directory } = await fixture(t), remote = githubFixture();
  assert.equal(await publishRelease(options(directory, remote.fetchImpl)), "server-v2.0.0");
  assert.equal(remote.assets.length, 5);
  const create = remote.calls.find(call => call.url.pathname.endsWith("/releases") && call.method === "POST");
  assert.equal(create.body.draft, true);
  const publish = remote.calls.find(call => call.url.pathname.endsWith("/releases/1") && call.method === "PATCH");
  assert.equal(publish.body.draft, false); assert.equal(publish.body.make_latest, "false");
  const tree = remote.calls.find(call => call.url.pathname.endsWith("/git/trees"));
  assert.deepEqual(tree.body.tree.map(item => item.path), ["server-stable.json", "server-stable.json.sig"]);
  assert.ok(remote.calls.every(call => call.body?.force !== true));
  assert.ok(remote.calls.every(call => !/backend-manifest|deploy|ssh/.test(call.url.pathname)));
});

test("refuses existing releases instead of clobbering assets", async t => {
  const { directory } = await fixture(t), remote = githubFixture({ existing: true });
  await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /already exists/);
  assert.equal(remote.calls.filter(call => call.method === "POST").length, 0);
});

test("even a valid signature cannot publish incomplete platforms or invented source identities", async t => {
  for (const change of [manifest => { manifest.servers.pop(); }, manifest => { manifest.servers[0].buildInfo.commit = "b".repeat(40); }, manifest => { manifest.servers[0].buildInfo.version = "9.9.9"; }]) {
    const { directory, manifest } = await fixture(t), remote = githubFixture();
    change(manifest);
    const body = Buffer.from(JSON.stringify(manifest));
    await writeFile(join(directory, "chordv-server-release.json"), body);
    await writeFile(join(directory, "chordv-server-release.json.sig"), sign(null, body, privateKey).toString("base64"));
    await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /both real platform archives/);
    assert.equal(remote.calls.length, 0, "invalid build identity fails before any network request");
  }
});

test("rejects private asset repositories and mismatched signing keys before publishing", async t => {
  const { directory } = await fixture(t), remote = githubFixture({ privateRepository: true });
  await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /public GitHub repository/);
  assert.equal(remote.calls.filter(call => call.method === "POST").length, 0);
  const other = generateKeyPairSync("ed25519");
  await assert.rejects(publishRelease({ ...options(directory, remote.fetchImpl), pinnedPublicKey: other.publicKey.export({ format: "pem", type: "spki" }).toString() }), /verification failed/);
});

test("upload hash mismatch leaves draft unpublished and never advances channels", async t => {
  const { directory } = await fixture(t), remote = githubFixture({ corruptUpload: true });
  await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /uploaded asset verification failed/);
  assert.equal(remote.calls.filter(call => call.method === "PATCH").length, 0);
  assert.equal(remote.calls.filter(call => call.url.pathname.includes("/git/") && call.method !== "GET").length, 0);
});

test("older signed release is rejected before creating a GitHub Release", async t => {
  const { directory } = await fixture(t), remote = githubFixture({ current: { version: "2.0.1", build: 1 } });
  await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /backwards/);
  assert.equal(remote.calls.filter(call => call.method === "POST").length, 0);
  assert.throws(() => assertChannelPromotion({ version: "2.0.0", build: 17 }, { version: "2.0.0", build: 16 }), /backwards/);
  assert.throws(() => assertChannelPromotion({ version: "2.0.0", build: 17 }, { version: "2.0.0", build: 17 }), /backwards/);
  assertChannelPromotion({ version: "2.0.0-beta.2", build: 17 }, { version: "2.0.0-beta.10", build: 18 });
});

test("release contract: a newly created tag targets the manifest source commit, not the moving default branch", async t => {
  const { directory, manifest } = await fixture(t), remote = githubFixture();
  await publishRelease(options(directory, remote.fetchImpl));
  const create = remote.calls.find(call => call.url.pathname.endsWith("/releases") && call.method === "POST");
  assert.equal(create.body.target_commitish, manifest.sourceCommit);
  assert.ok(remote.calls.some(call => call.url.pathname.endsWith(`/git/ref/tags/${manifest.tag}`)));
});

test("release contract: lightweight and nested annotated tags must resolve to the package source before any write", async t => {
  const { directory } = await fixture(t), annotated = "b".repeat(40), nested = "c".repeat(40);
  for (const existingTag of [{ type: "commit", sha: sourceCommit }, { type: "tag", sha: annotated }]) {
    const remote = githubFixture({ existingTag, tagObjects: { [annotated]: { type: "tag", sha: nested }, [nested]: { type: "commit", sha: sourceCommit } } });
    await publishRelease(options(directory, remote.fetchImpl));
    assert.ok(remote.calls.some(call => call.url.pathname.includes("/git/ref/tags/")));
    if (existingTag.type === "tag") assert.deepEqual(new Set(remote.calls.filter(call => call.url.pathname.includes("/git/tags/")).map(call => call.url.pathname.split("/").at(-1))), new Set([annotated, nested]));
  }
  for (const config of [
    { existingTag: { type: "commit", sha: "d".repeat(40) } },
    { existingTag: { type: "tag", sha: annotated }, tagObjects: { [annotated]: { type: "commit", sha: "d".repeat(40) } } },
    { existingTag: { type: "tree", sha: sourceCommit } },
    { existingTag: { type: "tag", sha: annotated }, tagObjects: { [annotated]: { type: "tag", sha: annotated } } }
  ]) {
    const remote = githubFixture(config);
    await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /tag.*source|tag.*commit|tag.*cycle/i);
    assert.equal(remote.calls.filter(call => call.method !== "GET").length, 0);
  }
});

test("release contract: signed previous channel JSON and signature are read from exactly one immutable parent commit", async t => {
  const { directory } = await fixture(t), remote = githubFixture({ current: { version: "1.9.0" } });
  await publishRelease(options(directory, remote.fetchImpl));
  const contents = remote.calls.filter(call => call.url.pathname.includes("/contents/"));
  assert.deepEqual(contents.map(call => [call.url.pathname.split("/").at(-1), call.url.searchParams.get("ref")]), [
    ["server-stable.json", firstParent], ["server-stable.json.sig", firstParent],
    ["server-stable.json", firstParent], ["server-stable.json.sig", firstParent],
    ["server-stable.json", firstParent], ["server-stable.json.sig", firstParent]
  ]);
  const commit = remote.calls.find(call => call.url.pathname.endsWith("/git/commits") && call.method === "POST");
  assert.deepEqual(commit.body.parents, [firstParent]);
});

test("release contract: an orphan, invalid signature or wrong channel/kind is rejected before any GitHub write", async t => {
  const { directory } = await fixture(t);
  const other = generateKeyPairSync("ed25519"), previous = previousManifest({});
  const wrongKeySignature = Buffer.from(sign(null, Buffer.from(JSON.stringify(previous)), other.privateKey).toString("base64"));
  for (const snapshot of [
    { missingJson: true }, { missingSignature: true }, { signature: wrongKeySignature },
    { signature: Buffer.from("not-a-signature") },
    { current: { channel: "beta", tag: "server-v1.9.0-beta.1", version: "1.9.0-beta.1" } },
    { current: { tag: "v1.9.0", installers: [], servers: undefined } },
    { current: { installers: [], servers: undefined } },
    { current: { schemaVersion: 2 } }
  ]) {
    const remote = githubFixture({ channelSnapshots: [snapshot] });
    await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /channel|signature|tag|schema/i);
    assert.equal(remote.calls.filter(call => call.method !== "GET").length, 0);
  }
});

test("release contract: CAS retry refreshes and verifies the newly advanced floor before writing another tree", async t => {
  const { directory } = await fixture(t);
  const remote = githubFixture({ channelSnapshots: [{ sha: firstParent, current: { version: "1.9.0" } }, { sha: firstParent, current: { version: "1.9.0" } }, { sha: firstParent, current: { version: "1.9.0" } }, { sha: secondParent, current: { version: "2.0.1", build: 1 } }], refConflicts: 1 });
  await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /backwards/);
  const contents = remote.calls.filter(call => call.url.pathname.includes("/contents/"));
  assert.deepEqual(contents.slice(-2).map(call => call.url.searchParams.get("ref")), [secondParent, secondParent]);
  assert.equal(remote.calls.filter(call => call.url.pathname.endsWith("/git/trees") && call.method === "POST").length, 1);
  assert.equal(remote.calls.filter(call => call.url.pathname.endsWith("/git/refs/heads/release-channels") && call.method === "PATCH").length, 1);
});

test("release contract: CAS retry rejects a newly broken signature without another write", async t => {
  const { directory } = await fixture(t);
  const remote = githubFixture({ channelSnapshots: [
    { sha: firstParent, current: { version: "1.9.0" } }, { sha: firstParent, current: { version: "1.9.0" } },
    { sha: firstParent, current: { version: "1.9.0" } },
    { sha: secondParent, current: { version: "1.9.1" }, signature: Buffer.from("broken-after-CAS") }
  ], refConflicts: 1 });
  await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /signature/);
  assert.equal(remote.calls.filter(call => call.url.pathname.endsWith("/git/trees") && call.method === "POST").length, 1);
  assert.equal(remote.calls.filter(call => call.url.pathname.endsWith("/git/blobs") && call.method === "POST").length, 2);
  assert.deepEqual(remote.calls.filter(call => call.url.pathname.includes("/contents/")).slice(-2).map(call => call.url.searchParams.get("ref")), [secondParent, secondParent]);
});

test("release contract: valid CAS retry builds on the newly verified parent without force updates", async t => {
  const { directory } = await fixture(t);
  const remote = githubFixture({ channelSnapshots: [
    { sha: firstParent, current: { version: "1.9.0" } }, { sha: firstParent, current: { version: "1.9.0" } },
    { sha: firstParent, current: { version: "1.9.0" } },
    { sha: secondParent, current: { version: "1.9.1" } }
  ], refConflicts: 1 });
  await publishRelease(options(directory, remote.fetchImpl));
  const commits = remote.calls.filter(call => call.url.pathname.endsWith("/git/commits") && call.method === "POST");
  assert.deepEqual(commits.map(call => call.body.parents), [[firstParent], [secondParent]]);
  assert.ok(remote.calls.filter(call => call.method === "PATCH" && call.url.pathname.includes("/git/refs/")).every(call => call.body.force === false));
});

test("release contract: publisher rejects noncanonical, absent or forward minimum versions even when signed", async t => {
  const { directory, manifest } = await fixture(t);
  for (const minimumVersion of ["v1.0.0", "2.0.1", undefined, "not-semver"]) {
    const body = Buffer.from(JSON.stringify({ ...manifest, minimumVersion }));
    await writeFile(join(directory, "chordv-server-release.json"), body);
    await writeFile(join(directory, "chordv-server-release.json.sig"), sign(null, body, privateKey).toString("base64"));
    const remote = githubFixture();
    await assert.rejects(publishRelease(options(directory, remote.fetchImpl)), /minimum|version/i);
    assert.equal(remote.calls.length, 0);
  }
});
