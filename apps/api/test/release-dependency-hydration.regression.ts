import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SystemUpdateService } from "../src/modules/common/system-update.service";

const root = path.resolve(__dirname, "../../..");
const DEPENDENCY_DIRS = ["node_modules", "packages/shared/node_modules", "apps/api/node_modules"];

// ---------------------------------------------------------------------------
// The published artifact must not carry node_modules, and must carry the lockfile
// the installer needs to prove the dependency graph is unchanged before reusing
// the running release's trees.
// ---------------------------------------------------------------------------
const workflow = readFileSync(path.join(root, ".github/workflows/release-backend.yml"), "utf8");
const tarCommand = workflow.match(/tar -czf "dist-release\/chordv-backend-\$\{VERSION\}\.tar\.gz" \\\n([\s\S]*?)\n {10}cd dist-release/);
assert.ok(tarCommand, "release workflow must still assemble the backend tarball");
const packedPaths = tarCommand[1]
  .split("\n")
  .flatMap((line) => line.replace(/\\$/, "").trim().split(/\s+/))
  .filter(Boolean);
assert.ok(packedPaths.length > 0, "tar entry list must be parseable");
for (const packed of packedPaths) {
  assert.ok(
    !packed.split("/").includes("node_modules"),
    `release tarball must ship no dependency tree, found ${packed}`
  );
}
for (const required of [
  "pnpm-lock.yaml",
  "SYSTEM_VERSION",
  "apps/api/dist",
  "apps/api/prisma",
  "apps/admin/dist",
  "packages/shared/dist"
]) {
  assert.ok(packedPaths.includes(required), `release tarball must still ship ${required}`);
}

// ---------------------------------------------------------------------------
// Wiring: hydration must run on the STAGING tree, after extraction and before the
// tree is renamed into place. Hydrating after the rename would publish a release
// directory that cannot start, and a failure would leave it there.
// ---------------------------------------------------------------------------
const serviceSource = readFileSync(
  path.join(root, "apps/api/src/modules/common/system-update.service.ts"),
  "utf8"
);
const extractBody = serviceSource.match(
  /await this\.extractTarball\(downloaded\.absolutePath, stagingDir\);([\s\S]*?)await fs\.rename\(stagingDir, finalDir\);/
);
assert.ok(extractBody, "downloadAndExtractRelease must still extract into a staging directory");
assert.match(
  extractBody[1],
  /await this\.hydrateRuntimeDependencies\(stagingDir\);/,
  "the staged release must be hydrated between extraction and promotion"
);

// ---------------------------------------------------------------------------
// Hydration behaviour.
// ---------------------------------------------------------------------------
function service(runningDir: string) {
  const instance = new SystemUpdateService({} as never, {} as never);
  // The real lookup walks up from __dirname to the running @chordv/api release,
  // which under test is this repository — pin it at the fixture instead.
  (instance as unknown as { resolveRunningReleaseDir: () => Promise<string> }).resolveRunningReleaseDir =
    async () => runningDir;
  return instance as unknown as { hydrateRuntimeDependencies(stagingDir: string): Promise<void> };
}

function makeRunningRelease(base: string, lockfile: string, name = "running") {
  const dir = path.join(base, name);
  mkdirSync(path.join(dir, "packages/shared"), { recursive: true });
  mkdirSync(path.join(dir, "apps/api"), { recursive: true });
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), lockfile);
  for (const relative of DEPENDENCY_DIRS) {
    mkdirSync(path.join(dir, relative, "left-pad"), { recursive: true });
    writeFileSync(path.join(dir, relative, "left-pad/index.js"), "module.exports = 1;\n");
  }
  // The workspace link pnpm creates: it must stay a RELATIVE symlink so it keeps
  // resolving inside whichever release tree it ends up in.
  mkdirSync(path.join(dir, "apps/api/node_modules/@chordv"), { recursive: true });
  symlinkSync("../../../../packages/shared", path.join(dir, "apps/api/node_modules/@chordv/shared"));
  return dir;
}

function makeStagedRelease(base: string, lockfile: string, name = "staging") {
  const dir = path.join(base, name);
  mkdirSync(path.join(dir, "packages/shared"), { recursive: true });
  mkdirSync(path.join(dir, "apps/api"), { recursive: true });
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), lockfile);
  return dir;
}

const LOCK = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
const OTHER_LOCK = `${LOCK}  # a dependency changed\n`;

async function main() {
const base = mkdtempSync(path.join(tmpdir(), "chordv-hydration-"));
try {
  // --- matching lockfile: the trees are rebuilt, cheaply and correctly ---
  {
    const running = makeRunningRelease(base, LOCK);
    const staging = makeStagedRelease(base, LOCK);
    await service(running).hydrateRuntimeDependencies(staging);

    for (const relative of DEPENDENCY_DIRS) {
      const hydrated = path.join(staging, relative, "left-pad/index.js");
      assert.ok(existsSync(hydrated), `${relative} must be rebuilt in the staged release`);
      // Hard links, not copies: same inode means no extra disk and no copy time.
      assert.equal(
        statSync(hydrated).ino,
        statSync(path.join(running, relative, "left-pad/index.js")).ino,
        `${relative} must be hard-linked from the running release`
      );
    }

    const link = path.join(staging, "apps/api/node_modules/@chordv/shared");
    assert.ok(lstatSync(link).isSymbolicLink(), "the workspace link must stay a symlink, not a copied directory");
    assert.equal(
      readlinkSync(link),
      "../../../../packages/shared",
      "the workspace link must stay relative so it resolves inside the NEW release"
    );
    assert.equal(
      path.resolve(path.dirname(link), readlinkSync(link)),
      path.join(staging, "packages/shared"),
      "the hydrated workspace link must point at the staged shared build, never the old one"
    );
  }

  // --- changed lockfile: fail CLOSED, leaving nothing behind ---
  {
    const running = makeRunningRelease(base, LOCK, "running-drifted");
    const staging = makeStagedRelease(base, OTHER_LOCK, "staging-drifted");
    await assert.rejects(
      () => service(running).hydrateRuntimeDependencies(staging),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException, "a dependency change must be a client-visible refusal");
        assert.match(String((error as Error).message), /pnpm-lock\.yaml/);
        return true;
      },
      "a release whose dependency graph changed must not reuse the running trees"
    );
    for (const relative of DEPENDENCY_DIRS) {
      assert.equal(
        existsSync(path.join(staging, relative)),
        false,
        `${relative} must not be half-built when the lockfile check fails`
      );
    }
  }

  // --- legacy fat tarball: left exactly as extracted, even across a lockfile change ---
  {
    const running = makeRunningRelease(base, LOCK, "running-legacy");
    const staging = makeStagedRelease(base, OTHER_LOCK, "staging-legacy");
    mkdirSync(path.join(staging, "node_modules/left-pad"), { recursive: true });
    writeFileSync(path.join(staging, "node_modules/left-pad/index.js"), "module.exports = 2;\n");
    await service(running).hydrateRuntimeDependencies(staging);
    assert.equal(
      readFileSync(path.join(staging, "node_modules/left-pad/index.js"), "utf8"),
      "module.exports = 2;\n",
      "an archive carrying its own dependencies must be left untouched, so rollback to it still works"
    );
  }

  // --- running release missing its trees: refuse rather than promote a broken tree ---
  {
    const running = makeRunningRelease(base, LOCK, "running-orphan");
    rmSync(path.join(running, "packages/shared/node_modules"), { recursive: true, force: true });
    const staging = makeStagedRelease(base, LOCK, "staging-orphan");
    await assert.rejects(
      () => service(running).hydrateRuntimeDependencies(staging),
      /缺少依赖目录/,
      "a running release without its dependency trees cannot hydrate an update"
    );
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
}

main().then(
  () => console.log("release-dependency-hydration.regression.ts passed"),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
