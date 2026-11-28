import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadLockedAsset } from "../.github/scripts/release-artifacts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const linuxTestLockPath = path.join(root, ".github/scripts/fixtures/linux-runtime-test-lock.json");
export const runtimeLockPath = path.join(root, ".github/runtime-components.lock.json");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function selectLinuxRuntimeAssets(architecture, linux, runtime) {
  if (!["x64", "arm64"].includes(architecture)) throw new Error("Linux test architecture must be x64 or arm64");
  if (linux?.schemaVersion !== 1 || linux.purpose !== "linux-native-integration-only" || !Array.isArray(linux.assets)
      || linux.assets.length !== 2 || new Set(linux.assets.map(asset => asset.architecture)).size !== 2
      || linux.assets.some(asset => !["x64", "arm64"].includes(asset.architecture))) throw new Error("Invalid Linux integration-only source lock");
  if (runtime?.schemaVersion !== 1 || !Array.isArray(runtime.assets)) throw new Error("Invalid production runtime source lock");
  const versions = new Set(runtime.assets.filter(asset => asset.component === "xray").map(asset => asset.version));
  if (versions.size !== 1) throw new Error("Production Xray versions differ");
  for (const asset of linux.assets) {
    const upstreamName = asset.architecture === "x64" ? "Xray-linux-64.zip" : "Xray-linux-arm64-v8a.zip";
    if (asset.component !== "xray" || asset.version !== [...versions][0] || !/^v\d+\.\d+\.\d+$/.test(asset.version)
        || asset.fileName !== `xray-${asset.version}-linux-${asset.architecture}.zip`
        || asset.sourceUrl !== `https://github.com/XTLS/Xray-core/releases/download/${asset.version}/${upstreamName}`
        || asset.sourceFormat !== "zip_entry" || asset.archiveEntryName !== "xray") throw new Error("Linux Xray test lock differs from the production version or fixed upstream identity");
  }
  const assets = { xray: linux.assets.find(asset => asset.architecture === architecture) };
  for (const component of ["geoip", "geosite"]) {
    const found = runtime.assets.filter(asset => asset.component === component);
    if (found.length !== 1 || found[0].sourceFormat !== "direct") throw new Error(`Expected one locked production ${component} source`);
    assets[component] = found[0];
  }
  for (const asset of Object.values(assets)) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0
        || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(asset.fileName) || asset.fileName.includes("..")) throw new Error("Linux fixture source requires a safe filename, SHA256 and length");
  }
  return assets;
}

export function assertLinuxELF(bytes, architecture) {
  const machine = { x64: 62, arm64: 183 }[architecture];
  if (!machine || bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
      || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 || ![2, 3].includes(bytes.readUInt16LE(16))
      || bytes.readUInt16LE(18) !== machine || bytes.readUInt32LE(20) !== 1 || bytes.readUInt16LE(52) !== 64) throw new Error("Extracted test Xray is not the requested 64-bit Linux ELF");
}

export const requiredLinuxIntegrationTests = [
  "TestLinuxDconfCustomProfileMatchesSession", "TestLinuxDconfTakeoverAndRestore", "TestLinuxDconfWatchdogEOF",
  "TestLinuxDconfWatchdogParentSIGKILL", "TestLinuxDconfWatchdogForeignChangePreserved",
  "TestLinuxDconfRecoveryNeverCrossesProfileNamespace", "TestLinuxDconfRealXrayTrafficAndCrashRecovery",
  "TestLinuxDconfRealXrayParentSIGKILL", "TestLinuxDconfDefaultGIOProxyDiscovery", "TestGNOMEActualGSettingsIsolatedKeyfile"
];

export function assertLinuxIntegrationEvidence(jsonLines) {
  const records = jsonLines.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  const pkg = "github.com/Achordchan/ChordV/apps/desktop/native";
  const actions = records.filter(record => record.Package === pkg);
  if (!actions.length || actions.some(record => ["fail", "skip"].includes(record.Action))
      || !actions.some(record => record.Action === "pass" && !record.Test)) throw new Error("Linux integration log failed, skipped, or did not finish its native package");
  for (const name of requiredLinuxIntegrationTests) {
    if (!actions.some(record => record.Action === "pass" && record.Test === name)) throw new Error(`Missing actual passing Linux integration test: ${name}`);
  }
  return { requiredTestsPassed: requiredLinuxIntegrationTests.length, skipped: 0 };
}

export async function prepareLinuxRuntimeFixtures({ architecture, output, fetchImpl = fetch }) {
  const assets = selectLinuxRuntimeAssets(architecture, JSON.parse(await readFile(linuxTestLockPath)), JSON.parse(await readFile(runtimeLockPath)));
  output = path.resolve(output);
  // Refuse existing paths before any cleanup ownership is acquired.
  await mkdir(output, { mode: 0o700 });
  try {
    const cache = path.join(output, "downloads"), target = path.join(output, "assets");
    await mkdir(target, { mode: 0o700 });
    for (const asset of Object.values(assets)) await downloadLockedAsset(asset, cache, fetchImpl);
    const extracted = spawnSync("unzip", ["-p", path.join(cache, assets.xray.fileName), "xray"], { timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
    if (extracted.error || extracted.status !== 0) throw new Error("Verified Linux test archive extraction failed");
    assertLinuxELF(extracted.stdout, architecture);
    await writeFile(path.join(target, "xray"), extracted.stdout, { mode: 0o700, flag: "wx" });
    for (const component of ["geoip", "geosite"]) {
      const file = path.join(target, `${component}.dat`);
      await copyFile(path.join(cache, assets[component].fileName), file);
      await chmod(file, 0o600);
    }
    const report = { purpose: "linux-native-integration-only", architecture, assetsDirectory: target,
      sources: assets, binarySHA256: sha256(extracted.stdout), binaryBytes: extracted.stdout.length,
      runtimeExecuted: false, productionTargetsChanged: false };
    await writeFile(path.join(output, "fixture-report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    return report;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === "--verify-test-log") {
      console.info(JSON.stringify(assertLinuxIntegrationEvidence(await readFile(args[1], "utf8"))));
    } else {
      if (args.length !== 4 || args[0] !== "--arch" || args[2] !== "--output" || !args[3]) throw new Error("Usage: node scripts/mygo-linux-runtime-fixtures.mjs --arch x64|arm64 --output NEW_DIRECTORY");
      const report = await prepareLinuxRuntimeFixtures({ architecture: args[1], output: args[3] });
      console.info(JSON.stringify(report));
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
