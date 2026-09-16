import { WINDOWS_UPDATER_PUBLIC_KEY } from "@chordv/shared";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { BadRequestException } from "@nestjs/common";
import { fetchPublicHttpUrl } from "./remote-url.utils";

export function normalizeUpdaterSignature(value?: string | null): string | null {
  const signature = value?.trim();
  if (!signature) return null;
  if (signature.length > 8192 || !/^[A-Za-z0-9+/=]+$/.test(signature) ||
      !Buffer.from(signature, "base64").toString("utf8").startsWith("untrusted comment:")) {
    throw new BadRequestException("更新签名格式无效，请选择此安装包对应的 .sig 文件。");
  }
  return signature;
}

/** Fetch the detached signature through the same SSRF/redirect policy as artifacts. */
export async function fetchUpdaterSignature(sourceUrl: string, signal: AbortSignal): Promise<string> {
  const url = new URL(sourceUrl);
  url.pathname += ".sig";
  const { response } = await fetchPublicHttpUrl(url.toString(), { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }, {
    requireHttps: true, errorPrefix: "更新签名"
  });
  if (response.status !== 200 || !response.body) throw new BadRequestException("未找到安装包对应的 .sig 签名，请先完成签名构建。");
  let text = "";
  for await (const chunk of response.body) {
    text += Buffer.from(chunk).toString("utf8");
    if (text.length > 8192) { throw new BadRequestException("更新签名文件过大。"); }
  }
  const signature = normalizeUpdaterSignature(text);
  if (!signature) throw new BadRequestException("更新签名文件为空。");
  return signature;
}

/** Verify the Tauri/Minisign envelope using Node's maintained Ed25519 and BLAKE2b
 * primitives. The client independently repeats verification in the official plugin. */
export async function verifyUpdaterSignature(file: string, signature: string | null | undefined, publicKey = WINDOWS_UPDATER_PUBLIC_KEY) {
  const normalized = normalizeUpdaterSignature(signature);
  if (!normalized) throw new BadRequestException("Windows 安装包缺少更新签名。");
  const keyLines = Buffer.from(publicKey, "base64").toString("utf8").trim().split(/\r?\n/);
  const sigLines = Buffer.from(normalized, "base64").toString("utf8").trim().split(/\r?\n/);
  const key = Buffer.from(keyLines[1] ?? "", "base64");
  const sig = Buffer.from(sigLines[1] ?? "", "base64");
  const globalSignature = Buffer.from(sigLines[3] ?? "", "base64");
  if (key.length !== 42 || key.subarray(0,2).toString() !== "Ed" || sig.length !== 74 || sig.subarray(0,2).toString() !== "ED" ||
      !key.subarray(2,10).equals(sig.subarray(2,10)) || !sigLines[2]?.startsWith("trusted comment: ") || globalSignature.length !== 64) {
    throw new BadRequestException("更新签名与发布密钥不匹配或格式无效。");
  }
  const digest = createHash("blake2b512");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const verifier = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]), format: "der", type: "spki" });
  const rawSignature = sig.subarray(10);
  const signedComment = Buffer.concat([rawSignature, Buffer.from(sigLines[2].slice(17), "utf8")]);
  if (!verify(null, digest.digest(), verifier, rawSignature) || !verify(null, signedComment, verifier, globalSignature)) {
    throw new BadRequestException("安装包签名校验失败，文件与 .sig 不匹配或文件已被修改。");
  }
}
