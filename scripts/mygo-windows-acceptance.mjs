import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyLegacySignature, legacyPublicKey } from "../.github/scripts/legacy-transition.mjs";
import { verifyDesktopBinary } from "../.github/scripts/desktop-build-info.mjs";
import { parseDesktopBuildID } from "./mygo-desktop-build-identity.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
export const legacySource = "397a64de9cc345049f886e64cc19f46d887f8304";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: project, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} inspection failed (${result.error?.code ?? result.status})`);
  return result.stdout;
}
export function lockedLegacyContract() {
  const source = (name) => execute("git", ["show", `${legacySource}:${name}`]);
  const config = JSON.parse(source("apps/desktop/src-tauri/tauri.conf.json"));
  const lock = source("apps/desktop/src-tauri/Cargo.lock");
  const hook = source("apps/desktop/src-tauri/windows/chordv-installer-hooks.nsh");
  if (config.productName !== "ChordV" || config.mainBinaryName !== "ChordV" || config.identifier !== "app.chordv.desktop"
    || config.plugins.updater.pubkey !== legacyPublicKey || config.plugins.updater.windows.installMode !== "passive"
    || !lock.includes('name = "tauri-plugin-updater"\nversion = "2.11.0"')
    || !lock.includes('checksum = "b28d8cabdeb0564f03ae261963de4bc3d98321cd3d213e76a81b7d344e5df606"')
    || !hook.includes("Local\\ChordV.Update.InProgress")) throw new Error("Locked legacy installer contract differs from 397a64d");
  // Tauri CLI v2.10.1 windows/nsis/mod.rs:269-271 and installer.nsi:59-60.
  const manufacturer = config.bundle.publisher ?? config.identifier.split(".")[1] ?? config.identifier;
  return { source: legacySource, version: config.version, product: config.productName, identifier: config.identifier, manufacturer,
    manufacturerRegistryKey: `Software\\${manufacturer}\\${config.productName}`, updater: "2.11.0", mode: "passive", publicKeySHA256: digest(Buffer.from(legacyPublicKey)), hookSHA256: digest(Buffer.from(hook)) };
}
export function acceptanceManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || Object.keys(manifest).sort().join(",") !== "current,legacy,schemaVersion") throw new Error("Acceptance input manifest must use the fixed schema, not self-declared verification or expected hashes");
  const names = [];
  for (const [key, fields] of [["legacy", ["installer", "signature"]], ["current", ["installer", "binary"]]]) {
    if (!manifest[key] || Object.keys(manifest[key]).sort().join(",") !== [...fields].sort().join(",")) throw new Error("Unexpected acceptance input identity fields");
    for (const field of fields) {
      const name = manifest[key][field];
      if (typeof name !== "string" || !/^[\w.-]+$/.test(name) || name === "." || name === "..") throw new Error("Acceptance inputs must be simple filenames inside the supplied directory");
      names.push(name);
    }
  }
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new Error("Acceptance input filenames must be distinct");
  return manifest;
}
export async function peIdentity(file, machine = 0x8664) {
  const info = await lstat(file);
  if (!info.isFile() || info.size < 88 || info.size > 256 * 1024 * 1024) throw new Error("Expected a nonempty ordinary PE input, not a link");
  const bytes = await readFile(file), offset = bytes.readUInt32LE(60);
  if (bytes.toString("ascii", 0, 2) !== "MZ" || offset < 64 || offset + 24 > bytes.length
    || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== machine) throw new Error("Actual PE architecture/header mismatch");
  return { file: path.resolve(file), sha256: digest(bytes), sizeBytes: bytes.length, machine };
}

// This is an input inspection tool, not a publisher or an installation result.
// No caller-supplied hash or public key can make a substitute installer valid.
export async function inspectAcceptanceContents(directory, output, sevenZip) {
  if (typeof sevenZip !== "string" || !path.isAbsolute(sevenZip) || !(await lstat(sevenZip)).isFile()) throw new Error("Content inspection requires an absolute ordinary 7-Zip executable");
  await access(sevenZip, constants.X_OK);
  directory = path.resolve(directory);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Input directory cannot be a link");
  const manifest = acceptanceManifest(JSON.parse(await readFile(path.join(directory, "inputs.json"), "utf8")));
  const contract = lockedLegacyContract();
  const oldFile = path.join(directory, manifest.legacy.installer), newFile = path.join(directory, manifest.current.installer), binary = path.join(directory, manifest.current.binary);
  const signatureFile = path.join(directory, manifest.legacy.signature);
  if (!(await lstat(signatureFile)).isFile()) throw new Error("Legacy signature must be a regular public .sig file");
  await verifyLegacySignature(oldFile, (await readFile(signatureFile, "utf8")).trim());
  const legacyInstaller = await peIdentity(oldFile, 0x14c), currentInstaller = await peIdentity(newFile, 0x14c);
  const identity = parseDesktopBuildID(execute("go", ["tool", "buildid", binary]).trim());
  const commit = execute("git", ["rev-parse", "HEAD"]).trim();
  const versions = JSON.parse(await readFile(path.join(project, "apps/desktop/config/platform-versions.json"), "utf8"));
  if (identity.platform !== "windows" || identity.architecture !== "x64" || identity.mode !== "local" || identity.commit !== commit
    || identity.version !== versions.windows || identity.build < 1) throw new Error("QA requires an actual current-source x64 local-content build identity with a positive build; production-mode apps are not launched here");
  await verifyDesktopBinary(binary, identity);
  const modules = execute("go", ["version", "-m", binary]);
  if (!modules.includes("\tdep\tgithub.com/egoist/mygo\tv0.9.1\t")) throw new Error("Actual MyGo dependency identity mismatch");
  await mkdir(output);
  const payloads = {};
  for (const [name, installer] of [["legacy", oldFile], ["current", newFile]]) {
    const bytes = execute(sevenZip, ["x", "-so", "--", installer, "ChordV.exe"], { encoding: null, maxBuffer: 256 * 1024 * 1024 });
    const target = path.join(output, `${name}-payload.exe`);
    await writeFile(target, bytes, { flag: "wx" });
    payloads[name] = await peIdentity(target);
  }
  const currentBinary = await peIdentity(binary);
  if (payloads.current.sha256 !== currentBinary.sha256) throw new Error("Current NSIS does not contain the actual supplied ChordV application");
  const report = { schemaVersion: 1, purpose: "content-inspection-only", legacyContract: contract, currentIdentity: identity,
    legacyInstaller, currentInstaller, currentBinary, payloads, signatureStatus: "valid-pinned-legacy-key", windowsRuntimeExecuted: false, runtimePreflightAccepted: false, productionTransitionEnabled: false };
  await writeFile(path.join(output, "inputs-report.json"), JSON.stringify(report, null, 2));
  return report;
}

export async function inspectAcceptanceInputs(directory, output) {
  if (process.platform !== "win32") throw new Error("Full installer input inspection requires Windows and preinstalled 7-Zip");
  const sevenZip = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe");
  return inspectAcceptanceContents(directory, output, sevenZip);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/mygo-windows-acceptance.mjs INPUT_DIRECTORY NEW_OUTPUT_DIRECTORY");
    await inspectAcceptanceInputs(process.argv[2], process.argv[3]);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
