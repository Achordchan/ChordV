import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MANUAL_ASSET_LABEL = "手动预置真实资产fixture";
const definitions = () => {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("运行UI隔离夹具仅支持当前macOS架构");
  const sourceDirectory = process.env.CHORDV_TEST_XRAY_DIR;
  if (!sourceDirectory || !path.isAbsolute(sourceDirectory)) throw new Error("CHORDV_TEST_XRAY_DIR 必须指向已准备好的 macOS 组件目录，使用规范绝对路径");
  return [
    { kind:"xray", source:path.join(sourceDirectory, process.arch === "arm64" ? "xray-aarch64-apple-darwin" : "xray-x86_64-apple-darwin"), name:"xray", mode:0o500 },
    ...["geoip", "geosite"].map(kind => ({ kind, source:path.join(sourceDirectory, `${kind}.dat`), name:`${kind}.dat`, mode:0o400 }))
  ];
};

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertRuntimeDesktop(root, desktop) {
  const temporary = await realpath(os.tmpdir());
  if (await realpath(root) !== root || path.dirname(root) !== temporary || !path.basename(root).startsWith("chordv-support-e2e-") || desktop !== path.join(root, ".data/mygo/desktop") || await realpath(desktop) !== desktop) throw new Error("运行UI资产只能位于全新隔离root的canonical桌面目录");
  for (const dir of [path.join(root,".data"), path.join(root,".data/mygo"), desktop]) {
    if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) throw new Error("运行UI目录不能使用符号链接");
  }
}

export async function inspectRuntimeSources() {
  const result = [];
  for (const item of definitions()) {
    const stat = await lstat(item.source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 || await realpath(item.source) !== item.source) throw new Error("手动真实资产必须是原目录内的非链接普通文件");
    result.push({...item, size:stat.size, sha256:await digest(item.source)});
  }
  return result;
}

export async function stageRuntimeAssets(root, desktop) {
  await assertRuntimeDesktop(root, desktop);
  const bin = path.join(desktop, "bin");
  await mkdir(bin, {mode:0o700});
  const assets = [];
  for (const item of await inspectRuntimeSources()) {
    const target = path.join(bin, item.name), metadata = path.join(bin, `${item.kind}.json`);
    // Byte copies, never hard links or a write/chmod of the user's source.
    await writeFile(target, await readFile(item.source), {mode:item.mode, flag:"wx"});
    if (await digest(target) !== item.sha256 || (await lstat(target)).size !== item.size) throw new Error("真实资产复制期间发生变化");
    await writeFile(metadata, JSON.stringify({kind:item.kind, versionLabel:MANUAL_ASSET_LABEL, artifactSha256:item.sha256, installedSha256:item.sha256, installedSize:item.size},null,2)+"\n", {mode:0o400,flag:"wx"});
    assets.push({kind:item.kind, source:item.source, target, metadata, size:item.size, sha256:item.sha256, provenance:MANUAL_ASSET_LABEL, downloadEvidence:false});
  }
  return assets;
}

export async function verifyRuntimeAssets(root, desktop, assets) {
  await assertRuntimeDesktop(root, desktop);
  if (!Array.isArray(assets) || assets.length !== 3) throw new Error("必须具有三个真实手动组件记录");
  const bin = path.join(desktop,"bin");
  if (!(await lstat(bin)).isDirectory() || await realpath(bin) !== bin) throw new Error("组件目录不能是符号链接");
  const expectedFiles = definitions().flatMap(item => [item.name,`${item.kind}.json`]).sort();
  if (JSON.stringify((await readdir(bin)).sort()) !== JSON.stringify(expectedFiles)) throw new Error("组件目录含旧环境文件");
  for (const expected of definitions()) {
    const item = assets.find(value => value.kind === expected.kind);
    if (!item || item.source !== expected.source || item.target !== path.join(bin,expected.name) || item.metadata !== path.join(bin,`${expected.kind}.json`) || item.provenance !== MANUAL_ASSET_LABEL || item.downloadEvidence !== false || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 1024) throw new Error("手动组件记录不符合隔离路径与来源契约");
    for (const [file, mode] of [[item.target,expected.mode],[item.metadata,0o400]]) {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || (stat.mode&0o777) !== mode || await realpath(file) !== file) throw new Error("组件副本/记录必须由当前用户独占、只读且非链接");
    }
    const metadata = JSON.parse(await readFile(item.metadata,"utf8"));
    if (Object.keys(metadata).sort().join(",") !== ["kind","versionLabel","artifactSha256","installedSha256","installedSize"].sort().join(",") || metadata.kind !== item.kind || metadata.versionLabel !== MANUAL_ASSET_LABEL || metadata.artifactSha256 !== item.sha256 || metadata.installedSha256 !== item.sha256 || metadata.installedSize !== item.size || (await lstat(item.target)).size !== item.size || await digest(item.target) !== item.sha256) throw new Error("组件实际SHA/size与installedComponent记录不一致");
  }
}
