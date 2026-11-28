import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { goBinaryMetadata } from "../../scripts/agent-release-assets.mjs";
import { parseDesktopBuildID } from "../../scripts/mygo-desktop-build-identity.mjs";
import { verifyMacRecoverySigning } from "../../scripts/mygo-macos-recovery-signing.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`Desktop package verification failed: ${basename(command)} (${result.error?.message || result.status})`);
  return result.stdout;
}
async function regularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || !info.size) throw new Error("Desktop artifact must be a nonempty regular file, not a link");
}
export function assertDesktopIdentity(actual, expected) {
  for (const field of ["version", "build", "mode", "platform", "architecture", "commit"]) if (actual[field] !== expected[field]) throw new Error(`Desktop package ${field} mismatch`);
  return actual;
}
export async function verifyDesktopBinary(file, expected) {
  await regularFile(file);
  const actual = parseDesktopBuildID(run("go", ["tool", "buildid", file]).trim());
  assertDesktopIdentity(actual, expected);
  const { packagePath, settings } = goBinaryMetadata(file);
  if (packagePath !== "github.com/Achordchan/ChordV/apps/desktop/native" || settings.get("GOOS") !== ({ macos: "darwin", windows: "windows" })[expected.platform]
      || settings.get("GOARCH") !== (expected.architecture === "x64" ? "amd64" : "arm64") || settings.get("CGO_ENABLED") !== "0") throw new Error("Actual desktop Go package/platform/architecture mismatch");
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(64); await handle.read(header, 0, header.length, 0);
    if (expected.platform === "macos") {
      if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== (expected.architecture === "x64" ? 0x01000007 : 0x0100000c)) throw new Error("Actual Mach-O architecture mismatch");
    } else {
      const offset = header.readUInt32LE(60), pe = Buffer.alloc(24);
      if (header.toString("ascii", 0, 2) !== "MZ" || offset < 64 || offset > 16 * 1024 * 1024) throw new Error("Invalid desktop PE header");
      await handle.read(pe, 0, pe.length, offset);
      if (pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== (expected.architecture === "x64" ? 0x8664 : 0xaa64)) throw new Error("Actual PE architecture mismatch");
    }
  } finally { await handle.close(); }
  return actual;
}
function inspectMacSignature(app) {
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const signature = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", app], { encoding: "utf8", timeout: 30_000 });
  const cdHash = signature.stderr?.match(/^CDHash=([a-f0-9]{40})$/m)?.[1];
  if (signature.status !== 0 || !cdHash) throw new Error("Cannot inspect actual app signing identity");
  const authority = signature.stderr.match(/^Authority=(.+)$/m)?.[1] ?? null;
  return { cdHash, authority, developerID: authority?.startsWith("Developer ID Application:") ?? false };
}

export async function inspectMacInstaller(file, source, expected) {
  if (process.platform !== "darwin") throw new Error("macOS package inspection requires the macOS staging runner");
  const name = expected.mode === "local" ? "ChordV MyGo Local" : "ChordV";
  const identifier = expected.mode === "local" ? "app.chordv.mygo.local" : "app.chordv.desktop";
  const binary = app => join(app, "Contents/MacOS", name);
  await regularFile(file);
  const temporary = await mkdtemp(join(tmpdir(), "chordv-dmg-verify-")), mount = join(temporary, "mount");
  await mkdir(mount);
  let mounted = false;
  try {
    run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, file]);
    mounted = true;
    const apps = (await readdir(mount)).filter(name => name.endsWith(".app"));
    if (apps.length !== 1 || apps[0] !== `${name}.app` || !(await lstat(join(mount, apps[0]))).isDirectory()) throw new Error("Installer must contain exactly one regular application bundle");
    const app = join(mount, apps[0]), plist = join(app, "Contents/Info.plist");
    for (const relative of ["Contents", "Contents/MacOS"]) if (!(await lstat(join(app, relative))).isDirectory()) throw new Error("DMG application paths cannot traverse symlink directories");
    await regularFile(plist);
    const info = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]));
    if (info.CFBundleIdentifier !== identifier || info.CFBundleExecutable !== name || info.CFBundleShortVersionString !== expected.version
        || info.CFBundleVersion !== expected.version) throw new Error("Actual DMG bundle identifier/version mismatch");
    assertDesktopIdentity({ ...info.ChordVBuildInfo, commit: expected.commit }, expected);
    const identity = await verifyDesktopBinary(binary(app), expected);
    await verifyDesktopBinary(binary(source), expected);
    const actual = inspectMacSignature(app), built = inspectMacSignature(source);
    if (actual.cdHash !== built.cdHash || !((await readFile(binary(app))).equals(await readFile(binary(source))))) {
      throw new Error("DMG application differs from the actual sealed build output");
    }
    if (expected.mode === "release" && process.env.CHORDV_MACOS_RECOVERY_PROVISIONING_PROFILE) {
      await verifyMacRecoverySigning(app, source, process.env.CHORDV_MACOS_RECOVERY_PROVISIONING_PROFILE, actual.authority);
    }
    return { identity, ...actual };
  } finally {
    if (mounted) {
      try { run("/usr/bin/hdiutil", ["detach", mount]); }
      catch { run("/usr/bin/hdiutil", ["detach", "-force", mount]); }
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

function authenticode(file) {
  const command = "$s=Get-AuthenticodeSignature -LiteralPath $env:CHORDV_VERIFY_FILE; if($s.Status -ne 'Valid' -or !$s.SignerCertificate){exit 2}; $s.SignerCertificate.Thumbprint";
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env: { ...process.env, CHORDV_VERIFY_FILE: file } }).trim();
}
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export async function inspectWindowsPayload(directory, source, expected) {
  const extracted = join(directory, expected.mode === "local" ? "ChordV MyGo Local.exe" : "ChordV.exe");
  const identity = await verifyDesktopBinary(extracted, expected);
  await verifyDesktopBinary(source, expected);
  if (digest(await readFile(extracted)) !== digest(await readFile(source))) throw new Error("Installer payload differs from the actual application output");
  return identity;
}

// Do not let archive-supplied paths reach the filesystem.
export async function extractWindowsPayload(sevenZip, installer, temporary, mode) {
  await regularFile(sevenZip);
  await regularFile(installer);
  const name = mode === "local" ? "ChordV MyGo Local.exe" : "ChordV.exe";
  const bytes = run(sevenZip, ["x", "-so", "--", resolve(installer), name], { encoding: null, maxBuffer: 256 * 1024 * 1024 });
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("Installer is missing its fixed application payload");
  const file = join(temporary, name);
  await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  return file;
}
export async function verifyDesktopInstaller(file, directory, expected) {
  if (expected.mode !== "release") throw new Error("Only release-mode desktop packages may be staged");
  if (expected.platform === "macos") {
    const result = await inspectMacInstaller(file, join(directory, "ChordV.app"), expected);
    if (!result.developerID || (process.env.CHORDV_MACOS_SIGNING_IDENTITY && result.authority !== process.env.CHORDV_MACOS_SIGNING_IDENTITY)) throw new Error("Formal desktop staging requires the configured Developer ID Application signature");
    run("xcrun", ["stapler", "validate", file]);
    return result.identity;
  }
  if (process.platform !== "win32") throw new Error("Windows installer inspection requires the Windows staging runner");
  await regularFile(file);
  const signer = authenticode(file), source = join(directory, "ChordV.exe");
  if (authenticode(source) !== signer) throw new Error("Installer and application signing identities differ");
  const sevenZip = join(process.env.ProgramFiles || "C:\\Program Files", "7-Zip/7z.exe");
  const temporary = await mkdtemp(join(tmpdir(), "chordv-nsis-verify-"));
  try {
    const target = await extractWindowsPayload(sevenZip, file, temporary, expected.mode);
    if (authenticode(target) !== signer) throw new Error("Extracted application signing identity differs");
    return await inspectWindowsPayload(temporary, source, expected);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
