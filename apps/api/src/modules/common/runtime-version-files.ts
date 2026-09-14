import { publicSiteOrigin } from "./site-address.context";
import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentReleaseRoot } from "../agent/agent-go-release";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fetchPublicHttpUrl } from "./remote-url.utils";
import { resolveGithubLatestReleaseAsset } from "./github-latest-release";
import { RUNTIME_COMPONENT_MAX_UPLOAD_BYTES } from "./upload-limits";

export function runtimeVersionPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadRequestException("无效文件标识");
  const base = process.env.CHORDV_RELEASE_STORAGE_ROOT?.trim() || path.resolve(process.cwd(), "storage", "releases");
  return path.resolve(base, "runtime-components", "versions", id);
}
export function runtimeVersionUrl(id: string) {
  return `${publicSiteOrigin()}/api/downloads/runtime-versions/${id}`;
}
export async function prepareRuntimeVersion(sourceUrl: string, requestedVersion: string | null, id: string,
  progress: (bytes: bigint, status: "downloading" | "verifying") => Promise<void>,
  target: { kind: string; platform: string; architecture: string }) {
  const latest = await resolveGithubLatestReleaseAsset(sourceUrl);
  if (!latest && !requestedVersion) throw new BadRequestException("固定来源必须填写版本号");
  const url = latest?.originUrl ?? sourceUrl;
  const versionLabel = latest?.versionLabel ?? requestedVersion!;
  const finalPath = runtimeVersionPath(id), tempPath = `${finalPath}.part`;
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const { response } = await fetchPublicHttpUrl(url, { signal: AbortSignal.timeout(10 * 60_000), headers: { "accept-encoding": "identity" } }, { requireHttps: true, errorPrefix: "组件下载" });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new BadRequestException(`组件下载失败 HTTP ${response.status}`); }
  const declared = Number(response.headers.get("content-length"));
  if (declared > RUNTIME_COMPONENT_MAX_UPLOAD_BYTES) { await response.body.cancel(); throw new BadRequestException("组件文件超过服务器大小限制"); }
  const file = await fs.open(tempPath, "w", 0o600);
  const hash = createHash("sha256"); let bytes = 0n, last = 0;
  try {
    const contentType = response.headers.get("content-type") || "";
    if (/text\/html|application\/json/i.test(contentType)) throw new BadRequestException("来源返回了网页或接口响应，并非组件文件");
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk); bytes += BigInt(buffer.length);
      if (bytes > BigInt(RUNTIME_COMPONENT_MAX_UPLOAD_BYTES)) throw new BadRequestException("组件文件超过服务器大小限制");
      hash.update(buffer);
      let offset = 0;
      while (offset < buffer.length) offset += (await file.write(buffer, offset)).bytesWritten;
      if (Date.now() - last > 1500) { last = Date.now(); await progress(bytes, "downloading"); }
    }
    await progress(bytes, "verifying");
    if (!bytes || (declared > 0 && bytes !== BigInt(declared)) || (latest?.fileSizeBytes && bytes !== latest.fileSizeBytes)) throw new BadRequestException("组件文件大小不匹配");
    const fileHash = hash.digest("hex");
    if (latest?.sha256 && latest.sha256 !== fileHash) throw new BadRequestException("组件文件校验值不匹配");
    await file.sync(); await file.close();
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
    if (process.platform !== "linux" || !arch) throw new BadRequestException("组件内容校验需要 Linux 后台运行环境");
    // The bundled verifier only parses bytes; it never executes downloaded binaries.
    await promisify(execFile)(path.join(agentReleaseRoot(), "agent-go-dist", `chordv-agent-linux-${arch}`),
      ["--validate-component", tempPath, "--component-kind", target.kind, "--component-platform", target.platform, "--component-arch", target.architecture],
      { timeout: 60_000, maxBuffer: 64 * 1024 });
    await fs.rename(tempPath, finalPath);
    return { versionLabel, resolvedUrl: url, fileHash, fileSizeBytes: bytes, storedFilePath: finalPath,
      fileName: latest?.fileName ?? decodeURIComponent(new URL(url).pathname.split("/").pop() || "component.bin") };
  } catch (error) {
    await response.body.cancel().catch(() => undefined); await file.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }); throw error;
  }
}

// Small release pages avoid multiplying every release's asset metadata into one
// response. Both per-page and total byte budgets remain bounded.
export async function listGithubVersionTags(rawUrl: string, fetcher: typeof fetchPublicHttpUrl = fetchPublicHttpUrl) {
  let url: URL; try { url = new URL(rawUrl); } catch { throw new BadRequestException("请填写 GitHub 文件地址"); }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\//);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !match) throw new BadRequestException("此来源不支持 GitHub 版本列表，请填写 GitHub Release 文件地址");
  const tags: Array<{value:string;label:string}> = [];
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(45_000);
  let totalBytes = 0;
  for (let page = 1; page <= 6; page++) {
    let response: Awaited<ReturnType<typeof fetchPublicHttpUrl>>["response"];
    try {
      ({response} = await fetcher(`https://api.github.com/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/releases?per_page=5&page=${page}`,
        {signal,headers:{accept:"application/vnd.github+json","user-agent":"ChordV-release-center"}}, {requireHttps:true,errorPrefix:"GitHub 版本列表"}));
    } catch (error) {
      throw new BadRequestException(signal.aborted ? "读取 GitHub 版本列表超时（45 秒），请稍后重试。" : `无法连接 GitHub 读取第 ${page} 页版本：${error instanceof Error ? error.message : "网络连接失败"}`);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      const reason = response.status === 404 ? "仓库不存在或无权访问，请检查获取来源。"
        : response.status === 403 || response.status === 429 ? "GitHub 拒绝访问或请求额度已用尽，请稍后重试。"
        : "GitHub 服务返回异常，请稍后重试。";
      throw new BadRequestException(`版本列表读取失败（HTTP ${response.status}，第 ${page} 页）：${reason}`);
    }
    const chunks: Buffer[] = []; let pageBytes = 0;
    try {
      for await (const chunk of response.body) {
        pageBytes += chunk.length; totalBytes += chunk.length;
        if (pageBytes > 4 * 1024 * 1024 || totalBytes > 16 * 1024 * 1024) throw new BadRequestException(`GitHub 第 ${page} 页资源信息超出读取限制（单页 4 MiB，总计 16 MiB）。可直接填写准确的发布标签。`);
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      await response.body.cancel().catch(() => undefined);
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(signal.aborted ? "读取 GitHub 版本列表超时（45 秒），请重试。" : `GitHub 第 ${page} 页传输中断，请重新读取。`);
    }
    let records: unknown;
    try { records = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BadRequestException(`GitHub 第 ${page} 页返回的版本信息不是有效 JSON。`); }
    if (!Array.isArray(records)) throw new BadRequestException("GitHub 返回的版本列表格式不正确。");
    for (const record of records) {
      if (record && !record.draft && !record.prerelease && typeof record.tag_name === "string" && !seen.has(record.tag_name)) {
        seen.add(record.tag_name); tags.push({value:record.tag_name,label:record.tag_name});
      }
    }
    if (records.length < 5) break;
  }
  if (!tags.length) throw new BadRequestException("该仓库最近的发布中没有可选稳定版本，请确认来源或直接填写发布标签。");
  return tags;
}
