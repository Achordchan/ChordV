import { BadRequestException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RELEASE_ARTIFACT_MAX_UPLOAD_BYTES } from "./upload-limits";
import { fetchPublicHttpUrl } from "./remote-url.utils";

export type ArtifactImportProgress = { stage: "downloading" | "saving"; downloadedBytes: number; totalBytes: number | null };
export type ArtifactImportInput = { sourceUrl: string; artifactId?: string; isPrimary?: boolean };

/** Stream to a private temporary file; never execute the downloaded package. */
export async function downloadHostedArtifact(
  sourceUrl: string,
  signal: AbortSignal,
  progress: (value: ArtifactImportProgress) => void,
  fetcher: typeof fetchPublicHttpUrl = fetchPublicHttpUrl
) {
  let url: URL;
  try { url = new URL(sourceUrl); } catch { throw new BadRequestException("请填写完整的 HTTPS 来源地址。"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new BadRequestException("来源必须是不含账号密码的 HTTPS 地址。");
  const { response, resolvedUrl } = await fetcher(url.toString(), {
    signal, headers: { "user-agent": "ChordV-artifact-import", "accept-encoding": "identity" }
  }, { requireHttps: true, errorPrefix: "安装包来源" });
  const tempPath = path.join(tmpdir(), `chordv-import-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    if (response.status !== 200 || !response.body) throw new BadRequestException(`来源不可下载（HTTP ${response.status}）。`);
    if (/text\/html|application\/(?:problem\+)?json/i.test(response.headers.get("content-type") ?? "")) throw new BadRequestException("来源返回了网页或接口响应，请使用安装包下载链接。");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") throw new BadRequestException("来源返回了压缩传输内容，无法核对安装包大小。");
    const declaredText = response.headers.get("content-length");
    const declared = declaredText && /^\d+$/.test(declaredText) ? Number(declaredText) : null;
    if (declared !== null && (!Number.isSafeInteger(declared) || declared > RELEASE_ARTIFACT_MAX_UPLOAD_BYTES)) throw new BadRequestException(`安装包超过服务器上限（${RELEASE_ARTIFACT_MAX_UPLOAD_BYTES} 字节）。`);
    let bytes = 0, lastProgress = 0;
    const hash = createHash("sha256");
    handle = await fs.open(tempPath, "wx", 0o600);
    progress({ stage: "downloading", downloadedBytes: 0, totalBytes: declared });
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > RELEASE_ARTIFACT_MAX_UPLOAD_BYTES) throw new BadRequestException(`安装包超过服务器上限（${RELEASE_ARTIFACT_MAX_UPLOAD_BYTES} 字节）。`);
      hash.update(buffer);
      let offset = 0;
      while (offset < buffer.length) {
        const written = await handle.write(buffer, offset, buffer.length - offset);
        if (!written.bytesWritten) throw new Error("安装包文件写入中断");
        offset += written.bytesWritten;
      }
      if (Date.now() - lastProgress > 250) { progress({ stage: "downloading", downloadedBytes: bytes, totalBytes: declared }); lastProgress = Date.now(); }
    }
    if (!bytes || (declared !== null && bytes !== declared)) throw new BadRequestException("安装包下载不完整，请重试。");
    await handle.sync(); await handle.close(); handle = null;
    progress({ stage: "saving", downloadedBytes: bytes, totalBytes: bytes });
    return {
      path: tempPath, size: bytes, fileHash: hash.digest("hex"),
      originalname: importedFileName(response.headers.get("content-disposition"), resolvedUrl, url.toString()),
      cleanup: () => fs.rm(tempPath, { force: true })
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true });
    throw error;
  } finally { await response.body?.cancel().catch(() => undefined); }
}

export function importedFileName(disposition: string | null, url: string, sourceUrl = url): string {
  let name: string | undefined;
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  try { if (encoded) name = decodeURIComponent(encoded.trim()); } catch { /* Try the ordinary filename below. */ }
  name ||= disposition?.match(/filename="([^"]+)"/i)?.[1]
    ?? disposition?.match(/filename=([^;]+)/i)?.[1]?.trim();
  if (!name) {
    try { name = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || ""); }
    catch { /* Opaque URLs use a platform-derived filename when stored. */ }
  }
  return (name ?? "").split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) || "";
}
