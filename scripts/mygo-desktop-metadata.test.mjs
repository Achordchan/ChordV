import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { withMacBuildInfo } from "./mygo-desktop-metadata.mjs";

test("macOS密封元数据保留其他打包设置，并与构建版本和架构使用同一输入", () => {
  const config = { version: "2.0.1-beta.2", macos: { signingIdentity: "test-only", infoPlist: { CustomKey: "keep", ChordVBuildInfo: { build: 999 } } } };
  const snapshot = structuredClone(config);
  const result = withMacBuildInfo(config, { build: 42, release: true, architecture: "arm64" });
  assert.deepEqual(config, snapshot);
  assert.equal(result.macos.signingIdentity, "test-only");
  assert.equal(result.macos.infoPlist.CustomKey, "keep");
  assert.deepEqual(result.macos.infoPlist.ChordVBuildInfo, { version: config.version, build: 42, mode: "release", platform: "macos", architecture: "arm64" });
  assert.deepEqual(withMacBuildInfo({ version: "2.0.1" }, { build: 0, release: false, architecture: "x64" }).macos.infoPlist.ChordVBuildInfo,
    { version: "2.0.1", build: 0, mode: "local", platform: "macos", architecture: "x64" });
});

test("无效或正式缺失构建号不能进入签名打包", () => {
  const config = { version: "2.0.1" };
  for (const changes of [{ build: -1 }, { build: Infinity }, { build: NaN }, { build: 1.5 }, { build: 0 }, { architecture: "amd64" }]) {
    assert.throws(() => withMacBuildInfo(config, { build: 1, release: true, architecture: "arm64", ...changes }), /构建元数据无效/);
  }
  assert.throws(() => withMacBuildInfo({ version: "bad" }, { build: 1, release: true, architecture: "arm64" }), /构建元数据无效/);
});

test("真实构建入口在签名配置和mygo打包前写入额外Info.plist键", () => {
  const source = readFileSync(new URL("./mygo-desktop.mjs", import.meta.url), "utf8");
  const metadata = source.indexOf("config = withMacBuildInfo(config,");
  assert.ok(metadata > source.indexOf("config.version = versions[options.platform]"));
  assert.ok(metadata < source.indexOf("config.macos = {"));
  assert.ok(metadata < source.indexOf('await run("go", buildArgs'));
  assert.match(source, /embeddedBuildNumber=\$\{buildNumber\}/);
});
