import { assertChannelPromotion, assertManifestContract, verifyManifestSignature } from "./github-release-contract.mjs";
import { gitObject } from "./github-release-client.mjs";

export async function channelSnapshot(api, prefix, manifest, kind, key, identical) {
  const ref = await api(`${prefix}/git/ref/heads/release-channels`, { expected: [200, 404] });
  if (!ref) return { ref: null, parent: null };
  const object = gitObject(ref.object);
  if (object.type !== "commit") throw new Error("Invalid release channel commit reference");
  const parent = await api(`${prefix}/git/commits/${object.sha}`);
  if (parent.sha !== object.sha) throw new Error("Release channel parent commit mismatch");
  gitObject(parent.tree);
  const name = `${kind === "server" ? "server-" : ""}${manifest.channel}.json`;
  const previous = await api(`${prefix}/contents/${name}?ref=${object.sha}`, { expected: [200, 404] });
  const signature = await api(`${prefix}/contents/${name}.sig?ref=${object.sha}`, { expected: [200, 404] });
  if (Boolean(previous) !== Boolean(signature)) throw new Error("Release channel JSON and signature must both exist at the same commit");
  if (previous) {
    if ([previous, signature].some(file => file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string")) throw new Error("Invalid release channel JSON/signature file");
    const body = Buffer.from(previous.content, "base64");
    verifyManifestSignature(body, Buffer.from(signature.content, "base64").toString("utf8"), key);
    const current = JSON.parse(body.toString("utf8"));
    assertManifestContract(current, kind, manifest.channel, prefix.slice("/repos/".length));
    if (identical && body.equals(identical.body) && Buffer.from(signature.content, "base64").equals(identical.signature)) return { ref, parent, identical: true };
    assertChannelPromotion(current, manifest);
  }
  return { ref, parent };
}
export async function promoteChannel(api, repository, manifest, body, signature, kind, key, { allowIdentical = false, beforeAttempt } = {}) {
  const prefix = `/repos/${repository}`, branch = "release-channels";
  const channelName = `${kind === "server" ? "server-" : ""}${manifest.channel}.json`;
  // Git tree和ref一次提交同时更新JSON/.sig；并发发布在非强推冲突时重新读取当前分支。
  for (let attempt = 0; attempt < 3; attempt++) {
    if (beforeAttempt) await beforeAttempt();
    const { ref, parent, identical } = await channelSnapshot(api, prefix, manifest, kind, key, allowIdentical ? { body, signature } : undefined);
    if (identical) return false;
    const jsonBlob = await api(`${prefix}/git/blobs`, { method: "POST", body: { content: body.toString("base64"), encoding: "base64" }, expected: [201] });
    const signatureBlob = await api(`${prefix}/git/blobs`, { method: "POST", body: { content: signature.toString("base64"), encoding: "base64" }, expected: [201] });
    const tree = await api(`${prefix}/git/trees`, {
      method: "POST", expected: [201], body: {
        ...(parent ? { base_tree: parent.tree.sha } : {}), tree: [
          { path: channelName, mode: "100644", type: "blob", sha: jsonBlob.sha },
          { path: `${channelName}.sig`, mode: "100644", type: "blob", sha: signatureBlob.sha }
        ]
      }
    });
    const commit = await api(`${prefix}/git/commits`, { method: "POST", expected: [201], body: { message: `release: ${manifest.tag} (${manifest.channel})`, tree: tree.sha, parents: ref ? [ref.object.sha] : [] } });
    try {
      if (ref) await api(`${prefix}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
      else await api(`${prefix}/git/refs`, { method: "POST", expected: [201], body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
      return true;
    } catch (error) { if (![409, 422].includes(error.status) || attempt === 2) throw error; }
  }
}
