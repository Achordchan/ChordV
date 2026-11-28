import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const signed = body => Buffer.from(sign(null, body, privateKey).toString("base64"));
export const commit = "a".repeat(40);
export async function recoveryFixture(t, { kind = "server", runtimeCount = 0, version = "2.0.0", binding = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chordv-resume-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("offline-only-release-asset"), descriptor = { sha256: hash(bytes), sizeBytes: bytes.length };
  const manifest = { schemaVersion: 1, version, tag: `${kind === "server" ? "server-" : ""}v${version}`, channel: version.includes("-") ? "beta" : "stable", build: 17, minimumVersion: "0.0.0", forceUpgrade: false, title: `ChordV ${version}`, changelog: ["离线恢复测试"], publishedAt: "2026-11-18T00:00:00Z", sourceCommit: commit };
  if (binding) Object.assign(manifest, { schemaVersion: 2, tagBinding: { mode: "signed-manifest-tree", repository: "fixture/releases" } });
  if (kind === "server") manifest.servers = ["x64", "arm64"].map(architecture => ({ platform: "linux", architecture, fileName: `server-${architecture}.tar.gz`, ...descriptor, buildInfo: { version: manifest.version, commit, platform: "linux", architecture } }));
  else {
    manifest.installers = ["macos:x64", "macos:arm64", "windows:x64", "windows:arm64"].map(target => {
      const [platform, architecture] = target.split(":");
      return { platform, architecture, fileName: `${platform}-${architecture}${platform === "windows" ? "_setup.exe" : ".dmg"}`, ...descriptor, buildInfo: { version: manifest.version, build: manifest.build, mode: "release", commit, platform, architecture } };
    });
    manifest.runtimeComponents = Array.from({ length: runtimeCount }, (_, index) => ({ fileName: `runtime-${index}.dat`, ...descriptor }));
  }
  const name = kind === "server" ? "chordv-server-release.json" : "chordv-release.json";
  const body = Buffer.from(`${JSON.stringify(manifest)}\n`), signature = signed(body);
  const payloads = new Map((manifest.servers ?? [...manifest.installers, ...manifest.runtimeComponents]).map(asset => [asset.fileName, bytes]));
  payloads.set(name, body); payloads.set(`${name}.sig`, signature);
  payloads.set("SHA256SUMS", Buffer.from([...payloads].filter(([file]) => !file.endsWith(".json") && !file.endsWith(".sig")).map(([file, value]) => `${hash(value)}  ${file}\n`).join("")));
  for (const [file, value] of payloads) await writeFile(join(directory, file), value);
  return { directory, kind, manifest, name, body, signature, payloads, options: { repository: "fixture/releases", token: "test-only-token", directory, kind, pinnedPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString() } };
}
export function recoveryRemote(local, config = {}) {
  const prefix = "/repos/fixture/releases", calls = [], downloads = [];
  const assets = [...local.payloads].map(([name, bytes], index) => ({ id: index + 100, name, size: bytes.length, state: "uploaded", digest: `sha256:${hash(bytes)}`, updated_at: "2026-11-18T00:00:00Z", url: `https://api.github.com${prefix}/releases/assets/${index + 100}` }));
  const release = { id: 51, tag_name: local.manifest.tag, draft: false, prerelease: local.manifest.channel === "beta", published_at: "2026-11-18T00:00:00Z", updated_at: "2026-11-18T00:00:00Z", ...config.release };
  const snapshots = (config.snapshots ?? [null]).map((value, index) => {
    if (!value) return null;
    const body = value.body ?? Buffer.from(JSON.stringify({ ...local.manifest, version: "1.9.0", tag: `${local.kind === "server" ? "server-" : ""}v1.9.0`, build: 16, ...value.manifest }));
    return { sha: String(index + 1).repeat(40), body, signature: value.signature ?? signed(body), ...value };
  });
  let branchReads = 0, listReads = 0, conflicts = config.conflicts ?? 0;
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (input, options) => {
    const url = new URL(input), body = typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method, body, headers: options.headers });
    if (url.hostname !== "api.github.com") {
      assert.equal(options.headers.Authorization, undefined, "CDN requests must not receive the API credential");
      if (config.cdnReply) return config.cdnReply(url, options);
      throw new Error(`Unexpected offline CDN request: ${url}`);
    }
    assert.equal(options.headers.Authorization, "Bearer test-only-token");
    assert.ok(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
    const path = url.pathname.slice(prefix.length);
    if (!path) return reply({ private: false, archived: false, default_branch: "main" });
    if (path.startsWith("/releases/tags/")) return config.missingRelease ? reply({}, 404) : reply(release);
    if (path === "/releases/51" && options.method === "GET") return reply(release);
    if (path === "/releases/51/assets") {
      const page = Number(url.searchParams.get("page") || 1); listReads++;
      const selected = config.list ? config.list(assets, listReads, page) : assets.slice((page - 1) * 100, page * 100);
      return reply(selected);
    }
    if (/^\/releases\/assets\/\d+$/.test(path)) {
      const asset = assets.find(item => item.id === Number(path.split("/").at(-1)));
      if (!asset) return reply({}, 404);
      downloads.push(asset.name);
      if (config.download) {
        const response = config.download(asset, local.payloads.get(asset.name), { release, assets, options });
        if (response) return response;
      }
      const bytes = local.payloads.get(asset.name);
      return new Response(new ReadableStream({ start(controller) { const split = Math.max(1, Math.floor(bytes.length / 2)); controller.enqueue(bytes.subarray(0, split)); controller.enqueue(bytes.subarray(split)); controller.close(); } }), { headers: { "Content-Length": String(bytes.length) } });
    }
    if (path.startsWith("/git/ref/tags/")) return config.missingTag ? reply({}, 404) : reply({ object: { type: "commit", sha: config.tagCommit ?? commit } });
    if (path === "/git/ref/heads/release-channels") {
      const snapshot = snapshots[Math.min(branchReads++, snapshots.length - 1)];
      return snapshot ? reply({ object: { type: "commit", sha: snapshot.sha } }) : reply({}, 404);
    }
    if (path.startsWith("/git/commits/")) return reply({ sha: path.split("/").at(-1), tree: { sha: "c".repeat(40) } });
    if (path.startsWith("/contents/")) {
      const snapshot = snapshots.find(value => value?.sha === url.searchParams.get("ref"));
      assert.ok(snapshot, "channel files must be bound to the selected parent SHA");
      if (path.endsWith(".sig") ? snapshot.missingSignature : snapshot.missingJson) return reply({}, 404);
      return reply({ type: "file", encoding: "base64", content: (path.endsWith(".sig") ? snapshot.signature : snapshot.body).toString("base64") });
    }
    if (path === "/git/refs/heads/release-channels" && options.method === "PATCH") {
      assert.equal(body.force, false);
      return conflicts-- > 0 ? reply({}, 422) : reply({ object: { sha: "d".repeat(40) } });
    }
    if (path === "/git/refs" && options.method === "POST") return conflicts-- > 0 ? reply({}, 422) : reply({ sha: "d".repeat(40) }, 201);
    if (options.method === "POST" && ["/git/blobs", "/git/trees", "/git/commits", "/git/refs"].includes(path)) return reply({ sha: "d".repeat(40) }, 201);
    throw new Error(`Unexpected offline recovery request: ${options.method} ${url}`);
  };
  return { calls, assets, release, downloads, fetchImpl };
}
export function assertChannelWritesOnly(remote) {
  const writes = remote.calls.filter(call => call.method !== "GET");
  assert.ok(writes.every(call => /\/git\/(?:blobs|trees|commits|refs)(?:\/heads\/release-channels)?$/.test(call.url.pathname)));
  assert.ok(writes.every(call => call.body?.force !== true));
  return writes;
}
