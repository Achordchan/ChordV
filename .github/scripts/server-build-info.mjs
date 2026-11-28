import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedValue, verifyAgentDistribution, agentFileNames } from "../../scripts/agent-release-assets.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const buildPackage = "github.com/Achordchan/ChordV/apps/server/internal/buildinfo";
const mainPackage = "github.com/Achordchan/ChordV/apps/server/cmd/chordv-server";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`Server artifact verification failed: ${command} ${args[0]} (${result.error?.message || result.stderr?.trim() || result.status})`);
  return result.stdout;
}
export function sourceCommit() {
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit) || (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)) {
    throw new Error("Release source commit differs from the checked-out Git commit");
  }
  return commit;
}
async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || !info.size) throw new Error(`Missing regular server artifact file: ${path}`);
}
// Validate the entry emitted by our Vite build, not just the presence of an HTML file.
async function verifyAdminEntry(directory, version) {
  const admin = join(directory, "admin");
  if (!(await lstat(admin)).isDirectory()) throw new Error("Invalid admin directory");
  const html = await readFile(join(admin, "index.html"), "utf8");
  const versions = [...html.matchAll(/<meta\s+name="chordv-backend-version"\s+content="([^"]*)"\s*\/?>/g)];
  if (versions.length !== 1 || versions[0][1] !== version) throw new Error("Admin version differs from the server package");
  const scripts = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>/g)];
  const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g)];
  if (!scripts.length || !styles.length || !(await lstat(join(admin, "assets"))).isDirectory()) throw new Error("Missing admin entry assets");
  for (const [items, extension] of [[scripts, ".js"], [styles, ".css"]]) {
    for (const [, address] of items) {
      if (!/^\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(address) || !address.endsWith(extension)) throw new Error("Unexpected admin entry asset path");
      await regularFile(join(admin, address.slice(1)));
    }
  }
}
export async function verifyServerBuild(directory, { version, commit, platform, architecture }) {
  if (!/^[a-f0-9]{40,64}$/.test(commit ?? "")) throw new Error("Invalid expected server source commit");
  const infoPath = join(directory, "build-info.json"), executable = join(directory, "chordv-server");
  await Promise.all([infoPath, executable, join(directory, "DEPLOYMENT.txt"), join(directory, "SERVER-CONFIG.md"), join(directory, "admin/index.html")].map(regularFile));
  try { await lstat(join(directory, "LOCAL-ONLY.txt")); throw new Error("Local-only server builds cannot be published"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const info = JSON.parse(await readFile(infoPath, "utf8"));
  if (info.version !== version || info.commit !== commit || info.platform !== platform || info.architecture !== architecture
      || typeof info.builtAt !== "string" || !Number.isFinite(Date.parse(info.builtAt)) || new Date(info.builtAt).toISOString() !== info.builtAt) {
    throw new Error("Server build-info version/commit/time/target mismatch");
  }
  const embedded = run("go", ["version", "-m", executable]);
  const settings = new Map();
  for (const line of embedded.split(/\r?\n/)) {
    if (!line.startsWith("\tbuild\t")) continue;
    const value = line.slice(7), separator = value.indexOf("=");
    if (separator < 0) continue;
    const key = value.slice(0, separator), raw = value.slice(separator + 1);
    if (settings.has(key)) throw new Error("Duplicate embedded Go build setting");
    settings.set(key, raw.startsWith('"') ? JSON.parse(raw) : raw);
  }
  const goOS = { linux: "linux", macos: "darwin" }[platform];
  const goArch = { x64: "amd64", arm64: "arm64" }[architecture];
  if (!goOS || !goArch || !embedded.includes(`\tpath\t${mainPackage}\n`) || settings.get("GOOS") !== goOS
      || settings.get("GOARCH") !== goArch || settings.get("CGO_ENABLED") !== "0") {
    throw new Error("Actual Go binary package/platform/architecture mismatch");
  }
  const flags = settings.get("-ldflags") || "";
  for (const [field, value] of [["Version", info.version], ["Commit", info.commit], ["BuiltAt", info.builtAt]]) {
    const matches = [...flags.matchAll(/(?:^|\s)-X\s+([^\s=]+)=([^\s]+)/g)].filter(match => match[1] === `${buildPackage}.${field}`);
    if (matches.length !== 1 || matches[0][2] !== value) throw new Error(`Actual Go binary embedded ${field} mismatch`);
  }
  await verifyAdminEntry(directory, info.version);
  await verifyAgentDistribution(join(directory, "agent-dist"), {
    version, commit, manifestSHA256: embeddedValue(settings, `${buildPackage}.AgentManifestSHA256`)
  });
  if (process.platform === goOS && process.arch === (architecture === "x64" ? "x64" : "arm64")) {
    const actual = JSON.parse(run(executable, ["--version"], { env: { PATH: process.env.PATH, CHORDV_MODE: "version-check-must-not-load-config" } }));
    if (["version", "commit", "builtAt"].some(key => actual[key] !== info[key])) throw new Error("Actual server --version differs from build-info");
  }
  return { version: info.version, commit: info.commit, builtAt: info.builtAt, platform, architecture };
}

export async function verifyServerArchive(archive, expected) {
  const names = run("tar", ["-tzf", archive]).trim().split(/\r?\n/);
  if (new Set(names).size !== names.length || ["chordv-server", "DEPLOYMENT.txt", "build-info.json", "admin/index.html", "SERVER-CONFIG.md", ...agentFileNames.map(name => `agent-dist/${name}`)].some(name => !names.includes(name))
      || names.some(name => !["chordv-server", "DEPLOYMENT.txt", "build-info.json"].includes(name)
        && name !== "SERVER-CONFIG.md" && name !== "agent-dist/" && !agentFileNames.map(file => `agent-dist/${file}`).includes(name)
        && !(name.replace(/\/$/, "").split("/").every(part => part && part !== "." && part !== "..") && (name === "admin/" || name.startsWith("admin/"))))) {
    throw new Error("Unexpected server archive entries; production package must contain only verified files");
  }
  const listing = run("tar", ["-tvzf", archive]);
  if (listing.split(/\r?\n/).some(line => line && !/^[d-]/.test(line))) throw new Error("Server archives cannot contain links or special files");
  const directory = await mkdtemp(join(tmpdir(), "chordv-server-verify-"));
  try {
    run("tar", ["-xzf", archive, "-C", directory]);
    return await verifyServerBuild(directory, expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
