import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
export const agentPackage = "github.com/Achordchan/ChordV/apps/agent";
export const agentFileNames = ["manifest.json", "chordv-agent-linux-amd64", "chordv-agent-linux-arm64"];
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function goBinaryMetadata(executable) {
  const result = spawnSync("go", ["version", "-m", executable], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error("Actual Go binary metadata cannot be read");
  const settings = new Map(); let packagePath;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("\tpath\t")) packagePath = line.slice(6);
    if (!line.startsWith("\tbuild\t")) continue;
    const value = line.slice(7), separator = value.indexOf("=");
    if (separator < 0) continue;
    const key = value.slice(0, separator), raw = value.slice(separator + 1);
    if (settings.has(key)) throw new Error("Duplicate embedded Go build setting");
    settings.set(key, raw.startsWith('"') ? JSON.parse(raw) : raw);
  }
  return { packagePath, settings };
}

export function embeddedValue(settings, name) {
  const matches = [...(settings.get("-ldflags") || "").matchAll(/(?:^|\s)-X\s+([^\s=]+)=([^\s]+)/g)].filter(match => match[1] === name);
  if (matches.length !== 1) throw new Error(`Actual Go binary embedded ${name} is missing or duplicated`);
  return matches[0][2];
}

export async function verifyAgentDistribution(directory, { version, commit, manifestSHA256 }) {
  if (!/^[a-f0-9]{40,64}$/.test(commit ?? "") || !/^[a-f0-9]{64}$/.test(manifestSHA256 ?? "")) throw new Error("Missing Agent build trust anchor");
  const manifestPath = join(directory, "manifest.json");
  if (!(await lstat(directory)).isDirectory() || !(await lstat(manifestPath)).isFile()) throw new Error("Agent release must contain regular files, not links");
  const raw = await readFile(manifestPath);
  if (raw.length > 64 * 1024 || sha256(raw) !== manifestSHA256) throw new Error("Agent manifest differs from server embedded trust anchor");
  const manifest = JSON.parse(raw);
  if (manifest.version !== version || manifest.commit !== commit || Object.keys(manifest.sha256 ?? {}).sort().join(",") !== "amd64,arm64") throw new Error("Agent release version/commit/architectures mismatch");
  for (const arch of ["amd64", "arm64"]) {
    const file = join(directory, `chordv-agent-linux-${arch}`);
    if (!(await lstat(file)).isFile()) throw new Error("Agent release must contain regular files, not links");
    if (!/^[a-f0-9]{64}$/.test(manifest.sha256[arch]) || sha256(await readFile(file)) !== manifest.sha256[arch]) throw new Error("Agent binary SHA256 mismatch");
    const { packagePath, settings } = goBinaryMetadata(file);
    if (packagePath !== `${agentPackage}/cmd/chordv-agent` || settings.get("GOOS") !== "linux" || settings.get("GOARCH") !== arch || settings.get("CGO_ENABLED") !== "0"
        || embeddedValue(settings, `${agentPackage}/internal/version.Version`) !== version || embeddedValue(settings, `${agentPackage}/internal/version.Commit`) !== commit) throw new Error("Actual Agent binary version/commit/platform/architecture mismatch");
  }
  return manifest;
}

async function runBuild(command, args, cwd, extraEnv) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Go Agent build failed (${code})`)));
  });
}

export async function buildAgentDistribution(directory, { version, commit, runBuild: build = runBuild }) {
  if (!/^[a-f0-9]{40,64}$/.test(commit ?? "")) throw new Error("Invalid Agent source commit");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const hashes = {};
  for (const arch of ["amd64", "arm64"]) {
    const file = join(directory, `chordv-agent-linux-${arch}`);
    const flags = `-s -w -X ${agentPackage}/internal/version.Version=${version} -X ${agentPackage}/internal/version.Commit=${commit}`;
    // Keep ldflags metadata for offline validation; trimpath currently omits it.
    await build("go", ["build", `-ldflags=${flags}`, "-o", file, "./cmd/chordv-agent"], join(project, "apps/agent"), { GOOS: "linux", GOARCH: arch, CGO_ENABLED: "0" });
    hashes[arch] = sha256(await readFile(file));
  }
  const manifest = Buffer.from(`${JSON.stringify({ version, commit, sha256: hashes }, null, 2)}\n`);
  await writeFile(join(directory, "manifest.json"), manifest);
  const manifestSHA256 = sha256(manifest);
  await verifyAgentDistribution(directory, { version, commit, manifestSHA256 });
  return manifestSHA256;
}
