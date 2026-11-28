import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export async function gitReleaseAPI(t, { repository = "fixture/releases" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chordv-real-git-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_AUTHOR_NAME: "Release Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Release Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (args, input, fail = false) => {
    const result = spawnSync("git", ["--git-dir=" + directory, "-c", "commit.gpgsign=false", ...args], { input, encoding: "utf8", env, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    if (!fail && result.status !== 0) throw new Error(result.stderr);
    return fail ? result : result.stdout.trim();
  };
  const initialized = spawnSync("git", ["init", "--bare", directory], { encoding: "utf8", env }); assert.equal(initialized.status, 0, initialized.stderr);
  const calls = [], assets = new Map(); let release = null, nextID = 100;
  const state = { failChannel: false, mutate: null };
  const prefix = `/repos/${repository}`;
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (input, options) => {
    const url = new URL(input), method = options.method || "GET";
    assert.equal(options.headers.Authorization, "Bearer test-only-token");
    const body = typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    calls.push({ path: url.pathname, method, body });
    if (url.hostname === "uploads.github.com") {
      const chunks = []; for await (const chunk of options.body) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
      const name = url.searchParams.get("name"), id = nextID++; assets.set(id, { name, bytes, id });
      return reply({ name, size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }, 201);
    }
    assert.equal(url.hostname, "api.github.com"); assert.ok(url.pathname.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() && (url.pathname.length === prefix.length || url.pathname[prefix.length] === "/"));
    const path = url.pathname.slice(prefix.length);
    const metadata = () => [...assets.values()].map(({ name, bytes, id }) => ({ name, size: bytes.length, id, state: "uploaded", url: `https://api.github.com${prefix}/releases/assets/${id}`, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }));
    if (!path) return reply({ private: false, archived: false, default_branch: "main" });
    if (path.startsWith("/releases/tags/")) return release ? reply(release) : reply({}, 404);
    if (path === "/releases" && method === "GET") return reply(release && Number(url.searchParams.get("page") || 1) === 1 ? [release] : []);
    if (path === "/releases/51" && method === "GET") return release ? reply(release) : reply({}, 404);
    if (path === "/releases" && method === "POST") { release = { id: 51, ...body, published_at: null, tag_name: body.tag_name, upload_url: `https://uploads.github.com${prefix}/releases/51/assets{?name}` }; return reply(release, 201); }
    if (path === "/releases/51" && method === "PATCH") { Object.assign(release, body, { published_at: "2026-11-18T00:00:00Z" }); return reply(release); }
    if (path === "/releases/51/assets") { const page = Number(url.searchParams.get("page") || 1); return reply(metadata().slice((page - 1) * 100, page * 100)); }
    if (path.startsWith("/releases/assets/")) { const item = assets.get(Number(path.split("/").at(-1))); return item ? new Response(item.bytes, { headers: { "Content-Length": String(item.bytes.length) } }) : reply({}, 404); }
    let value;
    if (path.startsWith("/git/ref/")) {
      const ref = "refs/" + decodeURIComponent(path.slice("/git/ref/".length)), result = git(["show-ref", "--verify", "--hash", ref], undefined, true);
      if (result.status !== 0) return reply({}, 404);
      const sha = result.stdout.trim(); value = { object: { sha, type: git(["cat-file", "-t", sha]) } };
    } else if (path.startsWith("/git/tags/")) {
      const sha = path.split("/").at(-1), raw = git(["cat-file", "tag", sha]); value = { sha, object: { sha: raw.match(/^object (\S+)/m)[1], type: raw.match(/^type (\S+)/m)[1] } };
    } else if (path.startsWith("/git/commits/")) {
      const sha = path.split("/").at(-1), raw = git(["cat-file", "commit", sha]); value = { sha, tree: { sha: raw.match(/^tree (\S+)/m)[1] }, parents: [...raw.matchAll(/^parent (\S+)/mg)].map(match => ({ sha: match[1] })) };
    } else if (path.startsWith("/git/trees/")) {
      const sha = path.split("/").at(-1), rows = git(["ls-tree", sha]).split("\n").filter(Boolean); value = { sha, truncated: false, tree: rows.map(row => { const [identity, path] = row.split("\t"), [mode, type, sha] = identity.split(" "); return { path, mode, type, sha }; }) };
    } else if (path.startsWith("/git/blobs/")) {
      const sha = path.split("/").at(-1), bytes = spawnSync("git", ["--git-dir=" + directory, "cat-file", "blob", sha], { maxBuffer: 4 * 1024 * 1024 }).stdout; value = { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") };
    } else if (path.startsWith("/contents/")) {
      const file = decodeURIComponent(path.slice("/contents/".length)), parent = url.searchParams.get("ref");
      const result = git(["show", `${parent}:${file}`], undefined, true); if (result.status !== 0) return reply({}, 404);
      // Preserve the original final newline that the text-oriented Git helper intentionally trims elsewhere.
      const bytes = spawnSync("git", ["--git-dir=" + directory, "show", `${parent}:${file}`], { maxBuffer: 4 * 1024 * 1024 }).stdout;
      value = { type: "file", encoding: "base64", content: bytes.toString("base64") };
    } else if (path === "/git/blobs" && method === "POST") return reply({ sha: git(["hash-object", "-w", "--stdin"], Buffer.from(body.content, "base64")) }, 201);
    else if (path === "/git/trees" && method === "POST") {
      const entries = body.base_tree ? git(["ls-tree", body.base_tree]).split("\n").filter(Boolean).map(row => { const [identity, path] = row.split("\t"); return { path, identity }; }) : [];
      for (const item of body.tree) { const previous = entries.find(entry => entry.path === item.path); if (previous) previous.identity = `${item.mode} ${item.type} ${item.sha}`; else entries.push({ path: item.path, identity: `${item.mode} ${item.type} ${item.sha}` }); }
      return reply({ sha: git(["mktree"], entries.map(entry => `${entry.identity}\t${entry.path}\n`).join("")) }, 201);
    } else if (path === "/git/commits" && method === "POST") return reply({ sha: git(["commit-tree", body.tree, ...(body.parents || []).flatMap(parent => ["-p", parent]), "-m", body.message]) }, 201);
    else if ((path === "/git/refs" && method === "POST") || (path.startsWith("/git/refs/") && method === "PATCH")) {
      const ref = method === "POST" ? body.ref : "refs/" + path.slice("/git/refs/".length);
      if (method === "POST" && ref.startsWith("refs/tags/") && state.beforeTagCreate) { const callback = state.beforeTagCreate; state.beforeTagCreate = null; callback({ ref, sha: body.sha }); }
      if (state.failChannel && ref === "refs/heads/release-channels") return reply({}, 422);
      let old = "0".repeat(40);
      if (method === "PATCH") { assert.equal(body.force, false); old = git(["rev-parse", ref]); if (git(["merge-base", "--is-ancestor", old, body.sha], undefined, true).status !== 0) return reply({}, 422); }
      const result = git(["update-ref", ref, body.sha, old], undefined, true); return result.status === 0 ? reply({ ref, object: { sha: body.sha } }, method === "POST" ? 201 : 200) : reply({}, 422);
    } else throw new Error(`Unexpected real-Git fixture: ${method} ${path}`);
    if (state.mutate) value = state.mutate(path, value) ?? value;
    return reply(value);
  };
  return { directory, git, calls, state, fetchImpl, assets, release: () => release };
}
