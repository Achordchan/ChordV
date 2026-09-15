import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { releaseArtifactStorageRoot } from "./release-center.utils";

export function managedPath(value: string) {
  const root = releaseArtifactStorageRoot();
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new BadRequestException("文件不在托管目录内");
  return absolute;
}
/** Resolve internal aliases into the managed root's logical namespace. */
export async function canonicalManagedReference(value: string) {
  const absolute = managedPath(value);
  let real: string;
  try { real = await fs.realpath(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute; throw error; }
  const root = releaseArtifactStorageRoot();
  const realRoot = await fs.realpath(root);
  const relative = path.relative(realRoot, real);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new BadRequestException("引用的真实路径不在托管目录内");
  return path.join(root, relative);
}
export function cleanupPath(value: string) {
  const absolute = path.resolve(value);
  if (path.dirname(absolute) === path.resolve(tmpdir()) && /^chordv-(?:import|upload)-[a-f0-9-]{36}(?:\.[a-z0-9]+)?$/i.test(path.basename(absolute))) return absolute;
  return managedPath(absolute);
}
export async function assertSafeFile(absolute: string) {
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new BadRequestException("仅允许管理普通文件");
  const root = path.dirname(absolute) === path.resolve(tmpdir()) ? path.resolve(tmpdir()) : releaseArtifactStorageRoot();
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new BadRequestException("文件路径越界");
  return stat;
}
export async function hashStoredFile(absolute: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) hash.update(chunk);
  return hash.digest("hex");
}
export async function unlinkManagedFile(absolute: string) {
  try { await assertSafeFile(cleanupPath(absolute)); await fs.unlink(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const root = releaseArtifactStorageRoot();
  for (let parent = path.dirname(absolute); parent !== root && parent.startsWith(root + path.sep); parent = path.dirname(parent)) {
    if ([".incoming", "runtime-components", path.join("runtime-components","versions")].includes(path.relative(root,parent))) break;
    try { await fs.rmdir(parent); } catch { break; }
  }
}
export function isManagedOrphan(relative: string) {
  return /^(?:release_[\w-]+\/artifact_[\w-]+\/file_[\w-]+_|runtime-components\/[^/]+\/file_[\w-]+_|runtime-components\/versions\/[a-f0-9-]{36}(?:\.part)?$|\.incoming\/[a-f0-9-]{36}$)/.test(relative.split(path.sep).join("/"));
}
