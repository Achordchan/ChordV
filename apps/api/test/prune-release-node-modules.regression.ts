import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/prune-release-node-modules.mjs");

/**
 * Build a minimal but structurally faithful pnpm workspace: a .pnpm store whose
 * dependency links are RELATIVE symlinks placed as siblings inside each entry
 * (scoped packages nested one level deeper — exactly the shape that once broke
 * the closure walk), per-package node_modules, a workspace link and .bin stubs.
 *
 *   apps/api deps: @nestjs/core, @prisma/client
 *   @nestjs/core → rxjs, reflect-metadata (transitive, resolved via entry siblings)
 *   shared deps:  rxjs
 *   extra root:   prisma → @prisma/engines → @prisma/debug (scoped chain)
 *   dropped:      typescript (dev-only; linked at root AND in apps/api)
 */
function buildFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "chordv-prune-"));
  const entryModules = (entry: string) => path.join(root, "node_modules", ".pnpm", entry, "node_modules");
  const storeEntry = (entry: string, pkgPath: string, manifest: Record<string, unknown>) => {
    const dir = path.join(entryModules(entry), pkgPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
    return dir;
  };
  const link = (from: string, to: string) => {
    mkdirSync(path.dirname(from), { recursive: true });
    symlinkSync(path.relative(path.dirname(from), to), from);
  };
  // A dependency of the package stored in `entry`, linked as a sibling.
  const depLink = (entry: string, name: string, targetDir: string) =>
    link(path.join(entryModules(entry), ...name.split("/")), targetDir);

  const nestCore = storeEntry("nest-core@1.0.0", "@nestjs/core", {
    dependencies: { rxjs: "7.0.0", "reflect-metadata": "0.2.0" }
  });
  const rxjs = storeEntry("rxjs@7.0.0", "rxjs", {});
  const reflect = storeEntry("reflect-metadata@0.2.0", "reflect-metadata", {});
  const typescript = storeEntry("typescript@5.0.0", "typescript", {});
  const prisma = storeEntry("prisma@6.0.0", "prisma", { dependencies: { "@prisma/engines": "6.0.0" } });
  const engines = storeEntry("@prisma+engines@6.0.0", "@prisma/engines", { dependencies: { "@prisma/debug": "6.0.0" } });
  const debug = storeEntry("@prisma+debug@6.0.0", "@prisma/debug", {});
  const client = storeEntry("@prisma+client@6.0.0", "@prisma/client", {});

  depLink("nest-core@1.0.0", "rxjs", rxjs);
  depLink("nest-core@1.0.0", "reflect-metadata", reflect);
  depLink("prisma@6.0.0", "@prisma/engines", engines);
  depLink("@prisma+engines@6.0.0", "@prisma/debug", debug);

  const clientRuntime = path.join(client, "runtime");
  mkdirSync(clientRuntime, { recursive: true });
  for (const file of [
    "query_engine_bg.postgresql.wasm-base64.js",
    "query_engine_bg.mysql.wasm-base64.js",
    "query_compiler_bg.cockroachdb.wasm-base64.mjs",
    "query_compiler_bg.postgresql.wasm-base64.mjs"
  ]) {
    writeFileSync(path.join(clientRuntime, file), "stub");
  }

  // Workspace package manifests.
  mkdirSync(path.join(root, "apps", "api"), { recursive: true });
  mkdirSync(path.join(root, "packages", "shared"), { recursive: true });
  writeFileSync(
    path.join(root, "apps", "api", "package.json"),
    JSON.stringify({ name: "@chordv/api", dependencies: { "@nestjs/core": "1.0.0", "@prisma/client": "6.0.0" } })
  );
  writeFileSync(
    path.join(root, "packages", "shared", "package.json"),
    JSON.stringify({ name: "@chordv/shared", dependencies: { rxjs: "7.0.0" } })
  );

  // Per-package node_modules: app deps, the workspace link and a .bin stub.
  const apiModules = path.join(root, "apps", "api", "node_modules");
  link(path.join(apiModules, "@nestjs", "core"), nestCore);
  link(path.join(apiModules, "@prisma", "client"), client);
  link(path.join(apiModules, "rxjs"), rxjs);
  link(path.join(apiModules, "typescript"), typescript);
  link(path.join(apiModules, "@chordv", "shared"), path.join(root, "packages", "shared"));
  mkdirSync(path.join(apiModules, ".bin"), { recursive: true });
  writeFileSync(path.join(apiModules, ".bin", "prisma"), "#!/bin/sh\n");

  // Shared's own dependency link.
  link(path.join(root, "packages", "shared", "node_modules", "rxjs"), rxjs);

  // Root-level links (the root package's own devDeps): one kept, one dropped.
  const rootModules = path.join(root, "node_modules");
  link(path.join(rootModules, "typescript"), typescript);
  link(path.join(rootModules, "prisma"), prisma);

  return root;
}

async function main() {
  const { pruneReleaseNodeModules } = await import(pathToFileURL(helperPath).href);
  const root = buildFixture();
  try {
    const result = pruneReleaseNodeModules(root, { extraPackages: ["prisma"] });

    const store = path.join(root, "node_modules", ".pnpm");
    const kept = (entry: string) => existsSync(path.join(store, entry));
    // Runtime closure: app deps, transitives (via entry siblings), shared dep,
    // and the CLI chain through two scoped levels.
    assert.equal(kept("nest-core@1.0.0"), true, "app dependency must be kept");
    assert.equal(kept("rxjs@7.0.0"), true, "transitive dependency must be kept");
    assert.equal(kept("reflect-metadata@0.2.0"), true, "transitive dependency must be kept");
    assert.equal(kept("@prisma+client@6.0.0"), true, "prisma client must be kept");
    assert.equal(kept("prisma@6.0.0"), true, "prisma CLI (migrate) must be kept");
    assert.equal(kept("@prisma+engines@6.0.0"), true, "scoped dependency of prisma must be kept");
    assert.equal(kept("@prisma+debug@6.0.0"), true, "scoped dependency of @prisma/engines must be kept");
    // Build-only tooling must go — the store entry AND every link pointing at it.
    assert.equal(kept("typescript@5.0.0"), false, "dev-only store entry must be dropped");
    assert.equal(existsSync(path.join(root, "node_modules", "typescript")), false, "dangling root link must be dropped");
    assert.equal(existsSync(path.join(root, "apps", "api", "node_modules", "typescript")), false, "dangling app link must be dropped");
    // Workspace link and .bin stubs survive so `pnpm exec` keeps working.
    assert.equal(existsSync(path.join(root, "apps", "api", "node_modules", "@chordv", "shared")), true, "workspace link must survive");
    assert.equal(existsSync(path.join(root, "apps", "api", "node_modules", ".bin", "prisma")), true, ".bin stubs must survive");
    // Non-postgresql wasm engines are trimmed; postgresql ones stay.
    const runtime = path.join(store, "@prisma+client@6.0.0", "node_modules", "@prisma", "client", "runtime");
    assert.equal(existsSync(path.join(runtime, "query_engine_bg.postgresql.wasm-base64.js")), true, "postgresql engine wasm must stay");
    assert.equal(existsSync(path.join(runtime, "query_engine_bg.mysql.wasm-base64.js")), false, "other dialects must be trimmed");
    assert.equal(existsSync(path.join(runtime, "query_compiler_bg.postgresql.wasm-base64.mjs")), true, "postgresql compiler wasm must stay");
    assert.equal(existsSync(path.join(runtime, "query_compiler_bg.cockroachdb.wasm-base64.mjs")), false, "other dialects must be trimmed");

    assert.ok(result.keptEntries >= 7, "closure must keep the runtime packages");
    assert.ok(result.droppedEntries >= 1, "at least typescript must be dropped");
    assert.equal(result.trimmedEngines, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("prune-release-node-modules.regression.ts passed");
}

void main();
