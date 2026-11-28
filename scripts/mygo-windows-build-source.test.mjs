import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareWindowsBuildSource } from "./mygo-windows-build-source.mjs";

test("Windows packaging uses a private Go package, not transient resources in the checkout", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chordv-windows-source-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = path.join(root, "apps/desktop/native");
  const protocol = path.join(root, "packages/release-protocol");
  const staging = path.join(root, ".tmp", "build");
  const files = {
    "apps/desktop/native/go.mod": "replace example.test/shared => ../../../packages/release-protocol\n",
    "apps/desktop/native/main.go": "package main\n",
    "apps/desktop/native/resources/icon.png": "embed input",
    "apps/desktop/native/custom_windows_amd64.syso": "source-owned resource",
    "apps/desktop/native/mygo_windows_amd64.syso": "stale build resource",
    "apps/desktop/native/.mygo-build-config/old/mygo.json": "stale config",
    "packages/release-protocol/go.mod": "module example.test/shared\n"
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const privateNative = await prepareWindowsBuildSource(root, staging);
  assert.notEqual(privateNative, native);
  const privateProtocol = path.resolve(privateNative, "../../../packages/release-protocol");
  assert.notEqual(privateProtocol, protocol);
  assert.equal(await readFile(path.join(privateProtocol, "go.mod"), "utf8"), files["packages/release-protocol/go.mod"]);
  for (const name of ["go.mod", "main.go", "resources/icon.png", "custom_windows_amd64.syso"]) {
    assert.equal(await readFile(path.join(privateNative, name), "utf8"), files["apps/desktop/native/" + name]);
  }
  await assert.rejects(readFile(path.join(privateNative, "mygo_windows_amd64.syso")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(privateNative, ".mygo-build-config/old/mygo.json")), { code: "ENOENT" });
  await writeFile(path.join(privateNative, "mygo_windows_amd64.syso"), "private build resource");
  assert.equal(await readFile(path.join(native, "mygo_windows_amd64.syso"), "utf8"), files["apps/desktop/native/mygo_windows_amd64.syso"]);
});
