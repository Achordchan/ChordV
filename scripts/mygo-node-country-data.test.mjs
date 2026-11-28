import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertNodeCountryDataCurrent, buildNodeCountryData, lockedCountryVersion, nodeCountryDataPath } from "./mygo-node-country-data.mjs";

const current = buildNodeCountryData();

test("Go国家数据与当前共享源码、已安装及锁定ISO版本一致", () => {
  assertNodeCountryDataCurrent(current, JSON.parse(readFileSync(nodeCountryDataPath, "utf8")));
  assert.equal(current.codes.US, "美国");
  assert.equal(current.codes.USA, "美国");
  assert.equal(current.names["中国香港特别行政区"], "HK");
  assert.equal(current.names["hong kong"], "HK");
  assert.equal(current.upperExpansions["ß"], "SS");
});

test("共享源码变化和锁版本变化均能被检查发现", () => {
  const sourceDrift = structuredClone(current);
  sourceDrift.source.sha256 = "changed-source";
  assert.throws(() => assertNodeCountryDataCurrent(current, sourceDrift), /共享国家源码已变化/);
  const lockDrift = structuredClone(current);
  lockDrift.source.isoLockedVersion = "0.0.0";
  assert.throws(() => assertNodeCountryDataCurrent(current, lockDrift), /锁定的 ISO 版本已变化/);
});

test("标签、ISO输入摘要和数据篡改不能被来源字段掩盖", () => {
  for (const change of [data => { data.codes.US = "变更标签"; }, data => { data.source.isoDataSha256 = "changed-input"; }]) {
    const altered = structuredClone(current);
    change(altered);
    assert.throws(() => assertNodeCountryDataCurrent(current, altered), /国家数据与当前源码/);
  }
});

test("只从shared importer读取ISO锁版本，不接受缺失记录", () => {
  assert.equal(lockedCountryVersion("importers:\n  other:\n    version: 1\n  packages/shared:\n    dependencies:\n      i18n-iso-countries:\n        specifier: ^7.14.0\n        version: 7.14.0\n  next:\n    version: 2\n"), "7.14.0");
  assert.throws(() => lockedCountryVersion("importers:\n  other:\n    version: 1\n"), /缺少 packages\/shared/);
});

test("CLI在项目外执行只读检查，不改生成文件", () => {
  const before = readFileSync(nodeCountryDataPath, "utf8");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./mygo-node-country-data.mjs", import.meta.url)), "--check"], { cwd: os.tmpdir(), encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /国家数据检查通过/);
  assert.equal(readFileSync(nodeCountryDataPath, "utf8"), before);
});
