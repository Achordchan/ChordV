import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { buildAndroidArtifactNames, resolveDesktopPlatformVersion } from './platform-version.mjs';

const PYTHON_CHECK_SCRIPT = `
import os, sys, zipfile

path = sys.argv[1]
bad = []
with zipfile.ZipFile(path) as z:
    names = z.namelist()
    has_arm64 = any('/arm64-v8a/' in name for name in names)
    has_other_abi = any(
        ('/armeabi-v7a/' in name or '/x86/' in name or '/x86_64/' in name)
        for name in names
    )
    has_mac = any('xray-aarch64-apple-darwin' in name for name in names)
    has_windows = any('xray-x86_64-pc-windows-msvc.exe' in name for name in names)
    has_android_xray = any('assets/bin/xray-aarch64-linux-android' in name for name in names)
    has_android_runtime = (
        has_android_xray
        or any('libgojni.so' in name for name in names)
        or any('libtun2socks.so' in name for name in names)
        or any('libv2ray.so' in name for name in names)
    )
    has_geoip = any(name.endswith('/geoip.dat') or name == 'assets/geoip.dat' for name in names)
    has_geosite = any(name.endswith('/geosite.dat') or name == 'assets/geosite.dat' for name in names)
    has_root_geoip = any(name.endswith('/assets/geoip.dat') or name == 'assets/geoip.dat' for name in names)
    has_root_geosite = any(name.endswith('/assets/geosite.dat') or name == 'assets/geosite.dat' for name in names)
    has_android_bin_dir = any('/assets/android-bin/' in name or name.startswith('assets/android-bin/') for name in names)
    has_placeholder = any(name.endswith('android-build-placeholder.txt') for name in names)
    if not has_arm64:
        bad.append('缺少 arm64-v8a 原生库')
    if has_other_abi:
        bad.append('仍包含非 arm64 ABI')
    if has_mac:
        bad.append('错误混入 macOS xray')
    if has_windows:
        bad.append('错误混入 Windows xray')
    if not has_android_runtime:
        bad.append('缺少 Android 运行时资源')
    if not has_geoip:
        bad.append('缺少 geoip.dat')
    if not has_geosite:
        bad.append('缺少 geosite.dat')
    if has_root_geoip or has_root_geosite:
        bad.append('重复混入根目录 geo 资源')
    if has_android_bin_dir:
        bad.append('仍包含旧的 android-bin 资源目录')
    if has_placeholder:
        bad.append('仍包含构建占位文件')
    print(f'校验 Android 产物: {os.path.basename(path)}')
    print(f'  大小: {os.path.getsize(path) / 1024 / 1024:.1f} MB')
    if has_android_xray:
        print('  运行时: standalone xray')
    elif has_android_runtime:
        print('  运行时: Android 原生库')
    print(f'  Geo 资源: assets/bin (geoip={has_geoip}, geosite={has_geosite})')
    if bad:
        for item in bad:
            print(f'  问题: {item}')
        sys.exit(1)
    print('  结果: 通过')
`;

const inputDir = path.resolve(process.cwd(), process.argv[2] ?? '../../output/release/android');
const androidVersion = resolveDesktopPlatformVersion("android");
const debugArtifacts = buildAndroidArtifactNames(androidVersion, false);
const releaseArtifacts = buildAndroidArtifactNames(androidVersion, true);
const expectedFiles = [debugArtifacts.apk, debugArtifacts.aab, releaseArtifacts.apk, releaseArtifacts.aab];
const candidates = expectedFiles
  .map((fileName) => path.join(inputDir, fileName))
  .filter((filePath) => fs.existsSync(filePath));

if (candidates.length === 0) {
  console.error(`未找到 Android 产物目录：${inputDir}`);
  process.exit(1);
}

for (const filePath of candidates) {
  validateBundle(filePath);
}

function validateBundle(filePath) {
  const result = spawnSync(
    'python3',
    ['-c', PYTHON_CHECK_SCRIPT, filePath],
    { encoding: 'utf8' }
  );

  if (result.stdout.trim()) {
    process.stdout.write(result.stdout);
  }

  if (result.status !== 0) {
    if (result.stderr.trim()) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
}
