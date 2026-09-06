#!/usr/bin/env node
/**
 * Prune a built ChordV workspace tree down to what the RUNNING backend needs.
 *
 * The release tarball ships the pnpm workspace layout so the app boots and
 * migrates inside the container without any install step. Unpruned, that means
 * the whole monorepo store: admin's react/tabler/mantine/vite toolchain, the
 * turbo orchestrator, node-agent's better-sqlite3, typescript, every database
 * dialect's wasm engine... ~590MB unpacked for ~7MB of application code.
 *
 * This walks the RUNTIME closure instead: everything reachable from
 * apps/api's `dependencies`, plus `prisma` (the container runs
 * `pnpm --filter @chordv/api exec prisma migrate deploy` via
 * scripts/prisma-migrate-with-baseline.mjs), plus packages/shared's
 * `dependencies`, resolved through pnpm's symlink layout. Anything else in
 * node_modules/.pnpm is deleted. Workspace links (@chordv/shared), .bin stubs
 * and pnpm state files are kept so `pnpm exec` keeps working.
 *
 * It also trims @prisma/client/runtime to the postgresql wasm engines: the
 * native library engine is what production uses, and no other dialect is ever
 * configured.
 *
 * Run from the repo root (or pass the root): node scripts/prune-release-node-modules.mjs
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runtime roots beyond apps/api's dependencies. `prisma` is a devDependency of
// apps/api but the release tree must run migrations, so its CLI travels with
// every release. Add sparingly: every entry here ships to all instances.
const RUNTIME_EXTRA_PACKAGES = ["prisma"];

// Only this dialect's wasm engines survive the prune (the datasource in
// apps/api/prisma/schema.prisma is postgresql; the library engine is native).
const PRISMA_KEEP_DIALECTS = new Set(["postgresql"]);

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isScoped(name) {
  return name.startsWith("@") && name.includes("/");
}

/** Resolve a package name to its real directory from a set of base dirs, or null. */
function resolvePackageDir(name, baseDirs) {
  const segments = isScoped(name) ? name.split("/") : [name];
  for (const base of baseDirs) {
    const candidate = join(base, "node_modules", ...segments);
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        return { dir: realpathSync(candidate), link: candidate };
      }
      if (stat.isDirectory()) {
        return { dir: candidate, link: candidate };
      }
    } catch {
      // not present in this base — try the next
    }
  }
  return null;
}

/** The .pnpm store entry ("name@version_peerhash") containing a resolved dir, or null. */
function pnpmEntryFor(realDir, storeDir) {
  const rel = relative(storeDir, realDir);
  if (rel.startsWith("..") || !rel.includes("node_modules")) return null;
  const entry = rel.split(/[/\\]/)[0];
  return entry && entry !== "node_modules" ? entry : null;
}

export function pruneReleaseNodeModules(root, options = {}) {
  const extraPackages = options.extraPackages ?? RUNTIME_EXTRA_PACKAGES;
  root = resolve(root);
  const storeDir = realpathSync(join(root, "node_modules", ".pnpm"));
  if (!relative(realpathSync(root), storeDir).startsWith("node_modules")) {
    throw new Error(`no pnpm store at ${storeDir}; run from the built workspace root`);
  }

  const apiDir = join(root, "apps", "api");
  const sharedDir = join(root, "packages", "shared");
  const apiPackage = readJsonIfExists(join(apiDir, "package.json"));
  const sharedPackage = readJsonIfExists(join(sharedDir, "package.json"));
  if (!apiPackage || !sharedPackage) {
    throw new Error("apps/api/package.json and packages/shared/package.json are required");
  }

  const rootNames = [
    ...Object.keys(apiPackage.dependencies ?? {}),
    ...Object.keys(sharedPackage.dependencies ?? {}),
    ...extraPackages
  ];

  // name@version entries in .pnpm that the runtime closure reaches.
  const keepEntries = new Set();
  // Resolved package dirs whose package.json still needs reading.
  const pending = [];
  const seen = new Set();

  for (const name of rootNames) {
    const resolved = resolvePackageDir(name, [apiDir, sharedDir, root]);
    if (resolved && !seen.has(resolved.dir)) {
      seen.add(resolved.dir);
      pending.push(resolved.dir);
    }
  }

  while (pending.length > 0) {
    const pkgDir = pending.pop();
    const entry = pnpmEntryFor(pkgDir, storeDir);
    if (entry) keepEntries.add(entry);
    // pnpm places a package's dependencies as SIBLING symlinks inside the same
    // .pnpm entry's node_modules dir — exactly where Node's own directory walkup
    // finds them. Scoped packages nest one level deeper (@scope/name), so derive
    // the entry dir from the store entry name instead of the package path depth.
    const depBases = entry ? [join(storeDir, entry)] : [dirname(pkgDir)];
    const manifest = readJsonIfExists(join(pkgDir, "package.json"));
    if (!manifest) continue;
    const depNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {})
    ];
    for (const depName of depNames) {
      const resolved = resolvePackageDir(depName, [...depBases, apiDir, sharedDir, root]);
      if (!resolved || seen.has(resolved.dir)) continue;
      seen.add(resolved.dir);
      pending.push(resolved.dir);
    }
  }

  // Drop every store entry the closure never reached.
  let droppedEntries = 0;
  for (const entry of readdirSync(storeDir)) {
    if (entry === "lock.yaml" || keepEntries.has(entry)) continue;
    const entryPath = join(storeDir, entry);
    if (statSync(entryPath).isDirectory()) {
      rmSync(entryPath, { recursive: true, force: true });
      droppedEntries += 1;
    }
  }

  // Drop links in each consumed node_modules that now point into removed
  // entries. Workspace links (target outside the store) and .bin stubs stay.
  const linkRoots = [join(root, "node_modules"), join(apiDir, "node_modules"), join(sharedDir, "node_modules")];
  let droppedLinks = 0;
  for (const linkRoot of linkRoots) {
    if (!existsSync(linkRoot)) continue;
    for (const item of readdirSync(linkRoot)) {
      if (item.startsWith(".")) continue; // .pnpm, .bin, .modules.yaml …
      const paths = item.startsWith("@")
        ? readdirSync(join(linkRoot, item)).map((child) => join(linkRoot, item, child))
        : [join(linkRoot, item)];
      for (const linkPath of paths) {
        let stat;
        try {
          stat = lstatSync(linkPath);
        } catch {
          continue;
        }
        if (!stat.isSymbolicLink()) continue;
        let target;
        try {
          target = realpathSync(linkPath);
        } catch {
          // Dangling link: its store entry was already dropped (or arrived
          // dangling), so nothing resolves through it any more.
          rmSync(linkPath, { force: true });
          droppedLinks += 1;
          continue;
        }
        const entry = pnpmEntryFor(target, storeDir);
        // Workspace link (target outside the store) → keep. Store link whose
        // entry was pruned → remove so nothing dangles.
        if (entry !== null && !keepEntries.has(entry)) {
          rmSync(linkPath, { force: true });
          droppedLinks += 1;
        }
      }
    }
  }

  // Trim the client's wasm engines to the configured dialect. The native
  // library engine drives production; the wasm files only exist as a fallback
  // for setups we never run, one per database dialect (~66MB total).
  let trimmedEngines = 0;
  for (const entry of keepEntries) {
    if (!entry.startsWith("@prisma+client@")) continue;
    const runtimeDir = join(storeDir, entry, "node_modules", "@prisma", "client", "runtime");
    if (!existsSync(runtimeDir)) continue;
    for (const file of readdirSync(runtimeDir)) {
      const match = /^query_(?:engine|compiler)_bg\.([a-z0-9]+)\.wasm-base64\.(js|mjs)$/.exec(file);
      if (match && !PRISMA_KEEP_DIALECTS.has(match[1])) {
        rmSync(join(runtimeDir, file), { force: true });
        trimmedEngines += 1;
      }
    }
  }

  return {
    keptEntries: keepEntries.size,
    droppedEntries,
    droppedLinks,
    trimmedEngines
  };
}

function directorySize(path) {
  const result = spawnSync("du", ["-sm", path], { encoding: "utf8" });
  const parsed = Number.parseInt((result.stdout ?? "").split("\t")[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const before = directorySize(join(root, "node_modules"));
  const result = pruneReleaseNodeModules(root);
  const after = directorySize(join(root, "node_modules"));
  const report = [
    `kept ${result.keptEntries} store entries`,
    `dropped ${result.droppedEntries} entries + ${result.droppedLinks} dangling links`,
    `trimmed ${result.trimmedEngines} non-postgresql wasm engines`
  ];
  if (before !== null && after !== null) {
    report.push(`node_modules: ${before}MB -> ${after}MB`);
  }
  console.log(report.join("; "));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
