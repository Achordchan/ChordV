import { spawn } from "node:child_process";
import { releaseAPIOrigin } from "../.github/scripts/release-api-origin.mjs";
import { canonicalPublicRepository } from "../.github/scripts/release-binding-schema.mjs";
import { releasePublicKey } from "../.github/scripts/release-public-key.mjs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT, loadLocalEnvironment } from "./mygo-local-config.mjs";
import { withMacBuildInfo } from "./mygo-desktop-metadata.mjs";
import { desktopBuildID } from "./mygo-desktop-build-identity.mjs";
import { prepareMacRecoverySigning } from "./mygo-macos-recovery-signing.mjs";
import { writeWindowsInstallerInclude } from "./mygo-windows-installer.mjs";
import { prepareWindowsNSIS } from "./mygo-windows-nsis.mjs";
import { prepareWindowsBuildSource } from "./mygo-windows-build-source.mjs";
import { sourceCommit } from "../.github/scripts/server-build-info.mjs";

const args = process.argv.slice(2);
const options = { buildOnly: false, dev: false, release: false, check: false, e2e: false, windowsInstallerQA: false, skipInstaller: false, skipDmg: false, platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform, arch: process.arch === "x64" ? "x64" : process.arch };
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  const flag = { "--build-only": "buildOnly", "--dev": "dev", "--release": "release", "--check": "check", "--e2e": "e2e", "--windows-installer-qa": "windowsInstallerQA", "--skip-installer": "skipInstaller", "--skip-dmg": "skipDmg" }[arg];
  if (flag) options[flag] = true;
  else if (["--platform", "--arch"].includes(arg) && args[index + 1]) options[arg.slice(2)] = args[++index];
  else throw new Error(`不支持的参数：${arg}`);
}
const goOS = { macos: "darwin", windows: "windows", linux: "linux" }[options.platform];
const goArch = { x64: "amd64", arm64: "arm64" }[options.arch];
if (!goOS || !goArch) throw new Error("不支持的桌面平台或架构");
if (options.windowsInstallerQA && (goOS !== "windows" || goArch !== "amd64" || !options.buildOnly || options.release || options.dev || options.check || options.e2e || options.skipInstaller || options.skipDmg)) {
  throw new Error("Windows 安装验收仅支持 --build-only --platform windows --arch x64，不能与发行、启动或跳过打包参数混用");
}
if (options.release && (!options.buildOnly || options.dev || options.e2e || options.skipInstaller || options.skipDmg)) {
  throw new Error("正式构建必须使用 --release --build-only，不允许跳过安装包或公证步骤");
}
const recoveryProfile = process.env.CHORDV_MACOS_RECOVERY_PROVISIONING_PROFILE;
if (recoveryProfile && (!options.release || options.check || goOS !== "darwin" || process.platform !== "darwin")) {
  throw new Error("受保护更新的 provisioning profile 仅适用于 macOS 正式安装包构建");
}
const windowsCompatibility = goOS === "windows" && (options.release || options.windowsInstallerQA);
const nativeDir = path.join(PROJECT_ROOT, "apps/desktop/native");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = { ...process.env, CGO_ENABLED: "0", CHORDV_BUILD_MODE: options.release ? "release" : "local" };
if (options.e2e) {
  env.GOFLAGS = "-tags=e2e";
  env.MYGO_INSPECTOR = "1";
  env.MYGO_AUTOMATION ||= process.platform === "win32"
    ? path.join(process.env.TEMP ?? PROJECT_ROOT, `chordv-mygo-${process.pid}.sock`)
    : `/tmp/chordv-mygo-${process.pid}.sock`;
} else {
  delete env.GOFLAGS;
  delete env.MYGO_INSPECTOR;
  delete env.MYGO_AUTOMATION;
}
const children = new Set();
let interrupted = false;
const stopChildren = () => {
  interrupted = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stopChildren);
function run(command, commandArgs, cwd = nativeDir, extraEnv = {}) {
  if (interrupted) throw new Error("构建已取消");
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, env: { ...env, ...extraEnv }, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" && command.endsWith(".cmd"), detached: process.platform !== "win32" });
    children.add(child);
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${command} 执行失败（${code}）`));
    });
  });
}

let configDir;
try {
  if (options.check) {
    await run("go", ["version"]);
    await run("go", ["tool", "mygo", "version"]);
    await run(pnpm, ["--version"], PROJECT_ROOT);
    process.stdout.write("MyGo 构建工具检查通过；未启动客户端、数据库或修改系统代理。\n");
  } else {
    const started = performance.now();
    let config = JSON.parse(await readFile(path.join(nativeDir, "mygo.json"), "utf8"));
    const versions = JSON.parse(await readFile(path.join(PROJECT_ROOT, "apps/desktop/config/platform-versions.json"), "utf8"));
    config.version = versions[options.platform] ?? config.version;
    const buildNumber = Number(process.env.CHORDV_BUILD_NUMBER ?? process.env.VITE_APP_BUILD_NUMBER ?? 0);
    if (!Number.isSafeInteger(buildNumber) || buildNumber < 0 || (options.release && buildNumber === 0)) throw new Error("构建号必须是正整数，正式构建必须显式提供 CHORDV_BUILD_NUMBER");
    if (options.windowsInstallerQA && buildNumber === 0) throw new Error("Windows 安装验收必须使用正整数构建号");
    if (goOS === "darwin") config = withMacBuildInfo(config, { build: buildNumber, release: options.release, architecture: options.arch });
    if (buildNumber > 0) env.VITE_APP_BUILD_NUMBER = String(buildNumber);
    if (options.release || options.windowsInstallerQA) {
      config.name = "ChordV";
      config.slug = options.windowsInstallerQA ? "chordv-installer-qa" : "chordv";
      config.identifier = "app.chordv.desktop";
      config.windows = { ...config.windows, installDirName: "ChordV" };
    }
    if (options.release) {
      const apiOrigin = releaseAPIOrigin(process.env.CHORDV_RELEASE_API_BASE_URL ?? process.env.VITE_API_BASE_URL);
      const repository = process.env.VITE_GITHUB_RELEASE_REPOSITORY ?? "";
      canonicalPublicRepository(repository);
      const key = releasePublicKey(process.env.VITE_GITHUB_RELEASE_PUBLIC_KEY);
      const publicKey = key.export({ format: "der", type: "spki" }).toString("base64");
      env.VITE_API_BASE_URL = apiOrigin;
      env.VITE_GITHUB_RELEASE_REPOSITORY = repository;
      env.VITE_GITHUB_RELEASE_PUBLIC_KEY = publicKey;
      env.MYGO_LDFLAGS = `-X main.buildMode=release -X main.defaultAPIBase=${apiOrigin} -X main.embeddedReleaseRepository=${repository} -X main.embeddedReleasePublicKey=${publicKey} -X main.embeddedBuildNumber=${buildNumber}`;
      if (goOS === "darwin") {
        if (!process.env.CHORDV_MACOS_SIGNING_IDENTITY?.startsWith("Developer ID Application:") || !process.env.CHORDV_MACOS_NOTARY_PROFILE) throw new Error("正式 macOS 构建需要 Developer ID 签名及公证配置");
        config.macos = {
          ...config.macos,
          signingIdentity: process.env.CHORDV_MACOS_SIGNING_IDENTITY,
          notarize: {
            keychainProfile: process.env.CHORDV_MACOS_NOTARY_PROFILE,
            ...(process.env.CHORDV_MACOS_NOTARY_KEYCHAIN ? { keychain: process.env.CHORDV_MACOS_NOTARY_KEYCHAIN } : {})
          }
        };
      }
      if (goOS === "windows") {
        if (!process.env.CHORDV_WINDOWS_CERTIFICATE || !process.env.MYGO_WINDOWS_CERTIFICATE_PASSWORD) throw new Error("正式 Windows 构建需要代码签名证书及密码配置");
        config.windows.certificate = process.env.CHORDV_WINDOWS_CERTIFICATE;
      }
    } else {
      Object.assign(env, await loadLocalEnvironment());
      env.MYGO_LDFLAGS = `-X main.embeddedBuildNumber=${buildNumber}`;
      if (options.windowsInstallerQA) {
        delete config.windows.certificate;
        delete config.windows.signCommand;
        delete env.MYGO_WINDOWS_CERTIFICATE_PASSWORD;
        env.VITE_GITHUB_RELEASE_REPOSITORY = "";
        env.VITE_GITHUB_RELEASE_PUBLIC_KEY = "";
      }
      env.CHORDV_GITHUB_RELEASE_REPOSITORY = env.VITE_GITHUB_RELEASE_REPOSITORY ?? "";
      env.CHORDV_GITHUB_RELEASE_PUBLIC_KEY = env.VITE_GITHUB_RELEASE_PUBLIC_KEY ?? "";
    }
    env.MYGO_LDFLAGS += ` -buildid=${desktopBuildID({ version: config.version, build: buildNumber, mode: options.release ? "release" : "local", platform: options.platform, architecture: options.arch, commit: sourceCommit() })}`;
    if (recoveryProfile) {
      const temporaryRoot = path.join(nativeDir, ".mygo-build-config");
      await mkdir(temporaryRoot, { recursive: true });
      configDir = await mkdtemp(path.join(temporaryRoot, `${goOS}-${goArch}-`));
      config.macos = await prepareMacRecoverySigning(config.macos, recoveryProfile, configDir);
    }
    await run("go", ["tool", "mygo", "generate"]);
    if (options.dev) await run("go", ["tool", "mygo", "dev"]);
    else {
      await run(pnpm, ["--filter", "@chordv/desktop", "build"], PROJECT_ROOT);
      const tempRoot = goOS === "windows" ? path.join(PROJECT_ROOT, ".tmp", "mygo-build-config") : path.join(nativeDir, ".mygo-build-config");
      await mkdir(tempRoot, { recursive: true });
      configDir ??= await mkdtemp(path.join(tempRoot, `${goOS}-${goArch}-`));
      // MyGo creates transient .syso files in its main package, outside the Go overlay.
      config.main = goOS === "windows" ? await prepareWindowsBuildSource(PROJECT_ROOT, configDir) : nativeDir;
      config.icon = path.join(nativeDir, "resources/icon.png");
      config.frontendDist = path.join(PROJECT_ROOT, "apps/desktop/dist");
      config.bindings = goOS === "windows" ? path.join(configDir, "mygo.ts") : path.join(PROJECT_ROOT, "apps/desktop/src/lib/mygo.ts");
      config.resources = [...(config.resources ?? []).map((item) => path.resolve(nativeDir, item)), ...(await readdir(path.join(nativeDir, "resources"))).map((name) => path.join(nativeDir, "resources", name))];
      if (windowsCompatibility) config.windows.installerInclude = await writeWindowsInstallerInclude(config, configDir, { qaOnly: options.windowsInstallerQA });
      config.buildCommand = "";
      config.devCommand = "";
      config.out = path.join(PROJECT_ROOT, "output", options.windowsInstallerQA ? "windows-installer-qa" : "mygo");
      if (options.windowsInstallerQA) {
        await mkdir(config.out, { recursive: true });
        config.out = path.join(config.out, `build${buildNumber}`);
        await mkdir(config.out);
      }
      const configRoot = goOS === "windows" ? path.join(config.main, ".package") : configDir;
      await mkdir(configRoot, { recursive: true });
      await writeFile(path.join(configRoot, "mygo.json"), `${JSON.stringify(config, null, 2)}\n`);
      const buildArgs = ["tool", "mygo", "build", "-skip-build-command", "-platform", `${goOS}/${goArch}`];
      if (options.skipDmg) buildArgs.push("-skip-dmg");
      if (options.skipInstaller) buildArgs.push("-skip-installer");
      buildArgs.push(configRoot);
      if (windowsCompatibility) {
        const wrapper = await prepareWindowsNSIS({ configDir, installerInclude: config.windows.installerInclude, nativeDir, env, run });
        Object.assign(env, wrapper.extraEnv);
      }
      // On macOS, makensis needs a UTF-8 locale to read non-ASCII workspace paths,
      // even when MyGo writes a UTF-8 BOM. Keep this scoped to installer builds.
      const installerEnv = goOS === "windows" && !options.skipInstaller && process.platform === "darwin" ? { LC_ALL: "en_US.UTF-8" } : {};
      await run("go", buildArgs, nativeDir, installerEnv);
      process.stdout.write(`MyGo 完整构建耗时：${((performance.now() - started) / 1000).toFixed(1)} 秒；产物 ${config.out}\n`);
      if (!options.buildOnly) {
        if (goOS !== (process.platform === "win32" ? "windows" : process.platform) || goArch !== (process.arch === "x64" ? "amd64" : process.arch)) throw new Error("跨平台产物已构建；启动请使用对应系统，或传 --build-only");
        const target = path.join(config.out, `${goOS}-${goArch}`);
        const binary = goOS === "darwin" ? path.join(target, `${config.name}.app/Contents/MacOS`, config.name) : path.join(target, `${config.name}${goOS === "windows" ? ".exe" : ""}`);
        if (options.e2e) process.stdout.write(`本地 MyGo 验收 Socket：${env.MYGO_AUTOMATION}\n`);
        await run(binary, [], PROJECT_ROOT);
      }
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (configDir) await rm(configDir, { recursive: true, force: true });
}
