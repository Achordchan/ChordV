import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { gitReleaseAPI } from "./git-release-api.mjs";

export async function httpReleaseAPI(t, options) {
  const remote = await gitReleaseAPI(t, options), requests = [], faults = {};
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.headers["x-original-url"]);
      assert.ok(["api.github.com", "uploads.github.com"].includes(url.hostname));
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), upload = url.hostname === "uploads.github.com";
      const input = { method: request.method, headers: { Authorization: request.headers.authorization },
        ...(request.method === "GET" ? {} : { body: upload ? [bytes] : bytes.toString() }) };
      requests.push({ method: request.method, path: url.pathname, host: url.hostname, name: url.searchParams.get("name"), contentLength: request.headers["content-length"], bodyBytes: bytes.length });
      const context = { url, options: input, remote };
      let result = await faults.before?.(context) ?? await remote.fetchImpl(url.href, input);
      result = await faults.after?.({ ...context, response: result }) ?? result;
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const fetchImpl = (url, input) => fetch(`http://127.0.0.1:${server.address().port}/bridge`, {
    ...input, headers: { ...input.headers, "x-original-url": String(url) }
  });
  return { ...remote, requests, faults, fetchImpl };
}
