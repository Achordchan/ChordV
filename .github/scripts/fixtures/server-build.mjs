import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentDistribution } from "../../../scripts/agent-release-assets.mjs";

export const testCommit = "a".repeat(40);
export const testBuiltAt = "2026-11-16T12:00:00.000Z";
const compiled = new Map();
const agents = new Map();

async function binary(info, runtimeVersion, agentManifestSHA256) {
  const key = JSON.stringify({ ...info, runtimeVersion, agentManifestSHA256 });
  if (compiled.has(key)) return compiled.get(key);
  const source = await mkdtemp(join(tmpdir(), "chordv-go-build-fixture-"));
  try {
    await mkdir(join(source, "cmd/chordv-server"), { recursive: true });
    await mkdir(join(source, "internal/buildinfo"), { recursive: true });
    await writeFile(join(source, "go.mod"), "module github.com/Achordchan/ChordV/apps/server\n\ngo 1.20\n");
    await writeFile(join(source, "internal/buildinfo/version.go"), 'package buildinfo\nvar Version="dev"\nvar Commit=""\nvar BuiltAt=""\nvar AgentManifestSHA256=""\n');
    await writeFile(join(source, "cmd/chordv-server/main.go"), `package main
import("encoding/json"; "os"; "github.com/Achordchan/ChordV/apps/server/internal/buildinfo")
func main(){if len(os.Args)!=2 || os.Args[1]!="--version" {panic("test-only version fixture")}; json.NewEncoder(os.Stdout).Encode(map[string]string{"version":${runtimeVersion === undefined ? "buildinfo.Version" : JSON.stringify(runtimeVersion)},"commit":buildinfo.Commit,"builtAt":buildinfo.BuiltAt})}
`);
    const pkg = "github.com/Achordchan/ChordV/apps/server/internal/buildinfo";
    const flags = `-s -w -X ${pkg}.Version=${info.version} -X ${pkg}.Commit=${info.commit} -X ${pkg}.BuiltAt=${info.builtAt} -X ${pkg}.AgentManifestSHA256=${agentManifestSHA256}`;
    const result = spawnSync("go", ["build", `-ldflags=${flags}`, "-o", "fixture-binary", "./cmd/chordv-server"], {
      cwd: source, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, GOWORK: "off", GOTOOLCHAIN: "local", CGO_ENABLED: "0", GOOS: info.platform === "macos" ? "darwin" : "linux", GOARCH: info.architecture === "x64" ? "amd64" : "arm64" }
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const bytes = await readFile(join(source, "fixture-binary"));
    compiled.set(key, bytes);
    return bytes;
  } finally { await rm(source, { recursive: true, force: true }); }
}

export async function writeServerBuild(directory, options = {}) {
  const { runtimeVersion, ...overrides } = options;
  const info = { version: "2.0.0", commit: testCommit, builtAt: testBuiltAt, platform: "linux", architecture: "x64", ...overrides };
  await mkdir(join(directory, "admin"), { recursive: true });
  const key = `${info.version}:${info.commit}`;
  if (!agents.has(key)) {
    const temporary = await mkdtemp(join(tmpdir(), "chordv-agent-build-fixture-"));
    try {
      const agentDirectory = join(temporary, "agent-dist");
      const hash = await buildAgentDistribution(agentDirectory, info);
      const files = await Promise.all(["manifest.json", "chordv-agent-linux-amd64", "chordv-agent-linux-arm64"].map(async name => [name, await readFile(join(agentDirectory, name))]));
      agents.set(key, { hash, files });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const agent = agents.get(key);
  await mkdir(join(directory, "agent-dist"), { recursive: true });
  for (const [name, bytes] of agent.files) await writeFile(join(directory, "agent-dist", name), bytes);
  await writeFile(join(directory, "chordv-server"), await binary(info, runtimeVersion, agent.hash), { mode: 0o755 });
  await mkdir(join(directory, "admin/assets"), { recursive: true });
  await writeFile(join(directory, "admin/index.html"), `<meta name="chordv-backend-version" content="${info.version}"><script type="module" src="/assets/fixture.js"></script><link rel="stylesheet" href="/assets/fixture.css">`);
  await writeFile(join(directory, "admin/assets/fixture.js"), "/* test fixture */");
  await writeFile(join(directory, "admin/assets/fixture.css"), "/* test fixture */");
  await writeFile(join(directory, "DEPLOYMENT.txt"), "test-only release fixture; production requires CHORDV_MODE=production and explicit configuration.\n");
  await writeFile(join(directory, "SERVER-CONFIG.md"), "测试专用配置说明\n");
  await writeFile(join(directory, "build-info.json"), JSON.stringify(info));
  return info;
}
