import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import worker, { hashToken, INVALID_BODY, INVALID_NOTICE, UPDATE_INTERVAL_HOURS } from "../src/worker.mjs";

const TOKEN = "A".repeat(43);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function createEnv(entries = {}) {
  const reads = [];
  return {
    reads,
    env: {
      LINKS: {
        get: async (key) => {
          reads.push(key);
          const value = entries[key];
          if (value instanceof Error) throw value;
          return value ?? null;
        }
      }
    }
  };
}

function request(path, method = "GET") {
  return new Request(`https://sub.example.com${path}`, { method });
}

const stored = (document) => ({ [sha256(TOKEN)]: JSON.stringify(document) });

test("the store is keyed by sha256 of the token, never by the token", async () => {
  assert.equal(await hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const { env, reads } = createEnv();
  await worker.fetch(request(`/s/${TOKEN}`), env);
  assert.deepEqual(reads, [sha256(TOKEN)]);
});

test("a published link returns its body and headers unchanged", async () => {
  const userinfo = "upload=0; download=1073741824; total=107374182400; expire=1798761600";
  const { env } = createEnv(stored({ v: 1, body: "dmxlc3M6Ly9leGFtcGxl", userinfo }));
  const response = await worker.fetch(request(`/s/${TOKEN}`), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "dmxlc3M6Ly9leGFtcGxl");
  assert.equal(response.headers.get("subscription-userinfo"), userinfo);
  assert.equal(response.headers.get("profile-update-interval"), String(UPDATE_INTERVAL_HOURS));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("a document without usage omits the usage header", async () => {
  const { env } = createEnv(stored({ v: 1, body: "Ym9keQ==", userinfo: null }));
  const response = await worker.fetch(request(`/s/${TOKEN}`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.has("subscription-userinfo"), false);
});

test("HEAD answers like GET without a body", async () => {
  const { env } = createEnv(stored({ v: 1, body: "Ym9keQ==", userinfo: "upload=0; download=0; total=1; expire=2" }));
  const response = await worker.fetch(request(`/s/${TOKEN}`, "HEAD"), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("subscription-userinfo"), "upload=0; download=0; total=1; expire=2");
});

test("an unknown token gets the invalid-link notice, not an error and not an empty list", async () => {
  const { env } = createEnv();
  const response = await worker.fetch(request(`/s/${TOKEN}`), env);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body, INVALID_BODY);
  const [line, ...rest] = Buffer.from(body, "base64").toString("utf8").split("\n");
  assert.deepEqual(rest, []);
  const link = new URL(line);
  assert.equal(link.protocol, "vless:");
  assert.equal(link.hostname, "127.0.0.1");
  assert.equal(decodeURIComponent(link.hash.slice(1)), INVALID_NOTICE);
  assert.equal(response.headers.has("subscription-userinfo"), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a store failure fails the refresh instead of telling the client its link is invalid", async () => {
  const { env } = createEnv({ [sha256(TOKEN)]: new Error("KV unavailable: internal detail") });
  const response = await worker.fetch(request(`/s/${TOKEN}`), env);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.notEqual(body, INVALID_BODY);
  assert.ok(!body.includes("internal detail"));
});

test("a stored value this version cannot read fails the refresh too", async () => {
  for (const value of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ v: 2, body: "Ym9keQ==", userinfo: null }),
    JSON.stringify({ body: "Ym9keQ==", userinfo: null }),
    JSON.stringify({ v: 1, body: "", userinfo: null }),
    JSON.stringify({ v: 1, body: 5, userinfo: null }),
    JSON.stringify({ v: 1, body: "Ym9keQ==", userinfo: 5 }),
    JSON.stringify({ v: 1, body: "Ym9keQ==" }),
    JSON.stringify({ v: 1, body: "Ym9keQ==", userinfo: "upload=0\r\nx-injected: 1" })
  ]) {
    const { env } = createEnv({ [sha256(TOKEN)]: value });
    const response = await worker.fetch(request(`/s/${TOKEN}`), env);
    assert.equal(response.status, 503, value);
    assert.equal(response.headers.has("x-injected"), false);
  }
});

test("anything that is not a link path is a 404 and never touches the store", async () => {
  const paths = [
    "/",
    "/s",
    "/s/",
    `/s/${TOKEN}/`,
    `/s/${TOKEN}x`,
    `/s/${TOKEN.slice(1)}`,
    `/S/${TOKEN}`,
    `/sub/${TOKEN}`,
    `/s/${"A".repeat(42)}=`,
    `/s/${"A".repeat(42)}%41`,
    "/s/../s/" + TOKEN + "/extra",
    "/favicon.ico",
    "/robots.txt"
  ];
  for (const path of paths) {
    const { env, reads } = createEnv();
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 404, path);
    assert.deepEqual(reads, [], path);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("the query string is ignored: clients append their own parameters", async () => {
  const { env, reads } = createEnv(stored({ v: 1, body: "Ym9keQ==", userinfo: null }));
  const response = await worker.fetch(request(`/s/${TOKEN}?flag=1&client=v2rayN`), env);
  assert.equal(response.status, 200);
  assert.deepEqual(reads, [sha256(TOKEN)]);
});

test("only GET and HEAD are served", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const { env, reads } = createEnv(stored({ v: 1, body: "Ym9keQ==", userinfo: null }));
    const response = await worker.fetch(request(`/s/${TOKEN}`, method), env);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.deepEqual(reads, [], method);
  }
});
