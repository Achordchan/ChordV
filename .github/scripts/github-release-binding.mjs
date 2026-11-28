import { createHash } from "node:crypto";
import { assertTagSource } from "./github-release-client.mjs";
import { assertBindingDeclaration, canonicalPublicRepository } from "./release-binding-schema.mjs";
import { verifyManifestSignature } from "./github-release-contract.mjs";

function object(value) {
  if (!value || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.sha ?? "")) throw new Error("Invalid metadata Git object identity");
  return value;
}
function blobID(bytes, length) { return createHash(length === 40 ? "sha1" : "sha256").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex"); }
export async function verifyTagBinding(api, context, { required = true } = {}) {
  const { manifest, repository, body, signature, pinnedPublicKey, name } = context;
  if (!assertBindingDeclaration(manifest, repository)) {
    await assertTagSource(api, `/repos/${repository}`, manifest, { required });
    return manifest.sourceCommit;
  }
  if (!body.length || body.length > 1024 * 1024 || !signature.length || signature.length > 1024) throw new Error("Metadata manifest/signature exceeds protocol size limit");
  verifyManifestSignature(body, signature.toString("utf8"), pinnedPublicKey);
  const prefix = `/repos/${canonicalPublicRepository(repository)}/git/`;
  const ref = await api(`${prefix}ref/tags/${encodeURIComponent(manifest.tag)}`, { expected: [200, 404], maxBytes: 64 * 1024 });
  if (!ref) { if (required) throw new Error("Metadata release tag is missing"); return null; }
  let current = object(ref.object); const seen = new Set();
  while (current.type === "tag") {
    if (seen.has(current.sha) || seen.size >= 10) throw new Error("Metadata annotated tag cycle/depth"); seen.add(current.sha);
    const tag = await api(`${prefix}tags/${current.sha}`, { maxBytes: 64 * 1024 }); if (tag.sha !== current.sha) throw new Error("Metadata tag identity mismatch"); current = object(tag.object);
  }
  if (current.type !== "commit") throw new Error("Metadata tag does not resolve to a commit");
  const commit = await api(`${prefix}commits/${current.sha}`, { maxBytes: 64 * 1024 });
  if (commit.sha !== current.sha || !Array.isArray(commit.parents) || commit.parents.length !== 0) throw new Error("Metadata commit must have exactly zero parents");
  const treeSHA = object(commit.tree).sha, tree = await api(`${prefix}trees/${treeSHA}`, { maxBytes: 64 * 1024 });
  if (tree.sha !== treeSHA || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length !== 2) throw new Error("Metadata tree must contain exactly two complete regular blobs");
  const expected = new Map([[name, body], [`${name}.sig`, signature]]), paths = new Set();
  for (const entry of tree.tree) {
    const bytes = expected.get(entry.path);
    if (!bytes || paths.has(entry.path) || entry.type !== "blob" || entry.mode !== "100644") throw new Error("Metadata tree contains extra, duplicate or nonregular files"); paths.add(entry.path);
    const sha = object(entry).sha, blob = await api(`${prefix}blobs/${sha}`, { maxBytes: 2 * 1024 * 1024 });
    if (blob.sha !== sha || blob.encoding !== "base64" || blob.size !== bytes.length || typeof blob.content !== "string") throw new Error("Metadata blob identity/length mismatch");
    const actual = Buffer.from(blob.content, "base64");
    if (!actual.equals(bytes) || blobID(actual, sha.length) !== sha) throw new Error("Metadata manifest/raw signature original bytes mismatch");
  }
  return current.sha;
}
export async function ensureTagProjection(api, context) {
  if (!assertBindingDeclaration(context.manifest, context.repository)) return verifyTagBinding(api, context, { required: false });
  const existing = await verifyTagBinding(api, context, { required: false }); if (existing) return existing;
  const prefix = `/repos/${canonicalPublicRepository(context.repository)}/git/`;
  const entries = [];
  for (const [path, bytes] of [[context.name, context.body], [`${context.name}.sig`, context.signature]]) {
    const blob = await api(`${prefix}blobs`, { method: "POST", expected: [201], body: { content: bytes.toString("base64"), encoding: "base64" } });
    object(blob); if (blobID(bytes, blob.sha.length) !== blob.sha) throw new Error("Created metadata blob identity mismatch");
    entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const tree = object(await api(`${prefix}trees`, { method: "POST", expected: [201], body: { tree: entries } }));
  const commit = object(await api(`${prefix}commits`, { method: "POST", expected: [201], body: { tree: tree.sha, parents: [], message: `release metadata: ${context.manifest.tag}` } }));
  try {
    await api(`${prefix}refs`, { method: "POST", expected: [201], body: { ref: `refs/tags/${context.manifest.tag}`, sha: commit.sha } });
  } catch (error) { if (![409, 422].includes(error.status)) throw error; }
  return verifyTagBinding(api, context);
}
