import assert from "node:assert/strict";
import { DEFAULT_GITHUB_MIRROR_PREFIXES, githubMirrorDownloadUrls, pinnedGithubReleaseAssetUrl } from "../src/modules/common/github-mirror";
import { ReleaseCenterService } from "../src/modules/common/release-center.service";

async function main() {
  const dmg = "https://github.com/Achordchan/ChordV/releases/download/v1.1.11/ChordV_1.1.11_build23.dmg";
  const defaults = githubMirrorDownloadUrls(dmg, null);
  assert.equal(defaults.length, DEFAULT_GITHUB_MIRROR_PREFIXES.split("\n").length + 1);
  assert.equal(defaults.at(-1), dmg, "GitHub 直连排在镜像之后");
  assert.deepEqual(githubMirrorDownloadUrls(dmg, "https://m.example/{url}\nftp://bad/"), [`https://m.example/${dmg}`, dmg]);
  assert.equal(pinnedGithubReleaseAssetUrl(`${dmg}?x=1`), null);
  assert.deepEqual(
    githubMirrorDownloadUrls(dmg, "https://mirror.example/proxy?mode=download;url={url}\r\nhttps://a.example/,https://b.example/"),
    [`https://mirror.example/proxy?mode=download;url=${dmg}`, `https://a.example/${dmg}`, `https://b.example/${dmg}`, dmg],
    "分号属于模板地址本身，不能当分隔符"
  );

  const service = Object.assign(Object.create(ReleaseCenterService.prototype), {
    downloadMirrorService: { getEffectiveConfig: async () => ({ defaultMirrorPrefix: "https://m.example/", allowClientMirror: false, useMirrorForSystemUpdate: true, updatedAt: null }) }
  }) as any;
  assert.deepEqual(await service.installerMirrorDownloadUrls({ source: "uploaded", sourceUrl: dmg, fileHash: "a".repeat(64) }), { mirrorDownloadUrls: [`https://m.example/${dmg}`, dmg] });
  assert.deepEqual(await service.installerMirrorDownloadUrls({ source: "uploaded", sourceUrl: dmg, fileHash: null }), {}, "没有哈希的安装包不能走镜像");
  assert.deepEqual(await service.installerMirrorDownloadUrls({ source: "uploaded", sourceUrl: null, fileHash: "a".repeat(64) }), {}, "手动上传的安装包没有 GitHub 来源");
  assert.deepEqual(await service.installerMirrorDownloadUrls({ source: "external", sourceUrl: dmg, fileHash: "a".repeat(64) }), {});
  console.log("github mirror regression passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
