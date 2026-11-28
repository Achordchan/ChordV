import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { deflateSync, inflateSync } from "node:zlib";
import { waitForState } from "./agent-harness.mjs";
import { createImageProvider } from "./image-provider.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}
// One opaque blue RGBA pixel, valid zlib stream and independently checked CRCs.
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 0, 90, 220, 255]))), chunk("IEND", Buffer.alloc(0))]);
const auth = (provider) => ({ Authorization: `Bearer ${provider.credentials.apiToken}` });
function upload(provider, { name = "fixture.png", bytes = png, mime = "image/png", query = "", signal } = {}) {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mime }), name);
  return fetch(`${provider.origin}/upload?returnFormat=full${query}`, { method: "POST", headers: auth(provider), body: form, signal });
}
async function add(provider, input) {
  const response = await upload(provider, input);
  assert.equal(response.status, 200);
  return (await response.json()).url;
}
async function list(provider, query = "") {
  const response = await fetch(`${provider.origin}/api/manage/list?count=50${query}`, { headers: auth(provider) });
  assert.equal(response.status, 200);
  return response.json();
}

test("real multipart bytes are retained and anonymously served as a valid renderable PNG", async () => {
  const provider = await createImageProvider();
  try {
    assert.equal(new URL(provider.origin).hostname, "127.0.0.1");
    const url = await add(provider, { name: "后台截图.png", query: "&uploadFolder=e2e%2Fsupport" });
    const response = await fetch(new URL(url, provider.origin));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.equal(Number(response.headers.get("Content-Length")), png.length);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, png);
    const chunks = [];
    for (let offset = 8; offset < bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      const payload = bytes.subarray(offset + 4, offset + 8 + size);
      assert.equal(crc32(payload), bytes.readUInt32BE(offset + 8 + size));
      chunks.push({ type: payload.toString("ascii", 0, 4), data: payload.subarray(4) });
      offset += size + 12;
    }
    assert.deepEqual(chunks.map((value) => value.type), ["IHDR", "IDAT", "IEND"]);
    assert.deepEqual(inflateSync(chunks[1].data), Buffer.from([0, 0, 90, 220, 255]));
    const listing = await list(provider, "&search=" + encodeURIComponent("后台截图"));
    assert.equal(listing.totalCount, 1);
    assert.equal(listing.returnedCount, 1);
    assert.match(listing.files[0].name, /^e2e\/support\/[^/]+-后台截图.png$/);
    assert.equal(listing.files[0].metadata["File-Size"], png.length);
    assert.equal(listing.files[0].metadata["File-Mime"], "image/png");
    assert.equal(listing.files[0].metadata.Channel, "local");
    assert.ok(Number.isFinite(Date.parse(listing.files[0].metadata.TimeStamp)));
    assert.equal(provider.snapshot().uploaded, 1);
  } finally { await provider.stop(); }
});

test("API and control have distinct random bearer credentials and snapshots never expose either", async () => {
  const provider = await createImageProvider(), second = await createImageProvider();
  try {
    assert.equal(provider.credentials.apiToken.length, 43);
    assert.equal(provider.credentials.controlToken.length, 43);
    assert.ok(provider.credentials.apiToken !== provider.credentials.controlToken);
    assert.ok(provider.credentials.apiToken !== second.credentials.apiToken);
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: `Bearer ${provider.credentials.controlToken}` }]) {
      assert.equal((await fetch(`${provider.origin}/api/manage/list`, { headers })).status, 401);
      assert.equal((await fetch(`${provider.origin}/upload`, { method: "POST", headers, body: "ignored" })).status, 401);
      assert.equal((await fetch(`${provider.origin}/api/manage/delete/e2e/a.png`, { headers })).status, 401);
    }
    for (const headers of [{}, auth(provider)]) assert.equal((await fetch(`${provider.origin}/__test/control`, { headers })).status, 401);
    const response = await fetch(`${provider.origin}/__test/control`, { headers: { Authorization: `Bearer ${provider.credentials.controlToken}` } });
    assert.equal(response.status, 200);
    const serialized = JSON.stringify(await response.json()) + JSON.stringify(provider.snapshot());
    assert.ok(!serialized.includes(provider.credentials.apiToken));
    assert.ok(!serialized.includes(provider.credentials.controlToken));
    const config = provider.getConfig();
    assert.ok(config.apiToken === provider.credentials.apiToken);
    assert.equal(config.baseUrl, provider.origin);
    assert.equal(config.uploadFolder, "e2e");
  } finally { await Promise.all([provider.stop(), second.stop()]); }
});

test("Go CreateFormFile-equivalent octet-stream part uploads real PNG and rejects non-PNG bytes", async () => {
  const provider = await createImageProvider();
  try {
    const boundary = "go-create-form-file-boundary";
    const post = (bytes) => fetch(`${provider.origin}/upload?returnFormat=full&uploadFolder=e2e`, {
      method: "POST", headers: { ...auth(provider), "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="go-upload.png"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        bytes, Buffer.from(`\r\n--${boundary}--\r\n`)
      ])
    });
    const response = await post(png);
    assert.equal(response.status, 200);
    const url = (await response.json()).url;
    const display = await fetch(new URL(url, provider.origin));
    assert.equal(display.headers.get("Content-Type"), "image/png");
    assert.deepEqual(Buffer.from(await display.arrayBuffer()), png);
    assert.equal((await post(Buffer.from("this is not PNG"))).status, 415);
    assert.equal(provider.snapshot().uploaded, 1);
    assert.equal((await list(provider, "&search=go-upload")).totalCount, 1);
  } finally { await provider.stop(); }
});

test("search, directory depth and pagination operate on actual uploaded files", async () => {
  const provider = await createImageProvider();
  try {
    await add(provider, { name: "alpha.png" });
    await add(provider, { name: "beta.png" });
    await add(provider, { name: "alpha-child.png", query: "&uploadFolder=e2e%2Fchild" });
    assert.equal((await list(provider, "&search=ALPHA")).totalCount, 2);
    assert.equal((await list(provider, "&search=missing")).totalCount, 0);
    assert.equal((await list(provider, "&dir=e2e&recursive=false")).totalCount, 2);
    assert.equal((await list(provider, "&dir=e2e&recursive=true")).totalCount, 3);
    assert.equal((await list(provider, "&dir=e2e%2Fchild")).totalCount, 1);
    const paged = await fetch(`${provider.origin}/api/manage/list?start=1&count=1`, { headers: auth(provider) });
    const page = await paged.json();
    assert.equal(page.totalCount, 3); assert.equal(page.returnedCount, 1);
    assert.match(page.files[0].name, /beta.png$/);
    for (const query of ["start=-1", "start=1.5", "count=101", "count=no", "dir=..%2Fother"]) {
      assert.equal((await fetch(`${provider.origin}/api/manage/list?${query}`, { headers: auth(provider) })).status, 400);
    }
  } finally { await provider.stop(); }
});

test("Go-compatible GET deletion and DELETE remove files and enforce directory boundaries", async () => {
  const provider = await createImageProvider();
  try {
    const url = await add(provider);
    const name = decodeURIComponent(url.slice(6));
    const remove = (path, method = "GET") => fetch(`${provider.origin}/api/manage/delete/${path}`, { method, headers: auth(provider) });
    assert.equal((await remove(name)).status, 200);
    assert.equal((await fetch(new URL(url, provider.origin))).status, 404);
    assert.equal((await remove(name)).status, 404);
    const another = await add(provider, { name: "delete.png" });
    assert.equal((await remove(another.slice(6), "DELETE")).status, 200);
    await add(provider, { query: "&uploadFolder=e2e%2Fchild" });
    await add(provider, { query: "&uploadFolder=e2e-other" });
    const response = await remove("e2e?folder=true");
    assert.equal((await response.json()).deletedCount, 1);
    assert.equal((await list(provider)).totalCount, 1);
    assert.match((await list(provider)).files[0].name, /^e2e-other\//);
    assert.equal(provider.snapshot().deleted, 3);
  } finally { await provider.stop(); }
});

test("HTTP mode control produces real 503 errors without creating a file, then recovers", async () => {
  const provider = await createImageProvider();
  try {
    assert.equal((await provider.setMode("http503")).mode, "http503");
    const failed = await upload(provider);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).success, false);
    assert.equal(provider.snapshot().uploaded, 0);
    assert.equal((await list(provider)).totalCount, 0);
    await provider.setMode("success");
    await add(provider);
    assert.equal(provider.snapshot().uploaded, 1);
    assert.equal(provider.snapshot().http503, 1);
    await assert.rejects(provider.setMode("not-a-mode"), /HTTP 422/);
    await assert.rejects(provider.setMode("timeout", { delayMs: 0 }), /HTTP 422/);
    assert.equal(provider.snapshot().mode, "success");
  } finally { await provider.stop(); }
});

test("a delayed HTTP upload only stores bytes after the configured delay", async () => {
  const provider = await createImageProvider();
  try {
    await provider.setMode("timeout", { delayMs: 180 });
    const start = performance.now(), pending = upload(provider);
    await waitForState("图床上传已进入真实延迟", () => provider.snapshot().pendingDelays === 1, provider.events, 2000);
    assert.equal(provider.snapshot().uploaded, 0);
    assert.equal((await pending).status, 200);
    assert.ok(performance.now() - start >= 160);
    assert.equal(provider.snapshot().delayCompleted, 1);
    assert.equal(provider.snapshot().pendingDelays, 0);
    assert.equal(provider.snapshot().uploaded, 1);
  } finally { await provider.stop(); }
});

for (const timedOut of [false, true]) test(`HTTP ${timedOut ? "timeout" : "cancellation"} clears delay and cannot store a late file`, async () => {
  const provider = await createImageProvider({ mode: "timeout", delayMs: 30000 });
  try {
    const controller = new AbortController();
    const signal = timedOut ? AbortSignal.timeout(300) : controller.signal;
    const pending = upload(provider, { signal }).then((response) => ({ response }), (error) => ({ error }));
    await waitForState("图床真实延迟开始", () => provider.snapshot().delayStarted === 1, provider.events, 2000);
    if (!timedOut) controller.abort();
    assert.equal((await pending).error?.name, timedOut ? "TimeoutError" : "AbortError");
    await waitForState("图床延迟已取消", () => provider.snapshot().delayCancelled === 1 && provider.snapshot().pendingDelays === 0, provider.events, 2000);
    assert.equal(provider.snapshot().uploaded, 0);
    assert.equal(provider.snapshot().storedBytes, 0);
    await provider.setMode("success");
    await add(provider);
    assert.equal(provider.snapshot().uploaded, 1);
  } finally { await provider.stop(); }
});

test("invalid or oversized multipart and non-PNG content never create files", async () => {
  const provider = await createImageProvider();
  try {
    for (const input of [{ bytes: Buffer.from("not a PNG") }, { mime: "text/plain" }, { bytes: Buffer.alloc(0) }]) assert.ok((await upload(provider, input)).status >= 400);
    const empty = new FormData();
    assert.equal((await fetch(`${provider.origin}/upload`, { method: "POST", headers: auth(provider), body: empty })).status, 400);
    assert.equal((await fetch(`${provider.origin}/upload`, { method: "POST", headers: { ...auth(provider), "Content-Type": "application/json" }, body: "{}" })).status, 415);
    const malformed = await fetch(`${provider.origin}/upload`, { method: "POST", headers: { ...auth(provider), "Content-Type": "multipart/form-data; boundary=x" }, body: "invalid" });
    assert.equal(malformed.status, 400);
    assert.equal((await upload(provider, { bytes: Buffer.alloc(10 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await upload(provider, { bytes: Buffer.alloc(11 * 1024 * 1024) })).status, 413);
    assert.equal((await upload(provider, { query: "&uploadFolder=..%2Foutside" })).status, 400);
    assert.equal(provider.snapshot().uploaded, 0);
    assert.equal(provider.snapshot().storedBytes, 0);
  } finally { await provider.stop(); }
});

function rawRequest(provider, { path, headers = {}, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(provider.origin, { path, headers, method }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
    req.once("error", reject);
    req.end(body);
  });
}
test("foreign Host/Origin, invalid encodings and traversal are rejected", async () => {
  const provider = await createImageProvider();
  try {
    assert.equal(await rawRequest(provider, { path: "/api/manage/list", headers: { ...auth(provider), Host: "foreign.invalid" } }), 403);
    assert.equal((await fetch(`${provider.origin}/api/manage/list`, { headers: { ...auth(provider), Origin: "https://foreign.invalid" } })).status, 403);
    for (const path of ["/file/%2e%2e/secret", "/file/e2e%5Csecret", "/file/e2e//secret", "/file/e2e/%00", "/file/%ZZ", "/api/manage/delete/e2e/%2e%2e/file"]) {
      assert.equal(await rawRequest(provider, { path, headers: auth(provider) }), 400);
    }
    assert.equal(provider.snapshot().deleted, 0);
  } finally { await provider.stop(); }
});

test("stop cancels in-flight delay, closes connections, clears bytes, and is idempotent", async () => {
  const provider = await createImageProvider();
  try {
    await add(provider);
    await provider.setMode("timeout");
    const pending = upload(provider).then((response) => ({ response }), (error) => ({ error }));
    await waitForState("停止前上传已进入延迟", () => provider.snapshot().pendingDelays === 1, provider.events, 2000);
    const start = performance.now();
    await Promise.all([provider.stop(), provider.stop()]);
    assert.ok(performance.now() - start < 2000);
    assert.ok((await pending).error);
    const state = provider.snapshot();
    assert.equal(state.files.length, 0); assert.equal(state.storedBytes, 0);
    assert.equal(state.pendingDelays, 0); assert.equal(state.delayCancelled, 1); assert.equal(state.stopped, true);
    await assert.rejects(fetch(`${provider.origin}/api/manage/list`, { signal: AbortSignal.timeout(1000) }));
  } finally { await provider.stop(); }
});

test("invalid configuration is rejected before binding a socket", async () => {
  for (const port of [-1, 65536, 1.5, "0"]) await assert.rejects(createImageProvider({ port }), /端口无效/);
  await assert.rejects(createImageProvider({ mode: "bad" }), /INVALID_MODE/);
});

test("stop aborts a partially streamed multipart body rather than waiting for its end", async () => {
  const provider = await createImageProvider();
  const req = request(provider.origin + "/upload", { method: "POST", headers: {
    ...auth(provider), "Content-Type": "multipart/form-data; boundary=waiting", "Transfer-Encoding": "chunked"
  } });
  const disconnected = new Promise((resolve) => { req.once("error", resolve); req.once("close", resolve); });
  try {
    req.write("--waiting\r\nContent-Disposition: form-data; name=\"file\"; filename=\"partial.png\"\r\nContent-Type: image/png\r\n\r\n");
    await waitForState("服务已收到未结束的请求体", () => provider.snapshot().uploadRequests === 1, provider.events, 2000);
    const start = performance.now();
    await provider.stop();
    await disconnected;
    assert.ok(performance.now() - start < 2000);
    assert.equal(provider.snapshot().uploaded, 0);
    assert.equal(provider.snapshot().storedBytes, 0);
  } finally { req.destroy(); await provider.stop(); }
});

test("in-memory file count is bounded and deletion frees capacity", async () => {
  const provider = await createImageProvider();
  try {
    for (let i = 0; i < 100; i++) await add(provider, { name: `capacity-${i}.png` });
    assert.equal(provider.snapshot().files.length, 100);
    assert.equal((await upload(provider)).status, 507);
    assert.equal(provider.snapshot().uploaded, 100);
    const name = provider.snapshot().files[0].name;
    assert.equal((await fetch(`${provider.origin}/api/manage/delete/${name}`, { headers: auth(provider) })).status, 200);
    await add(provider);
    assert.equal(provider.snapshot().files.length, 100);
    assert.equal(provider.snapshot().storedBytes, 100 * png.length);
  } finally { await provider.stop(); }
});
