import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { buildAndroidArtifactNames, resolveDesktopPlatformVersion } from './platform-version.mjs';

function resolveJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
    return process.env.JAVA_HOME;
  }

  const brewJavaHome = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
  if (fs.existsSync(brewJavaHome)) {
    return brewJavaHome;
  }

  const result = spawnSync('/usr/libexec/java_home', ['-v', '17+'], { encoding: 'utf8' });
  if (result.status === 0) {
    return result.stdout.trim();
  }

  return null;
}

function resolveAndroidHome() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library/Android/sdk'),
    '/opt/homebrew/share/android-commandlinetools'
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function resolveNdkHome(androidHome) {
  if (process.env.NDK_HOME && fs.existsSync(process.env.NDK_HOME)) {
    return process.env.NDK_HOME;
  }

  if (!androidHome) {
    return null;
  }

  const ndkRoot = path.join(androidHome, 'ndk');
  if (!fs.existsSync(ndkRoot)) {
    return null;
  }

  const versions = fs
    .readdirSync(ndkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  if (versions.length === 0) {
    return null;
  }

  return path.join(ndkRoot, versions[0]);
}

function resolveNdkVersion(ndkHome) {
  if (!ndkHome) {
    return null;
  }

  const version = path.basename(ndkHome);
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

function resolveNdkLlvmStrip(ndkHome) {
  if (!ndkHome) {
    return null;
  }

  const candidates = [
    path.join(ndkHome, 'toolchains', 'llvm', 'prebuilt', 'darwin-x86_64', 'bin', 'llvm-strip'),
    path.join(ndkHome, 'toolchains', 'llvm', 'prebuilt', 'darwin-arm64', 'bin', 'llvm-strip'),
    path.join(ndkHome, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin', 'llvm-strip'),
    path.join(ndkHome, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin', 'llvm-strip.exe')
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const androidHome = resolveAndroidHome();
const ndkHome = resolveNdkHome(androidHome);
const ndkVersion = resolveNdkVersion(ndkHome);
const ndkLlvmStrip = resolveNdkLlvmStrip(ndkHome);
const javaHome = resolveJavaHome();
const libv2rayVersion = 'v26.3.9';
const libv2rayOriginUrl = `https://github.com/2dust/AndroidLibXrayLite/releases/download/${libv2rayVersion}/libv2ray.aar`;
const libv2rayMirrorUrls = [
  process.env.CHORDV_ANDROID_LIBV2RAY_URL,
  `https://ghfast.top/${libv2rayOriginUrl}`,
  `https://mirror.ghproxy.com/${libv2rayOriginUrl}`,
  `https://ghproxy.com/${libv2rayOriginUrl}`,
  libv2rayOriginUrl
].filter(Boolean);
const command = process.argv[2];
const args = process.argv.slice(3);
const desktopRoot = process.cwd();
const androidProjectRoot = path.join(desktopRoot, "src-tauri", "gen", "android");
const androidVersion = resolveDesktopPlatformVersion("android");

if (!command) {
  console.error('缺少 Android 子命令，例如 init、dev、build。');
  process.exit(1);
}

if (!javaHome || !androidHome || !ndkHome) {
  console.error('Android 构建环境未准备好，请先执行 pnpm android:doctor 查看缺失项。');
  process.exit(1);
}

function toGradlePath(input) {
  return input.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function ensureAndroidLocalProperties() {
  if (!fs.existsSync(androidProjectRoot)) {
    return;
  }

  const localPropertiesPath = path.join(androidProjectRoot, "local.properties");
  const content = [
    `sdk.dir=${toGradlePath(androidHome)}`
  ];

  if (ndkVersion) {
    content.push(`ndk.version=${ndkVersion}`);
  }

  fs.writeFileSync(localPropertiesPath, `${content.join("\n")}\n`, "utf8");
}

ensureAndroidLocalProperties();

function ensureAndroidResources() {
  const sourceDir = path.join(desktopRoot, 'src-tauri', 'bin');
  const legacyTargetDir = path.join(desktopRoot, 'src-tauri', 'android-bin');
  const allowedFiles = ['geoip.dat', 'geosite.dat'];

  for (const fileName of allowedFiles) {
    const sourcePath = path.join(sourceDir, fileName);
    if (!fs.existsSync(sourcePath)) {
      console.error(`缺少 Android 运行资源：${fileName}`);
      process.exit(1);
    }
  }

  if (fs.existsSync(legacyTargetDir)) {
    fs.rmSync(legacyTargetDir, { recursive: true, force: true });
  }
}

ensureAndroidResources();

const sourceBinDir = path.join(desktopRoot, 'src-tauri', 'bin');
const androidBuildBackupDir = path.join(desktopRoot, 'src-tauri', '.android-build-backup');
const androidBuildPlaceholderFile = path.join(sourceBinDir, 'android-build-placeholder.txt');
const androidLibDir = path.join(desktopRoot, 'src-tauri', 'android-libs');
const androidLibPath = path.join(androidLibDir, 'libv2ray.aar');
const generatedAndroidAssetsDir = path.join(androidProjectRoot, 'app', 'src', 'main', 'assets', 'android-bin');
const generatedJniLibsDir = path.join(androidProjectRoot, 'app', 'src', 'main', 'jniLibs');
const generatedAndroidLibsDir = path.join(androidProjectRoot, 'app', 'libs');

function ensureAndroidLibv2ray() {
  fs.mkdirSync(androidLibDir, { recursive: true });
  if (fs.existsSync(androidLibPath) && validateZipArtifact(androidLibPath)) {
    return;
  }

  if (fs.existsSync(androidLibPath)) {
    fs.rmSync(androidLibPath, { force: true });
  }

  const download = downloadAndroidLibv2ray();

  if (download.status !== 0 || !fs.existsSync(androidLibPath) || !validateZipArtifact(androidLibPath)) {
    console.error('下载 Android libv2ray.aar 失败。');
    process.exit(download.status ?? 1);
  }
}

function downloadAndroidLibv2ray() {
  for (const url of libv2rayMirrorUrls) {
    const result = spawnSync('curl', ['--fail', '-L', '--connect-timeout', '15', '--max-time', '600', '-o', androidLibPath, url], {
      cwd: desktopRoot,
      stdio: 'inherit'
    });
    if (result.status === 0 && fs.existsSync(androidLibPath) && validateZipArtifact(androidLibPath)) {
      return result;
    }
  }

  if (commandExists('gh')) {
    const ghResult = spawnSync(
      'gh',
      ['release', 'download', libv2rayVersion, '-R', '2dust/AndroidLibXrayLite', '-p', 'libv2ray.aar', '-D', androidLibDir, '--clobber'],
      {
        cwd: desktopRoot,
        stdio: 'inherit'
      }
    );
    if (ghResult.status === 0 && fs.existsSync(androidLibPath) && validateZipArtifact(androidLibPath)) {
      return ghResult;
    }
  }

  return {
    status: 1
  };
}

function commandExists(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
    cwd: desktopRoot,
    stdio: 'ignore'
  });

  return result.status === 0;
}

function validateZipArtifact(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const result = spawnSync(
    'python3',
    [
      '-c',
      'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); bad = z.testzip(); sys.exit(0 if bad is None else 1)',
      filePath
    ],
    {
      cwd: desktopRoot,
      stdio: 'ignore'
    }
  );

  return result.status === 0;
}

ensureAndroidLibv2ray();

function stageAndroidOnlyBin() {
  fs.rmSync(androidBuildBackupDir, { recursive: true, force: true });
  fs.mkdirSync(androidBuildBackupDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceBinDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const sourcePath = path.join(sourceBinDir, entry.name);
    const backupPath = path.join(androidBuildBackupDir, entry.name);
    fs.renameSync(sourcePath, backupPath);
  }

  fs.writeFileSync(androidBuildPlaceholderFile, 'android-build-placeholder\n', 'utf8');
}

function restoreDesktopBin() {
  fs.rmSync(androidBuildPlaceholderFile, { force: true });
  if (!fs.existsSync(androidBuildBackupDir)) {
    return;
  }
  for (const entry of fs.readdirSync(androidBuildBackupDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const backupPath = path.join(androidBuildBackupDir, entry.name);
    const targetPath = path.join(sourceBinDir, entry.name);
    fs.renameSync(backupPath, targetPath);
  }
  fs.rmSync(androidBuildBackupDir, { recursive: true, force: true });
}

function cleanGeneratedAndroidArtifacts() {
  const staleBuildDirs = [
    path.join(androidProjectRoot, 'app', 'build', 'intermediates', 'assets'),
    path.join(androidProjectRoot, 'app', 'build', 'intermediates', 'compressed_assets'),
    path.join(androidProjectRoot, 'app', 'build', 'outputs', 'apk', 'universal'),
    path.join(androidProjectRoot, 'app', 'build', 'outputs', 'bundle', 'universalDebug'),
    path.join(androidProjectRoot, 'app', 'build', 'outputs', 'logs')
  ];

  for (const dirPath of [
    generatedAndroidAssetsDir,
    generatedJniLibsDir,
    generatedAndroidLibsDir,
    ...staleBuildDirs
  ]) {
    if (!fs.existsSync(dirPath)) {
      continue;
    }
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function syncAndroidLibraries() {
  fs.mkdirSync(generatedAndroidLibsDir, { recursive: true });
  fs.copyFileSync(androidLibPath, path.join(generatedAndroidLibsDir, 'libv2ray.aar'));
}

function ensureAndroidTauriProperties() {
  const tauriPropertiesPath = path.join(androidProjectRoot, 'app', 'tauri.properties');
  if (!fs.existsSync(tauriPropertiesPath)) {
    return;
  }

  const raw = fs.readFileSync(tauriPropertiesPath, 'utf8');
  const lines = raw
    .split('\n')
    .filter(
      (line) =>
        line.trim() !== '' &&
        !line.startsWith('abiList=') &&
        !line.startsWith('archList=') &&
        !line.startsWith('targetList=')
    );

  lines.push('abiList=arm64-v8a', 'archList=arm64', 'targetList=aarch64');

  fs.writeFileSync(tauriPropertiesPath, `${lines.join('\n')}\n`, 'utf8');
}

cleanGeneratedAndroidArtifacts();
syncAndroidLibraries();
ensureAndroidTauriProperties();
stageAndroidOnlyBin();
const generatedAndroidTauriConfigPath = path.join(desktopRoot, 'src-tauri', '.tauri.android.platform.conf.json');
const androidBaseConfigPath = path.join(desktopRoot, 'src-tauri', 'tauri.android.conf.json');
const androidBaseConfig = JSON.parse(fs.readFileSync(androidBaseConfigPath, 'utf8'));
fs.writeFileSync(
  generatedAndroidTauriConfigPath,
  JSON.stringify({ ...androidBaseConfig, version: androidVersion }, null, 2),
  'utf8'
);

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  NDK_HOME: ndkHome,
  GRADLE_OPTS: `${process.env.GRADLE_OPTS ? `${process.env.GRADLE_OPTS} ` : ''}-Dorg.gradle.internal.http.connectionTimeout=180000 -Dorg.gradle.internal.http.socketTimeout=180000`,
  CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG ?? '0',
  CARGO_PROFILE_DEV_STRIP: process.env.CARGO_PROFILE_DEV_STRIP ?? 'debuginfo',
  CARGO_PROFILE_DEV_SPLIT_DEBUGINFO: process.env.CARGO_PROFILE_DEV_SPLIT_DEBUGINFO ?? 'off',
  CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? 'z',
  CARGO_PROFILE_DEV_CODEGEN_UNITS: process.env.CARGO_PROFILE_DEV_CODEGEN_UNITS ?? '1',
  CARGO_PROFILE_DEV_PANIC: process.env.CARGO_PROFILE_DEV_PANIC ?? 'abort'
};

if (ndkLlvmStrip) {
  env.CARGO_TARGET_AARCH64_LINUX_ANDROID_STRIP = ndkLlvmStrip;
}

const child = spawn('pnpm', ['exec', 'tauri', 'android', command, '-c', 'src-tauri/.tauri.android.platform.conf.json', ...args], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit'
});

child.on('exit', (code) => {
  restoreDesktopBin();
  fs.rmSync(generatedAndroidTauriConfigPath, { force: true });
  if ((code ?? 1) === 0 && command === 'build') {
    syncAndroidArtifacts();
    validateAndroidArtifacts();
  }
  process.exit(code ?? 1);
});

function syncAndroidArtifacts() {
  const releaseDir = path.resolve(desktopRoot, "..", "..", "output", "release", "android");
  fs.mkdirSync(releaseDir, { recursive: true });
  const apkDir = path.join(androidProjectRoot, "app", "build", "outputs", "apk");
  const bundleDir = path.join(androidProjectRoot, "app", "build", "outputs", "bundle");

  const apkFiles = findFiles(apkDir, (filePath) => filePath.endsWith(".apk"));
  const bundleFiles = findFiles(bundleDir, (filePath) => filePath.endsWith(".aab"));
  const isDebugBuild = args.includes('--debug');
  const artifactNames = buildAndroidArtifactNames(androidVersion, !isDebugBuild);
  const apkOutputName = artifactNames.apk;
  const aabOutputName = artifactNames.aab;
  const apkTargetPath = path.join(releaseDir, apkOutputName);
  const aabTargetPath = path.join(releaseDir, aabOutputName);

  const apkSource = apkFiles.find((filePath) => filePath.includes(`${path.sep}arm64${path.sep}`));
  const bundleSource = bundleFiles.find((filePath) => filePath.includes('arm64'));

  if (!apkSource) {
    console.error('未找到 arm64 APK 输出，请先检查 Android ABI 产物链。');
    process.exit(1);
  }

  if (!bundleSource) {
    console.error('未找到 arm64 AAB 输出，请先检查 Android ABI 产物链。');
    process.exit(1);
  }

  fs.rmSync(apkTargetPath, { force: true });
  fs.copyFileSync(apkSource, apkTargetPath);

  fs.rmSync(aabTargetPath, { force: true });
  fs.copyFileSync(bundleSource, aabTargetPath);
}

function validateAndroidArtifacts() {
  const releaseDir = path.resolve(desktopRoot, "..", "..", "output", "release", "android");
  const checkScript = path.join(desktopRoot, 'scripts', 'check-android-bundle.mjs');
  if (!fs.existsSync(checkScript)) {
    return;
  }

  const result = spawnSync('node', [checkScript, releaseDir], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: process.env
  });

  if (result.status !== 0) {
    console.error('Android 产物校验失败，请先修复资源或 ABI 问题。');
    process.exit(result.status ?? 1);
  }
}

function findFiles(rootDir, predicate) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  return results.sort();
}
