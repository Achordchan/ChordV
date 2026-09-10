import { ServiceUnavailableException } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type GoRelease = { version: string; commit: string; sha256: Record<"amd64" | "arm64", string> };

// Resolve against this running API's compiled location, never the supervisor's
// mutable current link or an old container volume. Each backend carries its own
// immutable binaries and installer, including after a self-update or rollback.
export function agentReleaseRoot(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 9; depth++) {
    if (existsSync(path.join(dir, "SYSTEM_VERSION"))) return dir;
    dir = path.dirname(dir);
  }
  throw new ServiceUnavailableException("无法定位当前后台发布目录");
}

export function loadGoRelease(): GoRelease {
  try {
    const root = agentReleaseRoot();
    const metadata = JSON.parse(readFileSync(path.join(root, "agent-go-dist/manifest.json"), "utf8"));
    const version = readFileSync(path.join(root, "SYSTEM_VERSION"), "utf8").trim();
    if (metadata.version !== version || !/^[0-9A-Za-z.+-]{1,61}$/.test(version)
      || !/^(?:[0-9a-f]{40}|source-sha256:[0-9a-f]{64})$/.test(metadata.commit)
      || !["amd64", "arm64"].every(arch => /^[0-9a-f]{64}$/.test(metadata.sha256?.[arch]))) throw new Error();
    return metadata;
  } catch {
    throw new ServiceUnavailableException("当前后台缺少完整 Go agent 发布产物，请安装包含双架构 agent 的后台版本");
  }
}
