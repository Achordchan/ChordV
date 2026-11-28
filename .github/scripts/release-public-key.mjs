import { createPublicKey } from "node:crypto";

const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

export function releasePublicKey(value) {
  const text = (value ?? "").replaceAll("\\n", "\n").trim();
  const pem = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PUBLIC KEY-----$/.exec(text);
  const encoded = (pem?.[1] ?? text).replace(/[\r\n]/g, "");
  const bytes = Buffer.from(encoded, "base64");
  const der = !pem && bytes.length === 32 ? Buffer.concat([spkiPrefix, bytes]) : bytes;
  if (bytes.toString("base64") !== encoded || der.length !== spkiPrefix.length + 32 || !der.subarray(0, spkiPrefix.length).equals(spkiPrefix)) {
    throw new Error("发布验签配置只接受 Ed25519 公钥（raw32、SPKI DER 或 PUBLIC KEY PEM）");
  }
  return createPublicKey({ key: der, format: "der", type: "spki" });
}
