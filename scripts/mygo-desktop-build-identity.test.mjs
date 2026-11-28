import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBuildID, parseDesktopBuildID } from "./mygo-desktop-build-identity.mjs";

const identity = { version: "2.0.0-beta.1", build: 18, mode: "release", platform: "macos", architecture: "arm64", commit: "a".repeat(40) };
test("desktop linker build identity is canonical and includes the exact target and source commit", () => {
  assert.deepEqual(parseDesktopBuildID(desktopBuildID(identity)), identity);
  for (const change of [{ build: 0 }, { commit: "dirty" }, { mode: "debug" }, { architecture: "universal" }]) assert.throws(() => desktopBuildID({ ...identity, ...change }));
  assert.throws(() => parseDesktopBuildID("not-a-ChordV-build"));
  assert.throws(() => parseDesktopBuildID(`chordv1:${Buffer.from(JSON.stringify({ ...identity, invented: true })).toString("base64url")}`));
});
