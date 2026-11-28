import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as publication from "./publish-github-release.mjs";
import { recoveryFixture, signed } from "./fixtures/resume-release.mjs";
import { httpReleaseAPI } from "./fixtures/release-http.mjs";
import { createRecoveryBundle } from "./release-recovery-bundle.mjs";
import { github } from "./github-release-client.mjs";
import { uploadReleaseAsset } from "./github-release-upload.mjs";

async function partial(t, fixtureOptions = {}) {
  const local = await recoveryFixture(t, { binding: true, ...fixtureOptions }), remote = await httpReleaseAPI(t);
  let uploads = 0;
  remote.faults.before = ({ url }) => url.hostname === "uploads.github.com" && ++uploads === 2 ? new Response("{}", { status: 502 }) : null;
  await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /502.*\n.*complete-draft 51/s);
  remote.faults.before = null;
  return { local, remote, options: { ...local.options, fetchImpl: remote.fetchImpl, releaseId: 51 } };
}

test("complete-draft: resumes a signed schema2 partial draft by explicit ID over actual Git and HTTP", async t => {
  const local = await recoveryFixture(t, { binding: true }), remote = await httpReleaseAPI(t);
  let uploads = 0;
  remote.faults.before = ({ url }) => url.hostname === "uploads.github.com" && ++uploads === 2 ? new Response("{}", { status: 502 }) : null;
  await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /502/);
  const original = remote.assets.values().next().value, tag = remote.git(["rev-parse", `refs/tags/${local.manifest.tag}`]);
  remote.faults.before = null; const mark = remote.requests.length;
  assert.equal(typeof publication.completeDraft, "function", "production CLI must expose explicit draft completion");
  assert.deepEqual(await publication.completeDraft({ ...local.options, fetchImpl: remote.fetchImpl, releaseId: 51 }), { tag: local.manifest.tag, changed: true });
  assert.equal(remote.release().draft, false); assert.equal(remote.assets.size, local.payloads.size);
  assert.strictEqual(remote.assets.get(original.id), original);
  assert.equal(remote.git(["rev-parse", `refs/tags/${local.manifest.tag}`]), tag);
  const writes = remote.requests.slice(mark).filter(call => call.method !== "GET");
  assert.equal(writes.filter(call => call.host === "uploads.github.com").length, local.payloads.size - 1);
  assert.ok(writes.filter(call => call.host === "uploads.github.com").every(call => Number(call.contentLength) === call.bodyBytes && call.bodyBytes > 0));
  assert.ok(writes.every(call => call.method !== "DELETE" && !call.path.includes("/git/refs/tags/")));
});

test("publisher: authenticated draft inventory prevents recreating a draft hidden by tag lookup", async t => {
  const local = await recoveryFixture(t, { binding: true }), remote = await httpReleaseAPI(t);
  let uploads = 0;
  remote.faults.before = ({ url }) => url.hostname === "uploads.github.com" && ++uploads === 2 ? new Response("{}", { status: 502 }) : null;
  await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /502/);
  remote.faults.before = ({ url }) => url.pathname.includes("/releases/tags/") ? new Response("{}", { status: 404 }) : null;
  const mark = remote.requests.length;
  await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /complete-draft 51/);
  assert.ok(remote.requests.slice(mark).every(call => call.method === "GET"));
});

test("publisher: actual remote bytes are audited before a draft becomes public", async t => {
  const local = await recoveryFixture(t, { binding: true }), remote = await httpReleaseAPI(t);
  remote.faults.after = async ({ url, options, response }) => {
    if (options.method === "GET" && /\/releases\/assets\/\d+$/.test(url.pathname)) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return new Response(Buffer.alloc(bytes.length, 120), { headers: { "Content-Length": String(bytes.length) } });
    }
  };
  await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /integrity|SHA/);
  assert.equal(remote.release().draft, true);
  assert.ok(!remote.requests.some(call => call.method === "PATCH"));
});

test("complete-draft: response-lost upload and a fully uploaded unpublished draft do not re-upload correct assets", async t => {
  for (const mode of ["lost-upload-response", "complete"]) await t.test(mode, async t => {
    const local = await recoveryFixture(t, { binding: true }), remote = await httpReleaseAPI(t);
    let count = 0;
    remote.faults.after = ({ url, options }) => mode === "complete"
      ? options.method === "PATCH" && url.pathname.endsWith("/releases/51") ? new Response("{}", { status: 502 }) : null
      : url.hostname === "uploads.github.com" && ++count === 2 ? new Response("{}", { status: 502 }) : null;
    if (mode === "complete") remote.faults.before = ({ url, options }) => options.method === "PATCH" && url.pathname.endsWith("/releases/51") ? new Response("{}", { status: 502 }) : null;
    await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /502/);
    assert.equal(remote.release().draft, true);
    const stored = remote.assets.size; assert.equal(stored, mode === "complete" ? local.payloads.size : 2);
    remote.faults.after = remote.faults.before = null; const mark = remote.requests.length;
    await publication.completeDraft({ ...local.options, fetchImpl: remote.fetchImpl, releaseId: 51 });
    assert.equal(remote.requests.slice(mark).filter(call => call.host === "uploads.github.com").length, local.payloads.size - stored);
  });
});

test("complete-draft: starter, extra, duplicate and erroneous existing assets reject before any write", async t => {
  for (const mode of ["starter", "extra", "duplicate-name", "duplicate-id", "wrong-bytes", "wrong-header", "foreign-asset-url"]) await t.test(mode, async t => {
    const { local, remote, options } = await partial(t);
    const first = remote.assets.values().next().value, original = Buffer.from(first.bytes);
    if (mode === "extra") remote.assets.set(999, { id: 999, name: "extra.dat", bytes: Buffer.from("extra") });
    if (mode === "wrong-bytes") first.bytes = Buffer.alloc(original.length, 120);
    remote.faults.after = async ({ url, response }) => {
      if (url.pathname.endsWith("/releases/51/assets")) {
        const rows = await response.json();
        if (mode === "starter") Object.assign(rows[0], { state: "starter", size: 0 });
        if (mode === "duplicate-name") rows.push({ ...rows[0], id: 998 });
        if (mode === "duplicate-id") rows.push({ ...rows[0], name: [...local.payloads.keys()][1] });
        if (mode === "wrong-bytes") rows[0].digest = `sha256:${local.manifest.servers[0].sha256}`;
        if (mode === "foreign-asset-url") rows[0].url = "https://api.github.com/repos/foreign/repo/releases/assets/100";
        return new Response(JSON.stringify(rows));
      }
      if (mode === "wrong-header" && /\/releases\/assets\/\d+$/.test(url.pathname)) return new Response(original, { headers: { "Content-Length": String(original.length + 1) } });
    };
    const mark = remote.requests.length;
    await assert.rejects(publication.completeDraft(options), /asset|integrity|SHA|length|list/i);
    assert.ok(remote.requests.slice(mark).every(call => call.method === "GET"));
    assert.equal(remote.release().draft, true);
  });
});

test("complete-draft: recipient upload URL is bound to the canonical repository and explicit release ID", async t => {
  for (const url of ["https://uploads.github.com/repos/foreign/repo/releases/51/assets", "https://uploads.github.com/repos/fixture/releases/releases/52/assets", "https://uploads.github.com/repos/fixture/releases/releases/51/assets?label=other", "https://user@uploads.github.com/repos/fixture/releases/releases/51/assets"]) await t.test(url, async t => {
    const { remote, options } = await partial(t); remote.release().upload_url = url;
    const mark = remote.requests.length;
    await assert.rejects(publication.completeDraft(options), /upload endpoint/);
    assert.ok(remote.requests.slice(mark).every(call => call.method === "GET"));
  });
});

test("complete-draft: actual metadata tree and original raw signature must still match the saved signed bundle", async t => {
  for (const mode of ["parent", "raw-signature", "signed-other-source", "wrong-local-payload"]) await t.test(mode, async t => {
    const { local, remote, options } = await partial(t);
    if (mode === "parent") {
      const ref = `refs/tags/${local.manifest.tag}`, old = remote.git(["rev-parse", ref]);
      const next = remote.git(["commit-tree", remote.git(["rev-parse", old + "^{tree}"]), "-p", old, "-m", "bad history"]);
      remote.git(["update-ref", ref, next, old]);
    }
    if (mode === "raw-signature") await writeFile(join(local.directory, local.name + ".sig"), Buffer.concat([local.signature, Buffer.from("\n")]));
    if (mode === "signed-other-source") {
      const manifest = structuredClone(local.manifest); manifest.sourceCommit = "b".repeat(40);
      for (const asset of manifest.servers) asset.buildInfo.commit = manifest.sourceCommit;
      const body = Buffer.from(JSON.stringify(manifest));
      await writeFile(join(local.directory, local.name), body); await writeFile(join(local.directory, local.name + ".sig"), signed(body));
    }
    if (mode === "wrong-local-payload") await writeFile(join(local.directory, local.manifest.servers[0].fileName), "wrong payload");
    const mark = remote.requests.length;
    await assert.rejects(publication.completeDraft(options), /parent|blob|signature|length|integrity/i);
    assert.ok(remote.requests.slice(mark).every(call => call.method === "GET"));
    if (mode === "wrong-local-payload") assert.equal(remote.requests.length, mark);
  });
});

test("complete-draft: explicit ID and unpublished identity are mandatory, not inferred from a tag lookup", async t => {
  const { remote, options } = await partial(t);
  for (const releaseId of [undefined, "51", 0, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const mark = remote.requests.length;
    await assert.rejects(publication.completeDraft({ ...options, releaseId }), /explicit positive release ID/);
    assert.equal(remote.requests.length, mark);
  }
  const original = structuredClone(remote.release());
  for (const change of [{ id: 52 }, { draft: false, published_at: "2026-11-18T00:00:00Z" }, { tag_name: "wrong" }, { prerelease: true }, { published_at: "2026-11-18T00:00:00Z" }]) {
    Object.assign(remote.release(), original, change); const mark = remote.requests.length;
    await assert.rejects(publication.completeDraft(options), /matching unpublished draft release ID/);
    assert.ok(remote.requests.slice(mark).every(call => call.method === "GET"));
  }
});

test("complete-draft: published release with channel failure is recovered only through the existing resume-channel", async t => {
  const { local, remote, options } = await partial(t); remote.state.failChannel = true;
  await assert.rejects(publication.completeDraft(options), /resume-channel/);
  assert.equal(remote.release().draft, false); const mark = remote.requests.length;
  await assert.rejects(publication.completeDraft(options), /unpublished draft/);
  assert.ok(remote.requests.slice(mark).every(call => call.method === "GET"));
  remote.state.failChannel = false; const start = remote.requests.length;
  assert.deepEqual(await publication.resumeChannel({ ...local.options, fetchImpl: remote.fetchImpl }), { tag: local.manifest.tag, changed: true });
  assert.ok(remote.requests.slice(start).filter(call => call.method !== "GET").every(call => call.path.includes("/git/")));
});

test("complete-draft: transport capability rejects deletes, unrelated IDs/refs and undeclared uploads", async () => {
  let calls = 0;
  const api = github({ repository: "fixture/releases", token: "test-only-token", draftOnly: { releaseId: 51, files: ["expected.dat"] }, fetchImpl: () => { calls++; throw new Error("must not fetch"); } });
  for (const [path, options] of [
    ["/repos/fixture/releases/releases/assets/100", { method: "DELETE" }],
    ["/repos/fixture/releases/releases/52", { method: "PATCH", body: { draft: false, make_latest: "false" } }],
    ["/repos/fixture/releases/releases/51", { method: "PATCH", body: { draft: false, make_latest: "false", name: "other" } }],
    ["/repos/fixture/releases/git/refs", { method: "POST", body: { ref: "refs/heads/release-channels" } }],
    ["https://uploads.github.com/repos/fixture/releases/releases/51/assets?name=extra.dat", { method: "POST", upload: true }],
    ["https://uploads.github.com/repos/foreign/repo/releases/51/assets?name=expected.dat", { method: "POST", upload: true }],
    ["https://uploads.github.com/repos/fixture/releases/releases/52/assets?name=expected.dat", { method: "POST", upload: true }],
    ["https://uploads.github.com/repos/fixture/releases/releases/51/assets?name=expected.dat&name=expected.dat", { method: "POST", upload: true }]
  ]) await assert.rejects(api(path, options), /forbids/);
  assert.equal(calls, 0);
});

test("publisher: draft discovery reads all pages, reports every matching ID and fails closed at its bound", async t => {
  for (const mode of ["multiple", "bound"]) await t.test(mode, async t => {
    const local = await recoveryFixture(t, { binding: true }), remote = await httpReleaseAPI(t);
    remote.faults.before = ({ url, options }) => {
      if (options.method !== "GET" || url.pathname !== "/repos/fixture/releases/releases") return null;
      const page = Number(url.searchParams.get("page"));
      const rows = Array.from({ length: 100 }, (_, n) => ({ id: page * 100 + n, tag_name: "unrelated", draft: true }));
      if (mode === "multiple") { if (page === 1) rows[99] = { id: 51, tag_name: local.manifest.tag, draft: true }; else return new Response(JSON.stringify([{ id: 52, tag_name: local.manifest.tag, draft: true }])); }
      return new Response(JSON.stringify(rows));
    };
    await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), mode === "multiple" ? /Matching release IDs: 51, 52/ : /exceeded 100 pages/);
    assert.ok(remote.requests.every(call => call.method === "GET"));
    assert.equal(remote.requests.filter(call => call.path === "/repos/fixture/releases/releases").length, mode === "multiple" ? 2 : 100);
  });
});

test("complete-draft: production CLI consumes restored original recovery bundle without rebuilding or resigning", async t => {
  const { local, remote } = await partial(t), directory = await mkdtemp(join(tmpdir(), "chordv-cli-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = await createRecoveryBundle({ ...local.options, output: directory }), restored = join(directory, "restored"); await mkdir(restored);
  const unpack = spawnSync("tar", ["-xzf", bundle.path, "-C", restored], { encoding: "utf8" }); assert.equal(unpack.status, 0, unpack.stderr);
  const preload = join(directory, "http-loader.mjs");
  await writeFile(preload, `const realFetch = globalThis.fetch; globalThis.fetch = (url, input) => realFetch(process.env.RECOVERY_HTTP_ORIGIN, { ...input, headers: { ...input.headers, 'x-original-url': String(url) } });`);
  remote.faults.before = () => null;
  // The fixture exposes its transport URL only to this child process, never production configuration.
  const discover = await remote.fetchImpl("https://api.github.com/repos/fixture/releases", { headers: { Authorization: "Bearer test-only-token" } });
  const origin = discover.url;
  const child = spawn(process.execPath, ["--import", preload, resolve(".github/scripts/publish-github-release.mjs"), "complete-draft", "51"], { env: { ...process.env, CHORDV_RELEASE_REPOSITORY: local.options.repository, CHORDV_RELEASE_TOKEN: local.options.token, VITE_GITHUB_RELEASE_PUBLIC_KEY: local.options.pinnedPublicKey, RELEASE_ASSET_DIR: restored, RELEASE_KIND: local.kind, RECOVERY_HTTP_ORIGIN: origin }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output); assert.match(output, /Completed draft and audited channel/);
  assert.ok((await readFile(join(restored, local.name))).equals(local.body));
  assert.ok((await readFile(join(restored, local.name + ".sig"))).equals(local.signature));
});

test("complete-draft: final re-audit catches an existing asset changed while missing assets upload", async t => {
  const { remote, options } = await partial(t); let changed = false;
  remote.faults.after = ({ url }) => {
    if (!changed && url.hostname === "uploads.github.com") {
      changed = true; const first = remote.assets.values().next().value; first.bytes = Buffer.alloc(first.bytes.length, 120);
    }
  };
  const mark = remote.requests.length;
  await assert.rejects(publication.completeDraft(options), /asset|SHA|integrity/);
  assert.equal(remote.release().draft, true);
  assert.ok(remote.requests.slice(mark).every(call => call.method !== "PATCH" && call.method !== "DELETE"));
});

test("complete-draft: paginated full draft and cross-page duplicate inventory are verified before publishing", async t => {
  const local = await recoveryFixture(t, { binding: true, kind: "desktop", runtimeCount: 96 }), remote = await httpReleaseAPI(t);
  remote.faults.before = ({ url, options }) => options.method === "PATCH" && url.pathname.endsWith("/releases/51") ? new Response("{}", { status: 502 }) : null;
  await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /502/);
  assert.equal(remote.release().draft, true); assert.equal(remote.assets.size, 103);
  remote.faults.before = null;
  remote.faults.after = async ({ url, response }) => {
    if (url.pathname.endsWith("/releases/51/assets") && url.searchParams.get("page") === "2") {
      const rows = await response.json(), first = remote.assets.values().next().value;
      rows[0].id = first.id; return new Response(JSON.stringify(rows));
    }
  };
  const mark = remote.requests.length;
  await assert.rejects(publication.completeDraft({ ...local.options, fetchImpl: remote.fetchImpl, releaseId: 51 }), /duplicate|asset/);
  assert.ok(remote.requests.slice(mark).every(call => call.method === "GET"));
  remote.faults.after = null; const start = remote.requests.length;
  await publication.completeDraft({ ...local.options, fetchImpl: remote.fetchImpl, releaseId: 51 });
  assert.equal(remote.release().draft, false);
  assert.ok(remote.requests.slice(start).every(call => call.host !== "uploads.github.com"));
});

test("publisher: published bytes are re-audited before any channel ref is written", async t => {
  const local = await recoveryFixture(t, { binding: true }), remote = await httpReleaseAPI(t);
  remote.faults.after = ({ url, options }) => {
    if (options.method === "PATCH" && url.pathname.endsWith("/releases/51")) {
      const first = remote.assets.values().next().value; first.bytes = Buffer.alloc(first.bytes.length, 120);
    }
  };
  await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /asset|SHA|integrity/);
  assert.equal(remote.release().draft, false);
  assert.ok(!remote.calls.some(call => call.body?.ref === "refs/heads/release-channels"));
  assert.ok(!remote.calls.some(call => call.method === "PATCH" && call.path.endsWith("/git/refs/heads/release-channels")));
  assert.notEqual(remote.git(["show-ref", "--verify", "refs/heads/release-channels"], undefined, true).status, 0);
});

test("complete-draft: a channel that advances while uploading blocks publication of the older draft", async t => {
  const { local, remote, options } = await partial(t); let updated = false;
  remote.faults.after = ({ url }) => {
    if (!updated && url.hostname === "uploads.github.com") {
      updated = true;
      const body = Buffer.from(JSON.stringify({ ...local.manifest, version: "2.0.1", tag: "server-v2.0.1", build: 18 })), signature = signed(body);
      const entries = [["server-stable.json", body], ["server-stable.json.sig", signature]].map(([name, bytes]) => `100644 blob ${remote.git(["hash-object", "-w", "--stdin"], bytes)}\t${name}\n`).join("");
      const tree = remote.git(["mktree"], entries), commit = remote.git(["commit-tree", tree, "-m", "newer signed channel"]);
      remote.git(["update-ref", "refs/heads/release-channels", commit, "0".repeat(40)]);
    }
  };
  const mark = remote.requests.length;
  await assert.rejects(publication.completeDraft(options), /backwards/);
  assert.equal(remote.release().draft, true);
  assert.ok(remote.requests.slice(mark).every(call => call.method !== "PATCH" && call.method !== "DELETE"));
});

test("complete-draft: schema1 retains its actual source-commit tag rule, with no metadata-tree reinterpretation", async t => {
  const local = await recoveryFixture(t), remote = await httpReleaseAPI(t);
  const tree = remote.git(["mktree"], ""), source = remote.git(["commit-tree", tree, "-m", "public source"]);
  const manifest = { ...local.manifest, sourceCommit: source, servers: local.manifest.servers.map(asset => ({ ...asset, buildInfo: { ...asset.buildInfo, commit: source } })) };
  const body = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(local.directory, local.name), body); await writeFile(join(local.directory, local.name + ".sig"), signed(body));
  const ref = `refs/tags/${manifest.tag}`; remote.git(["update-ref", ref, source, "0".repeat(40)]);
  let uploads = 0;
  remote.faults.before = ({ url }) => url.hostname === "uploads.github.com" && ++uploads === 1 ? new Response("{}", { status: 502 }) : null;
  await assert.rejects(publication.publishRelease({ ...local.options, fetchImpl: remote.fetchImpl }), /502/);
  assert.equal(remote.assets.size, 0); remote.faults.before = null;
  const other = remote.git(["commit-tree", tree, "-p", source, "-m", "other source"]); remote.git(["update-ref", ref, other, source]);
  const options = { ...local.options, fetchImpl: remote.fetchImpl, releaseId: 51 }, mark = remote.requests.length;
  await assert.rejects(publication.completeDraft(options), /manifest source commit/);
  assert.ok(remote.requests.slice(mark).every(call => call.method === "GET"));
  remote.git(["update-ref", ref, source, other]); await publication.completeDraft(options);
  assert.equal(remote.release().draft, false); assert.equal(remote.git(["rev-parse", ref]), source);
  assert.ok(!remote.requests.some(call => call.method === "GET" && call.path.endsWith(`/git/commits/${source}`)));
});

test("upload: absent, zero, fractional, negative and unsafe locked sizes reject before transport", async () => {
  let calls = 0;
  const api = github({ repository: "fixture/releases", token: "test-only-token", fetchImpl: () => { calls++; throw new Error("must not fetch"); } });
  for (const uploadSize of [undefined, 0, -1, 1.5, NaN, "12", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(api("https://uploads.github.com/repos/fixture/releases/releases/51/assets?name=payload.dat", { upload: true, uploadSize, method: "POST" }), /locked upload size/);
  }
  assert.equal(calls, 0);
});

test("upload: transport and metadata stream failures always destroy the owned input stream", async t => {
  const local = await recoveryFixture(t), file = local.manifest.servers[0];
  const context = { repository: local.options.repository, directory: local.directory, expectedAssets: [file] };
  for (const mode of ["network", "invalid-json", "response-stream"]) {
    let inputStream;
    const api = github({ repository: local.options.repository, token: "test-only-token", fetchImpl: async (_url, options) => {
      inputStream = options.body;
      assert.equal(options.headers["Content-Length"], String(file.sizeBytes));
      if (mode === "network") throw new Error("injected transport failure");
      return mode === "invalid-json" ? new Response("{", { status: 201 }) : new Response(new ReadableStream({ start(controller) { controller.error(new Error("injected metadata stream failure")); } }), { status: 201 });
    } });
    await assert.rejects(uploadReleaseAsset(api, context, { id: 51, upload_url: "https://uploads.github.com/repos/fixture/releases/releases/51/assets{?name}" }, file.fileName));
    assert.equal(inputStream.destroyed, true);
    if (!inputStream.closed) await once(inputStream, "close");
    assert.equal(inputStream.closed, true);
  }
});
