import process from 'node:process';
import { spawnSync } from 'node:child_process';

const packageName = 'com.baymaxgroup.chordv';

function parseArgs(rawArgs) {
  const options = {
    serial: null
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    if (rawArgs[index] === '--serial') {
      options.serial = rawArgs[index + 1] ?? null;
      index += 1;
    }
  }

  return options;
}

function adbArgs(serial, args) {
  return serial ? ['-s', serial, ...args] : args;
}

function listDevices() {
  const result = spawnSync('adb', ['devices'], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    return [];
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

function runAdb(serial, args) {
  return spawnSync('adb', adbArgs(serial, args), {
    encoding: 'utf8'
  });
}

const options = parseArgs(process.argv.slice(2));
const devices = listDevices();

if (devices.length === 0) {
  console.error('当前没有连接可用的 Android 真机。');
  process.exit(1);
}

if (options.serial && !devices.includes(options.serial)) {
  console.error(`指定设备不存在：${options.serial}`);
  process.exit(1);
}

const packageResult = runAdb(options.serial, ['shell', 'pm', 'path', packageName]);
const processResult = runAdb(options.serial, ['shell', 'pidof', packageName]);
const connectivityResult = runAdb(options.serial, ['shell', 'dumpsys', 'connectivity']);

if (packageResult.status !== 0) {
  console.error(packageResult.stderr || '读取 Android 包信息失败。');
  process.exit(packageResult.status ?? 1);
}

const report = {
  packageInstalled: packageResult.stdout.includes('package:'),
  packagePath: packageResult.stdout.trim() || null,
  appPid: processResult.stdout.trim() || null,
  vpnMentioned: connectivityResult.stdout.includes(packageName) || connectivityResult.stdout.includes('ChordV')
};

console.log(JSON.stringify(report, null, 2));

if (!report.packageInstalled) {
  console.error('当前设备未安装 ChordV 安卓应用。');
  process.exit(1);
}
