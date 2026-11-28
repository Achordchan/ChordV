import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertLinuxELF, assertLinuxIntegrationEvidence, linuxTestLockPath, prepareLinuxRuntimeFixtures, requiredLinuxIntegrationTests, runtimeLockPath, selectLinuxRuntimeAssets } from "./mygo-linux-runtime-fixtures.mjs";

const linux = JSON.parse(await readFile(linuxTestLockPath)), runtime = JSON.parse(await readFile(runtimeLockPath));
const cli = fileURLToPath(new URL("./mygo-linux-runtime-fixtures.mjs", import.meta.url));

test("Linux测试锁与生产Xray版本相同，GEO直接复用生产来源而不增加发布目标", () => {
  const before = JSON.stringify(runtime);
  for (const architecture of ["x64", "arm64"]) {
    const assets = selectLinuxRuntimeAssets(architecture, linux, runtime);
    assert.equal(assets.xray.architecture, architecture);
    assert.equal(assets.geoip, runtime.assets.find(asset => asset.component === "geoip"));
    assert.equal(assets.geosite, runtime.assets.find(asset => asset.component === "geosite"));
  }
  assert.equal(JSON.stringify(runtime), before);
  assert.equal(runtime.assets.some(asset => asset.targets.some(target => target.platform === "linux")), false);
});

test("测试锁架构重复/版本漂移/非固定上游/坏Hash或长度一律拒绝", () => {
  for (const change of [
    lock => { lock.purpose = "production"; }, lock => { lock.assets[1].architecture = "x64"; },
    lock => { lock.assets[0].version = "v0.0.1"; }, lock => { lock.assets[0].sourceUrl += "?ref=latest"; },
    lock => { lock.assets[0].archiveEntryName = "../xray"; }, lock => { lock.assets[0].sha256 = "invented"; },
    lock => { lock.assets[0].sizeBytes = -1; }, lock => { lock.assets[0].fileName = "../xray.zip"; }
  ]) {
    const altered = structuredClone(linux); change(altered);
    assert.throws(() => selectLinuxRuntimeAssets("x64", altered, runtime));
  }
  assert.throws(() => selectLinuxRuntimeAssets("riscv64", linux, runtime));
  const missing = structuredClone(runtime); missing.assets = missing.assets.filter(asset => asset.component !== "geoip");
  assert.throws(() => selectLinuxRuntimeAssets("x64", linux, missing));
});

test("ELF头部解析识别真实目标架构，不把头部夹具当可执行内核", () => {
  const bytes = Buffer.alloc(64); bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(183, 18); bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52);
  assert.doesNotThrow(() => assertLinuxELF(bytes, "arm64"));
  assert.throws(() => assertLinuxELF(bytes, "x64"));
  for (const offset of [0, 4, 5, 6, 16, 18, 20, 52]) {
    const altered = Buffer.from(bytes); altered[offset] = 0;
    assert.throws(() => assertLinuxELF(altered, "arm64"));
  }
});

test("准备目录已存在时零下载且不覆盖、不清理用户文件", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "chordv-linux-fixture-existing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = path.join(directory, "existing.txt"); await writeFile(sentinel, "must remain");
  await assert.rejects(prepareLinuxRuntimeFixtures({ architecture: "arm64", output: directory, fetchImpl: () => { throw Error("must not fetch"); } }), /EEXIST/);
  assert.equal(await readFile(sentinel, "utf8"), "must remain");
});

test("坏下载不能留下准备完成目录或部分资产", async t => {
  const parent = await mkdtemp(path.join(tmpdir(), "chordv-linux-fixture-corrupt-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const output = path.join(parent, "new-owned-output");
  await assert.rejects(prepareLinuxRuntimeFixtures({ architecture: "arm64", output, fetchImpl: async () => new Response("corrupted-test-only-download") }), /SHA256 or length mismatch/);
  await assert.rejects(access(output));
});

test("CI日志必须包含全部真实测试pass及包终态，skip/缺项/其他包/坏JSON均拒绝", () => {
  const pkg = "github.com/Achordchan/ChordV/apps/desktop/native";
  const records = [...requiredLinuxIntegrationTests.map(Test => ({ Package: pkg, Test, Action: "pass" })), { Package: pkg, Action: "pass" }];
  const encode = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  assert.equal(assertLinuxIntegrationEvidence(encode(records)).requiredTestsPassed, 10);
  assert.throws(() => assertLinuxIntegrationEvidence(encode(records.slice(1))), /Missing actual/);
  assert.throws(() => assertLinuxIntegrationEvidence(encode(records.slice(0, -1))), /did not finish/);
  for (const Action of ["skip", "fail"]) assert.throws(() => assertLinuxIntegrationEvidence(encode([...records, { Package: pkg, Test: "other", Action }])));
  assert.throws(() => assertLinuxIntegrationEvidence(encode(records.map(record => ({ ...record, Package: "unrelated" })))));
  assert.throws(() => assertLinuxIntegrationEvidence("not json"));
});

test("CLI参数错误在项目外也不下载或创建输出", () => {
  const result = spawnSync(process.execPath, [cli, "--arch", "riscv64", "--output", "must-not-create"], { cwd: tmpdir(), encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /architecture/);
});
