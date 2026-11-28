import assert from "node:assert/strict";
import { test } from "node:test";
import { readReleaseTextResponse } from "../src/lib/releaseTextResponse";

const origin = "https://raw.githubusercontent.com/example/app/release-channels/stable.json";
test("分块 UTF-8 清单保留原文、BOM 和末尾换行；无效字节不替换", async () => {
  const text = "\ufeff发布说明\n", bytes = new TextEncoder().encode(text);
  const response = new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } }));
  assert.equal((await readReleaseTextResponse(origin, response)).body, text);
  await assert.rejects(readReleaseTextResponse(origin, new Response(Uint8Array.of(0xe4))));
});
test("无长度头也对解码后的字节限量，过大时取消而不消费剩余数据", async () => {
  for (const [url, limit] of [[origin, 1 << 20], [origin + ".sig", 1024], ["https://api.github.com/repos/example/app/releases", 8 << 20]] as const) {
    const bytes = new Uint8Array(limit).fill(65);
    assert.equal((await readReleaseTextResponse(url, new Response(bytes))).body.length, limit);
    let cancelled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes); c.enqueue(Uint8Array.of(65)); }, cancel() { cancelled = true; } });
    await assert.rejects(readReleaseTextResponse(url, new Response(stream)), /过大/);
    assert.equal(cancelled, true);
  }
});
