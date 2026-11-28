import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertReleaseNotReplayed, normalizeReleaseRepository, parseReleaseManifest, releaseAssetUrl, type GitHubReleaseManifest } from "../src/lib/githubReleaseManifest";
import { isGitHubReleaseRepository } from "@chordv/shared";
import { GitHubReleaseSource, ReleaseChannelNotPublishedError, githubTransportUrls, type ReleaseTransport } from "../src/lib/githubReleaseSource";
import { compareVersion, parseSemver } from "../src/lib/releaseVersion";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/github-release.json", import.meta.url), "utf8")) as GitHubReleaseManifest;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ type: "spki", format: "pem" }).toString();
const config = { repository: "fixture/chordv-releases", publicKey: key };
function schema2Manifest() {
  return { ...fixture, schemaVersion: 2, sourceCommit: "a".repeat(40), tagBinding: { mode: "signed-manifest-tree", repository: config.repository } };
}
function signature(body: string) { return sign(null, Buffer.from(body), privateKey).toString("base64"); }
function transport(body = JSON.stringify(fixture)): ReleaseTransport {
  return {
    read: async url => ({ status: 200, body: url.endsWith(".sig") ? signature(body) : body }),
    verify: async input => verify(null, Buffer.from(input.manifest), publicKey, Buffer.from(input.signature, "base64"))
  };
}

test("后台和客户端对 GitHub 发布仓库接受同一组仓库名", () => {
  for (const value of ["Team-1/.releases", "Team-1/Client-v2", "owner/repo_123"]) {
    assert.equal(isGitHubReleaseRepository(value), true, value);
    assert.equal(normalizeReleaseRepository(value), value);
  }
  for (const value of ["owner/..", "owner/.", "bad_owner/releases", "https://github.com/owner/repo", "owner/repo?x=1", ""]) {
    assert.equal(isGitHubReleaseRepository(value), false, value);
    assert.throws(() => normalizeReleaseRepository(value), /owner\/repository/);
  }
});

test("schema2：显式模式与已签仓库保留，schema1不能伪装新模式", () => {
  const parsed = parseReleaseManifest(JSON.stringify(schema2Manifest()));
  assert.equal(parsed.schemaVersion, 2);
  assert.deepEqual((parsed as unknown as { tagBinding: unknown }).tagBinding, schema2Manifest().tagBinding);
  for (const value of [
    { ...schema2Manifest(), schemaVersion: 1 }, { ...schema2Manifest(), tagBinding: undefined },
    { ...schema2Manifest(), tagBinding: { mode: "source-commit" } },
    { ...schema2Manifest(), tagBinding: { mode: "unknown", repository: config.repository } },
    { ...schema2Manifest(), sourceCommit: undefined }
  ]) assert.throws(() => parseReleaseManifest(JSON.stringify(value)), /模式|绑定|来源|版本|格式/);
});

test("schema2：原始签名与固定Release签名一致且原生授权成功后才缓存", async () => {
  const body = JSON.stringify(schema2Manifest()), rawSignature = signature(body) + "\n";
  let authorized = 0;
  const source = new GitHubReleaseSource(config, {
    ...transport(body), read: async url => ({ status: 200, body: url.endsWith(".sig") ? rawSignature : body }),
    authorize: async input => { assert.equal(input.signature, rawSignature); authorized++; }
  });
  assert.equal((await source.load("stable")).schemaVersion, 2); assert.equal(authorized, 1);
  await source.load("stable"); assert.equal(authorized, 1);
});

test("schema2：跨仓库、无固定钥、无原生绑定或Release签名原文不同均拒绝", async () => {
  const body = JSON.stringify(schema2Manifest()), rawSignature = signature(body) + "\n";
  const base = { ...transport(body), read: async (url: string) => ({ status: 200, body: url.endsWith(".sig") ? rawSignature : body }), authorize: async () => undefined };
  await assert.rejects(new GitHubReleaseSource({ ...config, repository: "other/repo" }, base).load("stable"), /仓库/);
  await assert.rejects(new GitHubReleaseSource({ ...config, publicKey: "" }, base).load("stable"), /公钥|验签/);
  await assert.rejects(new GitHubReleaseSource(config, { ...base, authorize: undefined }).load("stable"), /原生|绑定/);
  await assert.rejects(new GitHubReleaseSource(config, { ...base, read: async url => ({ status: 200, body: url.endsWith(".sig") ? url.includes("/releases/download/") ? rawSignature.trim() : rawSignature : body }) }).load("stable"), /签名.*原文|签名.*一致/);
});

test("严格SemVer及测试渠道排序", () => {
  for (const version of ["01.0.0", "1.0.0-beta.01", "1.0.0-beta..1", "1.0.0-", "1.0.0/../../etc", "1.0"]) assert.equal(parseSemver(version), null, version);
  assert.ok(parseSemver("v1.2.3-beta.10+build.42"));
  assert.ok(compareVersion("1.0.0-beta.10", "1.0.0-beta.2") > 0);
  assert.ok(compareVersion("1.0.0", "1.0.0-beta.99") > 0);
  assert.equal(compareVersion("1.2.3+one", "1.2.3+two"), 0);
});

test("完整清单解析且平台/架构/组件保持真实", () => {
  const manifest = parseReleaseManifest(JSON.stringify(fixture), "stable");
  assert.equal(manifest.installers.length, 2);
  assert.equal(manifest.runtimeComponents.length, 3);
  assert.equal(manifest.runtimeComponents[0].sourceFormat, "zip_entry");
  assert.equal(manifest.minimumVersion, "1.1.0");
  assert.equal(manifest.build, 42);
});

test("拒绝版本标签渠道错误、重复资产、缺失完整性及路径穿越", () => {
  const invalid = [
    { ...fixture, tag: "v9.9.9" }, { ...fixture, channel: "beta" },
    { ...fixture, minimumVersion: "99.0.0" }, { ...fixture, build: 0 },
    { ...fixture, installers: [] }, { ...fixture, installers: [...fixture.installers, fixture.installers[0]] },
    { ...fixture, installers: [{ ...fixture.installers[0], sha256: null }] },
    { ...fixture, installers: [{ ...fixture.installers[0], fileName: "../evil.exe" }] },
    { ...fixture, installers: [{ ...fixture.installers[0], fileName: "evil.exe" }] },
    { ...fixture, installers: [{ ...fixture.installers[0], sizeBytes: -1 }] },
    { ...fixture, runtimeComponents: [{ ...fixture.runtimeComponents[0], archiveEntryName: "../../etc/passwd" }] }
  ];
  for (const value of invalid) assert.throws(() => parseReleaseManifest(JSON.stringify(value)));
  assert.throws(() => parseReleaseManifest(JSON.stringify(fixture), "beta"));
});

test("下载地址只能由配置仓库和固定tag生成", () => {
  assert.equal(releaseAssetUrl(config.repository, "v2.0.0", "ChordV_2.0.0_macos_arm64.dmg"), "https://github.com/fixture/chordv-releases/releases/download/v2.0.0/ChordV_2.0.0_macos_arm64.dmg");
  for (const repo of ["https://evil.example/repo", "owner/../repo", "owner/repo?token=secret"]) assert.throws(() => releaseAssetUrl(repo, "v2.0.0", "ok.dmg"));
  for (const tag of ["latest", "main", "v2.0.0/evil"]) assert.throws(() => releaseAssetUrl(config.repository, tag, "ok.dmg"));
  assert.throws(() => releaseAssetUrl(config.repository, "v2.0.0", "https://evil.example/payload.dmg"));
});

test("无公钥禁止镜像；有公钥保留镜像与GitHub直连", () => {
  const origin = releaseAssetUrl(config.repository, fixture.tag, fixture.installers[0].fileName);
  assert.deepEqual(githubTransportUrls(origin, { ...config, publicKey: "" }), [origin]);
  assert.deepEqual(githubTransportUrls(origin, config), [`https://ghfast.top/${origin}`, origin]);
  assert.throws(() => githubTransportUrls("https://evil.example/payload", config));
});

test("真实Ed25519验签、固定Release资产比对和短时合并缓存", async () => {
  const reads: string[] = [], highest = new Map();
  const original = transport();
  const source = new GitHubReleaseSource(config, {
    ...original, read: async url => { reads.push(url); return original.read(url); },
    readHighest: key => highest.get(key) ?? null, writeHighest: (key, value) => highest.set(key, value)
  });
  const [one, two] = await Promise.all([source.load("stable"), source.load("stable")]);
  assert.equal(one.version, "2.0.0"); assert.equal(one, two); assert.equal(reads.length, 3);
  await source.load("stable"); assert.equal(reads.length, 3);
  assert.ok(reads[2].includes(`/releases/download/${fixture.tag}/chordv-release.json`));
  assert.equal(highest.size, 1);
});

test("清单签名被修改时失败关闭，不降级跳过验签", async () => {
  let count = 0;
  const body = JSON.stringify(fixture);
  const source = new GitHubReleaseSource(config, {
    ...transport(body), read: async url => { count++; return { status: 200, body: url.endsWith(".sig") ? signature(`${body} `) : body }; }
  });
  await assert.rejects(source.load("stable"), /签名校验失败/);
  assert.equal(count, 8);
});

test("发布指针和签名更新竞争有界重读且不混用镜像", async () => {
  const body = JSON.stringify(fixture), stale = JSON.stringify({ ...fixture, build: 41 });
  const urls: string[] = []; let manifests = 0;
  const source = new GitHubReleaseSource(config, {
    ...transport(body), read: async url => {
      urls.push(url);
      if (url.endsWith("stable.json")) { manifests++; return { status: 200, body: manifests === 1 ? stale : body }; }
      return { status: 200, body: url.endsWith(".sig") ? signature(body) : body };
    }
  });
  assert.equal((await source.load("stable")).build, 42);
  assert.equal(manifests, 2);
  assert.ok(urls.every(url => url.startsWith("https://ghfast.top/")));
});

test("镜像失败自动切回GitHub，缺失beta与验签失败区别处理", async () => {
  const direct = transport(), urls: string[] = [];
  const source = new GitHubReleaseSource(config, {
    ...direct, read: async url => { urls.push(url); if (url.startsWith("https://ghfast.top/")) throw new Error("mirror offline"); return direct.read(url); }
  });
  assert.equal((await source.load("stable")).version, fixture.version);
  assert.ok(urls.some(url => url.startsWith("https://raw.githubusercontent.com/")));
  const missing = new GitHubReleaseSource({ ...config, publicKey: "" }, { ...direct, read: async () => ({ status: 404, body: "" }) });
  await assert.rejects(missing.load("beta"), ReleaseChannelNotPublishedError);
  for (const status of [429, 503]) {
    const unavailable = new GitHubReleaseSource(config, { ...direct, read: async url => ({ status: url.startsWith("https://ghfast.top/") ? 404 : status, body: "" }) });
    await assert.rejects(unavailable.load("beta"), (error: Error) => !(error instanceof ReleaseChannelNotPublishedError) && error.message.includes(String(status)));
  }
});

test("拒绝已签名但比已确认版本更旧的清单和较低构建号", async () => {
  assert.throws(() => assertReleaseNotReplayed(fixture, { version: "2.0.1", build: 1 }), /较旧/);
  assert.throws(() => assertReleaseNotReplayed(fixture, { version: "2.0.0", build: 43 }), /较旧/);
  const source = new GitHubReleaseSource(config, { ...transport(), readHighest: () => ({ version: "2.0.1", build: 1 }) });
  await assert.rejects(source.load("stable"), /较旧/);
});

test("渠道清单必须与固定tag的真实清单字节一致", async () => {
  const original = transport();
  const source = new GitHubReleaseSource(config, {
    ...original, read: url => url.includes("/releases/download/") ? Promise.resolve({ status: 200, body: "{}" }) : original.read(url)
  });
  await assert.rejects(source.load("stable"), /正式发布资产不一致/);
});

test("原生授权失败时不缓存清单或抬高本地版本记录", async () => {
  let authorized = 0, written = 0;
  const source = new GitHubReleaseSource(config, {
    ...transport(), authorize: async () => { authorized++; throw new Error("native authorization rejected"); },
    writeHighest: () => { written++; }
  });
  await assert.rejects(source.load("stable"), /native authorization rejected/);
  await assert.rejects(source.load("stable"), /native authorization rejected/);
  assert.equal(authorized, 8); assert.equal(written, 0);
});

test("手动检查绕过缓存且官方beta缺失不被镜像网络故障混淆", async () => {
  let reads = 0;
  const original = transport();
  const source = new GitHubReleaseSource(config, { ...original, read: async url => { reads++; return original.read(url); } });
  await source.load("stable"); await source.load("stable", true); assert.equal(reads, 6);
  const missing = new GitHubReleaseSource(config, {
    ...original, read: async url => {
      if (url.startsWith("https://ghfast.top/")) throw new Error("mirror offline");
      return { status: 404, body: "" };
    }
  });
  await assert.rejects(missing.load("beta"), ReleaseChannelNotPublishedError);
});
