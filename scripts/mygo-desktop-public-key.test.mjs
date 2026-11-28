import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { releasePublicKey } from "../.github/scripts/release-public-key.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./mygo-desktop.mjs", import.meta.url));
const keys = generateKeyPairSync("ed25519");
const der = keys.publicKey.export({ type: "spki", format: "der" });
const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const inputs = [der.toString("base64"), der.subarray(-32).toString("base64"), pem, pem.replaceAll("\n", "\\n")];

test("正式构建将raw32、DER和PEM统一成同一Ed25519 SPKI公钥", () => {
  const body = Buffer.from("offline-build-key-test"), signature = sign(null, body, keys.privateKey);
  for (const input of inputs) {
    const normalized = releasePublicKey(input).export({ type: "spki", format: "der" }).toString("base64");
    assert.equal(normalized, der.toString("base64"));
    assert.equal(verify(null, body, createPublicKey({ key: Buffer.from(normalized, "base64"), format: "der", type: "spki" }), signature), true);
  }
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
  for (const invalid of ["", Buffer.alloc(31).toString("base64"), rsa, privatePem, pem + privatePem,
    Buffer.concat([der, Buffer.from([0])]).toString("base64"), inputs[0] + "!"]) {
    assert.throws(() => releasePublicKey(invalid), /Ed25519/);
  }
});

test("真实发布参数通过公钥校验后在缺少签名证书处停止，不构建或外联", () => {
  for (const input of inputs) {
    const result = spawnSync(process.execPath, [script, "--release", "--build-only", "--platform", "windows", "--arch", "x64"], {
      encoding: "utf8", timeout: 5000,
      env: {
        ...process.env,
        CHORDV_BUILD_NUMBER: "17", CHORDV_RELEASE_API_BASE_URL: "https://release-build.local.test",
        VITE_GITHUB_RELEASE_REPOSITORY: "fixture/releases", VITE_GITHUB_RELEASE_PUBLIC_KEY: input,
        CHORDV_WINDOWS_CERTIFICATE: "", MYGO_WINDOWS_CERTIFICATE_PASSWORD: ""
      }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /正式 Windows 构建需要代码签名证书及密码配置/);
    assert.doesNotMatch(result.stdout, /go tool|构建完成|Published|http:/);
    assert.doesNotMatch(result.stderr, /BEGIN PUBLIC KEY|MCowBQYDK2VwAyEA/);
  }
});

test("正式构建在签名检查前拒绝发布协议不接受的仓库", () => {
  for (const repository of ["owner/..", "bad_owner/releases"]) {
    const result = spawnSync(process.execPath, [script, "--release", "--build-only", "--platform", "windows", "--arch", "x64"], {
      encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH, CHORDV_BUILD_NUMBER: "17", CHORDV_RELEASE_API_BASE_URL: "https://release-build.local.test",
        VITE_GITHUB_RELEASE_REPOSITORY: repository, VITE_GITHUB_RELEASE_PUBLIC_KEY: inputs[0] }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid tag binding public repository/);
  }
});
