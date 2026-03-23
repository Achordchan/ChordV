import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { buildAndroidArtifactNames, resolveDesktopPlatformVersion } from './platform-version.mjs';

const desktopRoot = process.cwd();
const androidVersion = resolveDesktopPlatformVersion("android");
const debugArtifactNames = buildAndroidArtifactNames(androidVersion, false);
const defaultApkPath = path.join(desktopRoot, '..', '..', 'output', 'release', 'android', debugArtifactNames.apk);
const packageName = 'com.baymaxgroup.chordv';

function parseArgs(rawArgs) {
  const options = {
    apk: defaultApkPath,
    serial: null,
    launch: true
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const current = rawArgs[index];
    if (current === '--apk') {
      options.apk = rawArgs[index + 1] ?? options.apk;
      index += 1;
      continue;
    }
    if (current === '--serial') {
      options.serial = rawArgs[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (current === '--no-launch') {
      options.launch = false;
    }
  }

  return options;
}

function ensureAdb() {
  const result = spawnSync('sh', ['-lc', 'command -v adb'], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error('未找到 adb，请先安装 Android Platform Tools。');
    process.exit(1);
  }
}

function listDevices() {
  const result = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || '读取 Android 设备列表失败。');
    process.exit(result.status ?? 1);
  }

  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[1] === 'device')
    .map(([serial]) => serial);
}

function adbArgs(serial, args) {
  return serial ? ['-s', serial, ...args] : args;
}

function runAdb(serial, args, useParentStdio = false) {
  return spawnSync('adb', adbArgs(serial, args), {
    encoding: 'utf8',
    stdio: useParentStdio ? 'inherit' : 'pipe'
  });
}

function launchApp(serial) {
  const result = runAdb(serial, [
    'shell',
    'monkey',
    '-p',
    packageName,
    '-c',
    'android.intent.category.LAUNCHER',
    '1'
  ]);

  if (result.status !== 0) {
    console.error(result.stderr || '启动 Android 应用失败。');
    process.exit(result.status ?? 1);
  }
}

ensureAdb();
const options = parseArgs(process.argv.slice(2));
const apkPath = path.resolve(desktopRoot, options.apk);

if (!fs.existsSync(apkPath)) {
  console.error(`未找到 Android APK：${apkPath}`);
  process.exit(1);
}

const devices = listDevices();
if (devices.length === 0) {
  console.error('当前没有连接可用的 Android 真机。');
  process.exit(1);
}

if (options.serial && !devices.includes(options.serial)) {
  console.error(`指定设备不存在：${options.serial}`);
  process.exit(1);
}

const serial = options.serial ?? devices[0];
console.log(`准备安装到设备：${serial}`);

const installResult = runAdb(serial, ['install', '-r', apkPath], true);
if (installResult.status !== 0) {
  process.exit(installResult.status ?? 1);
}

if (options.launch) {
  launchApp(serial);
  console.log('已安装并尝试启动 ChordV 安卓应用。');
} else {
  console.log('已安装 ChordV 安卓应用。');
}
