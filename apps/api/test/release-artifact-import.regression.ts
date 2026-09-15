import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { downloadHostedArtifact, importedFileName } from "../src/modules/common/release-artifact-import";

async function main() {
  const bytes = Buffer.from("a deterministic installer fixture");
  const events: unknown[] = [];
  const file = await downloadHostedArtifact("https://example.com/ChordV.dmg", new AbortController().signal, event => events.push(event), (async (url: string, options: any, settings: any) => {
    assert.equal(options.headers["accept-encoding"], "identity");
    assert.equal(settings.requireHttps, true);
    return { response: new Response(bytes, { headers: { "content-length": String(bytes.length), "content-type": "application/octet-stream" } }), resolvedUrl: url };
  }) as any);
  try {
    assert.equal(file.size, bytes.length);
    assert.equal(file.fileHash, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(file.originalname, "ChordV.dmg");
    assert.deepEqual(await fs.readFile(file.path), bytes);
    assert.equal((events.at(-1) as any).stage, "saving");
  } finally { await file.cleanup(); }
  await assert.rejects(fs.stat(file.path), /ENOENT/);

  const chunked = await downloadHostedArtifact("https://example.com/get", new AbortController().signal, () => {}, (async (url: string) => ({ response: new Response(bytes), resolvedUrl: url })) as any);
  assert.equal(chunked.size, bytes.length, "Content-Length is optional when actual bytes are counted");
  await chunked.cleanup();
  const response = (headers: Record<string,string>, body = bytes) => (async (url: string) => ({response:new Response(body,{headers}),resolvedUrl:url})) as any;
  await assert.rejects(downloadHostedArtifact("https://example.com/a.dmg", new AbortController().signal, () => {}, response({"content-length":"1000"})), /不完整/);
  await assert.rejects(downloadHostedArtifact("https://example.com/a.dmg", new AbortController().signal, () => {}, response({"content-length":"1073741825"})), /上限/);
  await assert.rejects(downloadHostedArtifact("https://example.com/a.dmg", new AbortController().signal, () => {}, response({"content-type":"text/html"})), /网页/);
  await assert.rejects(downloadHostedArtifact("https://example.com/a.dmg", new AbortController().signal, () => {}, response({"content-encoding":"gzip"})), /压缩/);
  let fetched = false;
  const forbidden = (async () => { fetched = true; throw new Error("unexpected request"); }) as any;
  for (const url of ["http://example.com/file", "file:///tmp/file", "https://user:secret@example.com/file"]) {
    await assert.rejects(downloadHostedArtifact(url,new AbortController().signal,()=>{},forbidden), /HTTPS/);
  }
  assert.equal(fetched,false);
  const controller = new AbortController();
  await assert.rejects(downloadHostedArtifact("https://example.com/a.dmg",controller.signal,()=>controller.abort(),response({})), /abort/i);
  assert.equal(importedFileName("attachment; filename*=UTF-8''%E5%AE%89%E8%A3%85%E5%8C%85.dmg", "https://example.com/get"), "安装包.dmg");
  assert.equal(importedFileName('attachment; filename="../../file.zip"', "https://example.com/get"), "file.zip");
  assert.equal(importedFileName("attachment; filename=ChordV_1.1.8.dmg", "https://cdn.example.com/uuid"), "ChordV_1.1.8.dmg");
  assert.equal(importedFileName(null, "https://cdn.example.com/uuid", "https://github.com/Achordchan/ChordV/releases/download/v1.1.8/ChordV_1.1.8.dmg"), "ChordV_1.1.8.dmg");
  await assert.rejects(downloadHostedArtifact("https://127.0.0.1:9/file.dmg", AbortSignal.timeout(3000), () => {}), /private|local|public/i);
  console.log("release artifact import regression checks passed");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
