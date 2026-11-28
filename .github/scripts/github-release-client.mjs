const API = "https://api.github.com";
const assetHosts = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const redirects = new Set([301, 302, 303, 307, 308]);
function discard(response) { if (response.body) void response.body.cancel().catch(() => undefined); }
export function github({ repository, token, fetchImpl = fetch, channelOnly = false, draftOnly }) {
  const prefix = `/repos/${repository}`;
  if (draftOnly && (channelOnly || !Number.isSafeInteger(draftOnly.releaseId) || draftOnly.releaseId <= 0 || !Array.isArray(draftOnly.files))) throw new Error("Invalid draft completion scope");
  const draftFiles = new Set(draftOnly?.files), draftId = draftOnly?.releaseId;
  return async (path, { method = "GET", body, expected = [200], upload = false, uploadSize, download = false, maxBytes = 4 * 1024 * 1024 } = {}) => {
    const relative = upload ? "" : path.slice(prefix.length);
    if (!upload && (path.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase() || relative !== "" && !relative.startsWith("/"))) throw new Error("GitHub request is outside the expected repository");
    if (channelOnly && (method !== "GET" || upload)) {
      const allowed = method === "POST" && ["/git/blobs", "/git/trees", "/git/commits"].includes(relative)
        || method === "POST" && relative === "/git/refs" && body?.ref === "refs/heads/release-channels"
        || method === "PATCH" && relative === "/git/refs/heads/release-channels" && body?.force === false;
      if (!allowed || upload || body?.force === true) throw new Error("Channel recovery forbids release or asset writes and non-channel ref updates");
    }
    if (draftOnly && (method !== "GET" || upload)) {
      const url = upload ? new URL(path) : null;
      const allowedUpload = upload && method === "POST" && url.origin === "https://uploads.github.com"
        && !url.username && !url.password && !url.hash && url.pathname.toLowerCase() === `${prefix}/releases/${draftId}/assets`.toLowerCase()
        && [...url.searchParams.keys()].length === 1 && draftFiles.has(url.searchParams.get("name"));
      const allowedPublish = !upload && method === "PATCH" && relative === `/releases/${draftId}`
        && body?.draft === false && ["true", "false"].includes(body.make_latest)
        && Object.keys(body).length === 2;
      if (!allowedUpload && !allowedPublish) throw new Error("Draft completion forbids this write outside its missing assets and release ID");
    }
    if (upload && new URL(path).origin !== "https://uploads.github.com") throw new Error("Invalid GitHub upload origin");
    if (upload && (!Number.isSafeInteger(uploadSize) || uploadSize <= 0)) throw new Error("Invalid locked upload size");
    const signal = AbortSignal.timeout(upload || download ? 15 * 60 * 1000 : 30_000);
    let response = await fetchImpl(upload ? path : `${API}${path}`, {
      method, headers: {
        Accept: download ? "application/octet-stream" : "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": upload ? "application/octet-stream" : "application/json",
        ...(upload ? { "Content-Length": String(uploadSize) } : {})
      },
      ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }),
      ...(upload ? { duplex: "half" } : {}), redirect: "manual", signal
    });
    for (let redirectsFollowed = 0; download && redirects.has(response.status); redirectsFollowed++) {
      discard(response);
      let url;
      try { url = new URL(response.headers.get("location")); }
      catch { throw new Error("Invalid GitHub asset download redirect"); }
      if (!url || url.protocol !== "https:" || url.username || url.password || url.port || !assetHosts.has(url.hostname) || redirectsFollowed >= 3) throw new Error("Untrusted or excessive GitHub asset download redirect");
      response = await fetchImpl(url.href, { method: "GET", headers: { Accept: "application/octet-stream" }, redirect: "manual", signal });
    }
    if (!expected.includes(response.status)) {
      discard(response);
      const error = new Error(`GitHub request failed: ${method} ${upload ? "release asset upload" : path} (${response.status})`);
      error.status = response.status; throw error;
    }
    if (download) return response;
    if (response.status === 204 || response.status === 404) { discard(response); return null; }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 4 * 1024 * 1024) { discard(response); throw new Error("Invalid GitHub metadata response limit"); }
    const chunks = []; let size = 0;
    if (!response.body) throw new Error("GitHub metadata response has no body");
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length; if (size > maxBytes) throw new Error("GitHub metadata response exceeds its bounded limit");
        chunks.push(Buffer.from(next.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) { void reader.cancel(error).catch(() => undefined); throw error; }
    finally { reader.releaseLock(); }
  };
}
export function gitObject(value) {
  if (!value || !/^[a-f0-9]{40,64}$/.test(value.sha ?? "")) throw new Error("Invalid GitHub tag/commit identity");
  return value;
}
export async function assertTagSource(api, prefix, manifest, { required = false } = {}) {
  const ref = await api(`${prefix}/git/ref/tags/${encodeURIComponent(manifest.tag)}`, { expected: [200, 404] });
  if (!ref) {
    if (required) throw new Error("Published release tag is missing");
    return;
  }
  let object = gitObject(ref.object);
  const seen = new Set();
  while (object.type === "tag") {
    if (seen.has(object.sha) || seen.size >= 10) throw new Error("GitHub release tag cycle or excessive annotated tag depth");
    seen.add(object.sha);
    const tag = await api(`${prefix}/git/tags/${object.sha}`);
    if (tag.sha !== object.sha) throw new Error("GitHub release tag commit identity mismatch");
    object = gitObject(tag.object);
  }
  if (object.type !== "commit" || object.sha !== manifest.sourceCommit) throw new Error("GitHub release tag does not point to the manifest source commit");
}
