import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { buildAndroidArtifactNames, resolveDesktopPlatformVersion } from './platform-version.mjs';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const outputRoot = path.join(projectRoot, 'output', 'release', 'android');
const androidVersion = resolveDesktopPlatformVersion("android");
const debugArtifactNames = buildAndroidArtifactNames(androidVersion, false);
const defaultApkPath = path.join(outputRoot, debugArtifactNames.apk);
const defaultAabPath = path.join(outputRoot, debugArtifactNames.aab);

function commandExists(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return result.status === 0;
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
    return process.env.JAVA_HOME;
  }

  const brewJavaHome = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
  if (fs.existsSync(brewJavaHome)) {
    return brewJavaHome;
  }

  const macResult = spawnSync('/usr/libexec/java_home', ['-v', '17+'], { encoding: 'utf8' });
  if (macResult.status === 0) {
    return macResult.stdout.trim();
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

function loadConnectedDevices() {
  if (!commandExists('adb')) {
    return [];
  }

  const result = spawnSync('adb', ['devices', '-l'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('*'))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      return {
        serial,
        state,
        detail: rest.join(' ')
      };
    });
}

function readArtifact(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return {
    path: filePath,
    sizeMb: Number((fs.statSync(filePath).size / 1024 / 1024).toFixed(1))
  };
}

const strictMode = process.argv.includes('--strict');
const javaHome = resolveJavaHome();
const androidHome = resolveAndroidHome();
const ndkHome = resolveNdkHome(androidHome);
const adbFound = commandExists('adb');
const sdkmanagerFound = commandExists('sdkmanager');
const devices = loadConnectedDevices();
const apkArtifact = readArtifact(defaultApkPath);
const aabArtifact = readArtifact(defaultAabPath);

const report = {
  javaHome,
  androidHome,
  ndkHome,
  adbFound,
  sdkmanagerFound,
  devices,
  artifacts: {
    apk: apkArtifact,
    aab: aabArtifact
  }
};

console.log(JSON.stringify(report, null, 2));

if (strictMode) {
  const missing = [];
  if (!javaHome) missing.push('JAVA_HOME / JDK 17+');
  if (!androidHome) missing.push('ANDROID_HOME / Android SDK');
  if (!ndkHome) missing.push('NDK_HOME / Android NDK');
  if (!adbFound) missing.push('adb');
  if (!sdkmanagerFound) missing.push('sdkmanager');
  if (!apkArtifact) missing.push('Android 调试 APK');
  if (devices.length === 0) missing.push('至少一台已连接的 Android 真机');

  if (missing.length > 0) {
    console.error(`Android 构建环境缺失：${missing.join('、')}`);
    process.exit(1);
  }
}
