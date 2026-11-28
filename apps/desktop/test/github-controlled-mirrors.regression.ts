import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILTIN_GITHUB_MIRRORS, githubTransportUrls, type GitHubReleaseConfiguration } from "../src/lib/githubReleaseSource";
import { parseReleaseManifest } from "../src/lib/githubReleaseManifest";
import { projectGitHubRuntimePlan, projectGitHubUpdate } from "../src/lib/githubReleaseProjection";

const configuration = { repository: "fixture/releases", publicKey: "test-only-pinned-key" };
const origin = "https://github.com/fixture/releases/releases/download/v2.0.0/setup.exe";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("传输仅使用受控ghfast与GitHub原地址，额外旧配置不能覆盖", () => {
  assert.deepEqual(BUILTIN_GITHUB_MIRRORS, ["https://ghfast.top/"]);
  assert.equal(Object.isFrozen(BUILTIN_GITHUB_MIRRORS), true);
  const obsolete = { ...configuration, mirrors: ["https://arbitrary.example/"], clientMirrorPrefix: "https://arbitrary.example/" } as GitHubReleaseConfiguration;
  assert.deepEqual(githubTransportUrls(origin, obsolete), [`https://ghfast.top/${origin}`, origin]);
  assert.deepEqual(githubTransportUrls(origin, { ...configuration, publicKey: "" }), [origin]);
  for (const url of [
    "https://github.com/another/repository/releases/download/v2.0.0/setup.exe",
    "https://raw.githubusercontent.com/another/repository/release-channels/stable.json",
    "https://arbitrary.example/https://github.com/fixture/releases/releases/download/v2.0.0/setup.exe"
  ]) assert.throws(() => githubTransportUrls(url, configuration));
});

test("安装包和组件投影共用相同受控源，不再提供自定义镜像能力", () => {
  const manifest = parseReleaseManifest(read("./fixtures/github-release.json"));
  const update = projectGitHubUpdate(manifest, configuration, { platform: "macos", architecture: "arm64", currentVersion: "1.1.12", currentBuild: 1, channel: "stable" });
  assert.equal(update.artifact?.allowClientMirror, false);
  assert.equal(update.artifact?.downloadCandidates?.length, 2);
  const plan = projectGitHubRuntimePlan(manifest, configuration, { platform: "macos", architecture: "arm64" });
  assert.equal("allowClientMirrorOverride" in plan, false);
  assert.equal(plan.components.length, 3);
  for (const item of plan.components) {
    assert.deepEqual(item.candidates.map(candidate => candidate.source), ["mirror", "origin"]);
    assert.equal(item.candidates[0].url, `https://ghfast.top/${item.candidates[1].url}`);
    assert.equal("allowClientMirror" in item, false);
  }
});

test("旧镜像偏好只做启动清理，不再读取或提供重置按钮", () => {
  const app = read("../src/App.tsx");
  assert.match(app, /localStorage\.removeItem\("chordv_runtime_component_mirror_prefix"\)/);
  assert.doesNotMatch(app, /localStorage\.getItem\([^\n]*MIRROR|runtimeMirrorPrefix|clearLegacyDownloadMirror|onResetLegacyMirror/);
  for (const file of ["DownloadProgressPanel", "RuntimeAssetsBanner", "ClientUpdateProgressPanel"]) {
    const component = read(`../src/components/${file}.tsx`);
    assert.doesNotMatch(component, /onResetLegacyMirror|清除旧下载镜像/);
  }
  const release = read("../src/lib/githubReleases.ts");
  const assets = read("../src/hooks/useRuntimeAssets.ts");
  const update = read("../src/hooks/useUpdateFlow.ts");
  assert.doesNotMatch(release + assets + update, /VITE_GITHUB_RELEASE_MIRRORS|clientMirrorPrefix|runtimeMirrorPrefix|userMirror/);
  assert.match(update, /force: runOptions\.source === "manual"/);
  assert.match(update, /onProgress: progress => setUpdateDownload/);
  assert.match(assets, /downloadWithMirrorFallback/);
  assert.match(read("../src/components/DownloadProgressPanel.tsx"), /errorCode|action\.onClick|onCancel/);
});
