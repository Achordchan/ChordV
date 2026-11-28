import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceCommit, verifyServerArchive } from "../.github/scripts/server-build-info.mjs";
import { makeManifest, stageServer, verifyAsset } from "../.github/scripts/release-artifacts.mjs";
import { verifyManifestSignature } from "../.github/scripts/publish-github-release.mjs";
import { embeddedValue, goBinaryMetadata, sha256 } from "./agent-release-assets.mjs";
import { loadLocalEnvironment, PROJECT_ROOT } from "./mygo-local-config.mjs";

// Consume already-built real backend outputs; never publish, deploy or install.
const args = process.argv.slice(2);
const staged = args.length === 1 && args[0] === "--staged";
if (args.length && !staged) throw new Error("Usage: node scripts/mygo-agent-distribution-e2e.mjs [--staged]");
const local = await loadLocalEnvironment();
const version = (await readFile(join(PROJECT_ROOT, "SYSTEM_VERSION"), "utf8")).trim();
const commit = sourceCommit();
const directory = await mkdtemp(join(tmpdir(), "chordv-agent-release-e2e-"));
const checks = [];
const schemas = new Set();
const passedTests = new Set();
const run = (command, args, env = {}, requiredTests = []) => {
  const result = spawnSync(command, args, { cwd: join(PROJECT_ROOT, "apps/server"), env: { ...process.env, ...local, ...env }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
  // A failing HTTP assertion may include an installer body. Never persist or
  // echo raw child output: retain only runner statuses and schema identities.
  for (const match of (result.stdout ?? "").matchAll(/独立API测试schema: (api_test_[a-f0-9]{32})/g)) schemas.add(match[1]);
  const passed = new Set();
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const match = /^--- PASS: (Test\w+) \([\d.]+s\)$/.exec(line);
    if (match) passed.add(match[1]);
    if (/^(?:=== RUN\s+Test\w+|--- (?:PASS|FAIL): Test\w+ \([\d.]+s\)|PASS|FAIL|ok\s+github\.com\/Achordchan\/ChordV\/apps\/server\/internal\/api\s+[\d.]+s)$/.test(line)) process.stdout.write(`${line}\n`);
  }
  if (result.error || result.status !== 0) throw new Error(`Local Agent release verification failed (${command}, ${result.error?.message || result.status})`);
  for (const test of requiredTests) {
    if (!passed.has(test)) throw new Error(`Required release test did not pass: ${test}`);
  }
  for (const test of passed) passedTests.add(test);
};
try {
  const output = join(directory, "assets");
  await mkdir(output);
  if (staged && (await readdir(join(PROJECT_ROOT, "release-assets"))).length !== 4) throw new Error("Expected exactly two server archives and their two descriptors");
  for (const architecture of ["x64", "arm64"]) {
    if (staged) {
      for (const name of [`server-linux-${architecture}.json`, `chordv-server_${version}_linux_${architecture}.tar.gz`]) {
        const input = join(PROJECT_ROOT, "release-assets", name);
        if (!(await lstat(input)).isFile()) throw new Error(`Expected regular staged file: ${name}`);
        await copyFile(input, join(output, name));
      }
    } else await stageServer({ platform: "linux", architecture, version, commit, input: join(PROJECT_ROOT, "output/backend"), output });
  }
  checks.push("实际Go服务端及双架构Linux Agent构建产物归档，通过内嵌版本/Commit/架构验证");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const repository = process.env.VITE_GITHUB_RELEASE_REPOSITORY || "local-qa/offline-release";
  const signed = await makeManifest({ kind: "server", version, commit, build: 1, directory: output,
    tagBindingMode: "signed-manifest-tree", repository, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const body = await readFile(join(output, signed.fileName)), signature = await readFile(join(output, `${signed.fileName}.sig`), "utf8");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  verifyManifestSignature(body, signature, publicPem);
  assert.throws(() => verifyManifestSignature(Buffer.concat([body, Buffer.from(" ")]), signature, publicPem));
  const manifest = JSON.parse(body);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.tagBinding, { mode: "signed-manifest-tree", repository: repository.toLowerCase() });
  const httpVerifiedArchives = [];
  for (const asset of manifest.servers) {
    await verifyAsset(output, asset);
    const archive = join(output, asset.fileName);
    await verifyServerArchive(archive, { version, commit, platform: asset.platform, architecture: asset.architecture });
    run("go", ["test", "./internal/api", "-run", "^TestAgentRealReleaseArchiveOnboardingHTTP$", "-count=1", "-v"],
      { CHORDV_TEST_SERVER_RELEASE_ARCHIVE: archive }, ["TestAgentRealReleaseArchiveOnboardingHTTP"]);
    httpVerifiedArchives.push({ architecture: asset.architecture, fileName: asset.fileName, sha256: asset.sha256 });
  }
  checks.push("本地临时Ed25519签名验签、签名原文篡改拒绝、两份实际归档SHA/长度离线校验；未使用生产私钥");
  const archive = join(output, manifest.servers.find(asset => asset.architecture === "x64").fileName);
  run("go", ["test", "./internal/api", "-run", "TestAgentArtifactsAreHashCheckedAndInstallerIsSyntaxChecked|TestSiteAddress", "-count=1", "-v"], {}, ["TestAgentArtifactsAreHashCheckedAndInstallerIsSyntaxChecked", "TestSiteAddressCanonicalRestartAccessAndDownstreamHTTP"]);
  checks.push("随机私有schema和全新空DataDir，真实HTTP创建Agent节点、安装脚本、双架构下载、版本/架构/篡改拒绝、令牌不消费及主地址重启契约");
  const extracted = join(directory, "extracted"); await mkdir(extracted);
  run("tar", ["-xzf", archive, "-C", extracted]);
  const anchor = embeddedValue(goBinaryMetadata(join(extracted, "chordv-server")).settings, "github.com/Achordchan/ChordV/apps/server/internal/buildinfo.AgentManifestSHA256");
  const pkg = "github.com/Achordchan/ChordV/apps/server/internal/buildinfo";
  const executable = join(extracted, "agent-path-http.test");
  run("go", ["test", "-c", "-o", executable, `-ldflags=-X ${pkg}.Version=${version} -X ${pkg}.Commit=${commit} -X ${pkg}.AgentManifestSHA256=${anchor}`, "./internal/api"]);
  run(executable, ["-test.run=^TestAgentExecutableAssetsHTTP$", "-test.v"], { CHORDV_TEST_EXECUTABLE_AGENT_PATH: "1" }, ["TestAgentExecutableAssetsHTTP"]);
  checks.push("原生产os.Executable解析分支：无私有路径注入、任意工作目录、当前exe内嵌信任锚、真实HTTP下载两架构，DataDir保持空");
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: PROJECT_ROOT, encoding: "utf8" });
  if (dirty.error || dirty.status !== 0) throw new Error("无法记录工作区状态");
  const report = {
    version, commit, workingTreeDirty: Boolean(dirty.stdout.trim()), sourceCommitMeaning: "本地构建注入的HEAD元数据，不表示远端提交已包含工作区变更",
    localSignatureOnly: true, publicKey: publicPem, manifestSignatureBase64: signature.trim(), manifestBodySHA256: sha256(body),
    agentManifestSHA256: anchor, agentManifest: JSON.parse(await readFile(join(extracted, "agent-dist/manifest.json"), "utf8")),
    manifest, httpVerifiedArchives, schemas: [...schemas], passedTests: [...passedTests], checks, notExecuted: ["Linux root/systemd实际安装", "GitHub发布或上传", "任何线上访问/部署", "完整pnpm验收"]
  };
  const destination = join(PROJECT_ROOT, ".tmp/ui-qa/agent-release-supply-e2e.json");
  await mkdir(join(PROJECT_ROOT, ".tmp/ui-qa"), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`本地真实Agent发布供给链验收通过：${destination}\n`);
} finally { await rm(directory, { recursive: true, force: true }); }
