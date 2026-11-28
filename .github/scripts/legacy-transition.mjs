import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const legacyPublicKey = (await readFile(fileURLToPath(new URL("../../apps/server/internal/api/assets/legacy-tauri-public-key.txt", import.meta.url)), "utf8")).trim();

// This is the old maintained Node crypto contract: Minisign ED signatures sign
// BLAKE2b-512, and the independent global signature authenticates the comment.
export async function verifyLegacySignature(file, signature, publicKey = legacyPublicKey) {
  if (typeof signature !== "string" || signature.length > 8192 || !/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error("Missing valid legacy Minisign envelope");
  const keys = Buffer.from(publicKey, "base64").toString("utf8").trim().split(/\r?\n/);
  const lines = Buffer.from(signature, "base64").toString("utf8").trim().split(/\r?\n/);
  const key = Buffer.from(keys[1] || "", "base64"), packet = Buffer.from(lines[1] || "", "base64"), global = Buffer.from(lines[3] || "", "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed" || packet.length !== 74 || packet.subarray(0, 2).toString() !== "ED"
      || !packet.subarray(2, 10).equals(key.subarray(2, 10)) || !lines[0]?.startsWith("untrusted comment:") || !lines[2]?.startsWith("trusted comment: ") || global.length !== 64) throw new Error("Legacy signature does not match the pinned Tauri key or format");
  const verifier = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]), format: "der", type: "spki" });
  const digest = createHash("blake2b512");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const raw = packet.subarray(10);
  if (!verify(null, digest.digest(), verifier, raw) || !verify(null, Buffer.concat([raw, Buffer.from(lines[2].slice(17))]), verifier, global)) throw new Error("Legacy Minisign payload or trusted comment verification failed");
}

export function assertLegacyTransitionReleaseEnabled() {
  throw new Error("Legacy automatic transition is blocked until independent Windows installer semantics acceptance; signing keys or manifest fields cannot unlock it");
}

export async function stageLegacyTransition({ directory, platform, architecture }) {
  if (platform !== "windows" || architecture !== "x64") throw new Error("The released legacy official updater only supports Windows x64 NSIS");
  await unlink(join(directory, "legacy-windows-x64.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
  return { enabled: false, reason: "Windows legacy installer semantics have not been accepted; automatic transition remains disabled" };
}

export async function verifyLegacyEntry(directory, entry, installer) {
  if (!installer || entry.format !== "tauri-nsis-v1" || entry.platform !== "windows" || entry.architecture !== "x64"
      || ["fileName", "sha256", "sizeBytes"].some(field => installer[field] !== entry[field]) || JSON.stringify(installer.buildInfo) !== JSON.stringify(entry.buildInfo)) throw new Error("Legacy transition must reference the exact verified MyGo Windows x64 installer");
  await verifyLegacySignature(join(directory, entry.fileName), entry.signature);
  return entry;
}
export async function legacyTransitions(directory) {
  try { await readFile(join(directory, "legacy-windows-x64.json"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  assertLegacyTransitionReleaseEnabled();
}
