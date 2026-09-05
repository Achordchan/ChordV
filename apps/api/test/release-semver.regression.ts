import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BadRequestException } from "@nestjs/common";
import { compareSemver, normalizeVersion } from "../src/modules/common/release-center.utils";

const preciseIntegers = [
  ["9007199254740992", "9007199254740993"],
  ["999999999999999999998", "999999999999999999999"],
  ["9".repeat(400), `1${"0".repeat(400)}`]
];
const hugePairs = preciseIntegers.flatMap(([lower, higher]) => [
  [`${lower}.0.0`, `${higher}.0.0`],
  [`1.${lower}.0`, `1.${higher}.0`],
  [`1.0.${lower}`, `1.0.${higher}`],
  [`1.0.0-rc.${lower}`, `1.0.0-rc.${higher}`]
]);
const ordered = [
  "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
  "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"
];
const identifierPairs = [
  ["1.0.0-999999999999999999999", "1.0.0--"], // Numeric identifiers precede all nonnumeric identifiers.
  ["1.0.0-A", "1.0.0-a"], // ASCII ordering is case-sensitive.
  ["1.0.0-a-", "1.0.0-a0"],
  ["1.0.0-alpha10", "1.0.0-alpha2"], // Mixed identifiers compare lexically, not naturally.
  ["1.0.0-rc.1", "1.0.0-rc.1.0"],
  ["1.0.0-rc.9", "1.0.0-rc.10"],
  ["1.0.0-rc.999999999999999999999", "1.0.0"]
];

function assertLower(left: string, right: string) {
  assert.equal(compareSemver(left, right), -1, `${left} < ${right}`);
  assert.equal(compareSemver(right, left), 1, `${right} > ${left}`);
}

test("core and numeric prerelease ordering remains exact beyond safe integers and Number overflow", () => {
  for (const [left, right] of hugePairs) {
    assert.equal(normalizeVersion(left), left);
    assert.equal(normalizeVersion(right), right);
    assertLower(left, right);
    assert.equal(compareSemver(left, left), 0);
    assert.equal(compareSemver(right, right), 0);
  }
  assertLower("9007199254740992.99.99", "9007199254740993.0.0-alpha");
  assertLower("1.9007199254740992.99", "1.9007199254740993.0-alpha");
});

test("SemVer precedence uses individual numeric/ASCII identifiers and stable releases", () => {
  for (let index = 1; index < ordered.length; index += 1) {
    assertLower(ordered[index - 1], ordered[index]);
  }
  for (const [left, right] of identifierPairs) assertLower(left, right);
  assert.deepEqual([...ordered].reverse().sort(compareSemver), ordered);
});

test("shared runtime comparator preserves normalization, ignored metadata and numeric return values", () => {
  for (const [left, right] of [
    [" v1.2.3 ", "V1.2.3+build.123"],
    ["1.2.3-rc.1+old", "1.2.3-rc.1+new"],
    ["1.2.3-01", "1.2.3-1"] // Preserve legacy runtime input acceptance; release publication is stricter.
  ]) {
    assert.equal(compareSemver(left, right), 0);
    assert.equal(compareSemver(right, left), 0);
  }
  for (const [left, right] of hugePairs) {
    const order = compareSemver(left, right);
    assert.equal(typeof order, "number");
    assert.ok(Number.isFinite(order));
  }
});

test("malformed runtime versions still throw BadRequestException for either operand", () => {
  for (const invalid of ["", "garbage", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-a..b", "1.2.3+"]) {
    assert.throws(() => compareSemver(invalid, "1.0.0"), BadRequestException);
    assert.throws(() => compareSemver("1.0.0", invalid), BadRequestException);
  }
});

test("runtime ordering matches the release publication helper for valid SemVer", async () => {
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/backend-release-resume.mjs");
  const { compareSemver: compareReleaseSemver } = await import(pathToFileURL(helperPath).href);
  const versions = [...new Set([
    ...ordered, ...hugePairs.flat(), ...identifierPairs.flat(),
    "0.0.0", "1.0.0+build.1", "1.0.0+build.2", "1.0.0-rc.1+old", "1.0.0-rc.1+new"
  ])];
  for (const left of versions) {
    for (const right of versions) {
      assert.equal(compareSemver(left, right), compareReleaseSemver(left, right), `${left} vs ${right}`);
    }
  }
});
