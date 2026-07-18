import assert from "node:assert/strict";
import { normalizeSha256Hex } from "../src/lib/checksum.ts";

function mapExpectedHash(item: { expectedHash?: string | null }) {
  return {
    checksumSha256: normalizeSha256Hex(item.expectedHash)
  };
}

assert.equal(mapExpectedHash({ expectedHash: "A" + "b".repeat(63) }).checksumSha256, "a" + "b".repeat(63));
assert.equal(mapExpectedHash({ expectedHash: null }).checksumSha256, null);
assert.equal(mapExpectedHash({ expectedHash: "too-short" }).checksumSha256, null);
assert.equal(normalizeSha256Hex("  " + "c".repeat(64).toUpperCase() + "  "), "c".repeat(64));
console.log("runtime-plan-hash.regression.ts passed");
