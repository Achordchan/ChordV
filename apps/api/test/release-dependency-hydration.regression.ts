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
// Packaging. Slim artifacts are opt-in and default OFF: an installer older than
// hydrateRuntimeDependencies extracts and promotes an archive verbatim, so handed
// a slim one it would run a tree with no node_modules, fail the health gate and
// roll back — leaving that deployment unable to update remotely at all.
// ---------------------------------------------------------------------------
const workflow = readFileSync(path.join(root, ".github/workflows/release-backend.yml"), "utf8");

const slimInput = workflow.match(/ {6}slim_artifact:\n([\s\S]*?)\n {4}\w|slim_artifact:\n([\s\S]*?)\n\nconcurrency/);
assert.ok(slimInput, "the workflow must expose slim packaging as an explicit input");
assert.match(
  workflow,
  /slim_artifact:[\s\S]*?default: false/,
  "slim packaging must default OFF so a release cannot silently strand old installers"
);

const common = workflow.match(/COMMON="([\s\S]*?)"\n/);
assert.ok(common, "the shared tar entry list must be parseable");
const commonPaths = common[1].split(/\s+/).filter(Boolean);
for (const required of [
  "pnpm-lock.yaml",
  "SYSTEM_VERSION",
  "apps/api/dist",
  "apps/api/prisma",
  "apps/admin/dist",
  "packages/shared/dist"
]) {
  assert.ok(commonPaths.includes(required), `every artifact must ship ${required}`);
}
// pnpm-lock.yaml is not optional: it is the only evidence the installer has that
// borrowing the running release's dependency trees is sound.
assert.ok(commonPaths.includes("pnpm-lock.yaml"), "the lockfile gate needs the lockfile in every artifact");
for (const shared of commonPaths) {
  assert.ok(
    !shared.split("/").includes("node_modules"),
    `dependency trees belong only in the fat branch, found ${shared} in the shared list`
  );
}

const slimBranch = workflow.match(/if \[ "\$SLIM" = "true" \]; then([\s\S]*?)\n {10}else/);
const fatBranch = workflow.match(/\n {10}else([\s\S]*?)\n {10}fi/);
assert.ok(slimBranch && fatBranch, "packaging must branch on the slim input");
const withoutComments = (script: string) =>
  script.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
assert.doesNotMatch(
  withoutComments(slimBranch[1]),
  /node_modules/,
  "the slim artifact must carry no dependency tree"
);
assert.match(
  fatBranch[1],
  /node_modules packages\/shared\/node_modules apps\/api\/node_modules/,
  "the fat artifact must keep shipping all three trees for old installers"
);
assert.match(
  fatBranch[1],
  /prune-release-node-modules\.mjs/,
  "the fat artifact must stay pruned, or compatibility packaging regresses to ~149MB"
);

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
// A Prisma schema change leaves pnpm-lock.yaml byte identical, so the digest gate
// cannot see it. The borrowed trees would then serve a client generated for the
// PREVIOUS schema to code compiled against the new one.
// ---------------------------------------------------------------------------
const serviceText = readFileSync(
  path.join(root, "apps/api/src/modules/common/system-update.service.ts"),
  "utf8"
);
const hydrateBody = serviceText.match(
  /private async hydrateRuntimeDependencies\(stagingDir: string\): Promise<void> \{([\s\S]*?)\n {2}\}/
);
assert.ok(hydrateBody, "hydrateRuntimeDependencies must still exist");
assert.match(
  hydrateBody[1],
  /await this\.regeneratePrismaClient\(stagingDir\);/,
  "hydration must regenerate the Prisma client for the schema THIS release ships"
);
const regenerateBody = serviceText.match(
  /private async regeneratePrismaClient\(stagingDir: string\): Promise<void> \{([\s\S]*?)\n {2}\}/
);
assert.ok(regenerateBody, "regeneratePrismaClient must still exist");
const removalIndex = regenerateBody[1].indexOf("await this.removeDirSafe(generated)");
const generateIndex = regenerateBody[1].indexOf('"prisma", "generate"');
assert.ok(removalIndex > -1, "the stale generated client must be removed, not overwritten");
assert.ok(generateIndex > -1, "the client must actually be regenerated");
assert.ok(
  removalIndex < generateIndex,
  "removal must precede generation: the hard links share inodes with the RUNNING release, " +
    "so generating over them would rewrite the client the live process has loaded"
);
// Deletion must stay scoped to generated output. The prisma CLI package keeps its
// own engine copies next to it, outside any .prisma directory — that is what makes
// regeneration work with no network, so nothing may widen this to the package dir.
for (const removal of regenerateBody[1].matchAll(/removeDirSafe\(([^)]*)\)/g)) {
  assert.equal(
    removal[1].trim(),
    "generated",
    "regeneration may only delete generated .prisma output, never a package directory"
  );
}
assert.ok(
  regenerateBody[1].indexOf("listGeneratedEngines") < removalIndex,
  "the engine inventory must be taken BEFORE the output is discarded, or there is nothing to compare against"
);

// ---------------------------------------------------------------------------
// Hydration behaviour.
// ---------------------------------------------------------------------------
function service(runningDir: string) {
  const instance = new SystemUpdateService({} as never, {} as never);
  const internals = instance as unknown as {
    resolveRunningReleaseDir: () => Promise<string>;
    regeneratePrismaClient: (stagingDir: string) => Promise<void>;
    hydrateRuntimeDependencies(stagingDir: string): Promise<void>;
  };
  // The real lookup walks up from __dirname to the running @chordv/api release,
  // which under test is this repository — pin it at the fixture instead.
  internals.resolveRunningReleaseDir = async () => runningDir;
  // Regeneration shells out to the prisma CLI; the fixtures have no real workspace.
  // Record the calls so the wiring is still asserted.
  const regenerated: string[] = [];
  internals.regeneratePrismaClient = async (stagingDir: string) => {
    regenerated.push(stagingDir);
  };
  return { instance: internals, regenerated };
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

/**
 * Regeneration must reproduce every query engine the discarded output held. The
 * schema declares three binaryTargets while @prisma/engines ships only the install
 * platform's, so the generated directory is the sole copy of the others inside a
 * running release; producing fewer would leave a release that cannot open a
 * connection on some hosts. Drive the real verification with a stubbed generator.
 */
function regenerationHarness(base: string, name: string, produce: string[]) {
  const staging = path.join(base, name);
  const generated = path.join(
    staging,
    "node_modules/.pnpm/@prisma+client@6.19.2/node_modules/.prisma/client"
  );
  mkdirSync(generated, { recursive: true });
  for (const engine of ["libquery_engine-debian-openssl-3.0.x.so.node", "query_engine_bg.wasm"]) {
    writeFileSync(path.join(generated, engine), "engine");
  }
  const instance = new SystemUpdateService({} as never, {} as never);
  (instance as unknown as { runShell: (...args: unknown[]) => Promise<void> }).runShell = async () => {
    mkdirSync(generated, { recursive: true });
    for (const engine of produce) writeFileSync(path.join(generated, engine), "engine");
  };
  return {
    run: () =>
      (instance as unknown as { regeneratePrismaClient(dir: string): Promise<void> }).regeneratePrismaClient(
        staging
      ),
    generated
  };
}

async function main() {
const base = mkdtempSync(path.join(tmpdir(), "chordv-hydration-"));
try {
  // --- matching lockfile: the trees are rebuilt, cheaply and correctly ---
  {
    const running = makeRunningRelease(base, LOCK);
    const staging = makeStagedRelease(base, LOCK);
    const hydrated = service(running);
    await hydrated.instance.hydrateRuntimeDependencies(staging);
    assert.deepEqual(hydrated.regenerated, [staging], "the staged tree must get a freshly generated Prisma client");

    for (const relative of DEPENDENCY_DIRS) {
      const file = path.join(staging, relative, "left-pad/index.js");
      assert.ok(existsSync(file), `${relative} must be rebuilt in the staged release`);
      // Hard links, not copies: same inode means no extra disk and no copy time.
      assert.equal(
        statSync(file).ino,
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
      () => service(running).instance.hydrateRuntimeDependencies(staging),
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
    const legacy = service(running);
    await legacy.instance.hydrateRuntimeDependencies(staging);
    assert.deepEqual(legacy.regenerated, [], "a fat archive already carries a client generated for its own schema");
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
      () => service(running).instance.hydrateRuntimeDependencies(staging),
      /缺少依赖目录/,
      "a running release without its dependency trees cannot hydrate an update"
    );
  }
  // --- regeneration reproduces every engine the old output carried ---
  {
    const harness = regenerationHarness(base, "regen-ok", [
      "libquery_engine-debian-openssl-3.0.x.so.node",
      "query_engine_bg.wasm"
    ]);
    await harness.run();
    assert.ok(
      existsSync(path.join(harness.generated, "libquery_engine-debian-openssl-3.0.x.so.node")),
      "a complete regeneration must be accepted"
    );
  }

  // --- an engine went missing: refuse rather than promote a release that cannot connect ---
  {
    const harness = regenerationHarness(base, "regen-short", ["query_engine_bg.wasm"]);
    await assert.rejects(
      () => harness.run(),
      /缺少查询引擎[\s\S]*libquery_engine-debian-openssl-3\.0\.x\.so\.node/,
      "a regeneration that drops a query engine must fail the update, naming what is missing"
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
