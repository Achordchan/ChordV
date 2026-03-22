import process from 'node:process';
import { spawn } from 'node:child_process';

function parseArgs(rawArgs) {
  const options = {
    serial: null,
    clear: false
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const current = rawArgs[index];
    if (current === '--serial') {
      options.serial = rawArgs[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (current === '--clear') {
      options.clear = true;
    }
  }

  return options;
}

function adbPrefix(serial) {
  return serial ? ['-s', serial] : [];
}

function spawnLogcat(serial) {
  const child = spawn(
    'adb',
    [
      ...adbPrefix(serial),
      'logcat',
      '-v',
      'color',
      'ChordvAndroidRuntimePlugin:D',
      'ChordvVpnService:D',
      'Tauri:D',
      'libv2ray:D',
      '*:S'
    ],
    { stdio: 'inherit' }
  );
  child.on('exit', (code) => process.exit(code ?? 0));
}

const options = parseArgs(process.argv.slice(2));
if (!options.clear) {
  spawnLogcat(options.serial);
} else {
  const clear = spawn('adb', [...adbPrefix(options.serial), 'logcat', '-c'], {
    stdio: 'inherit'
  });
  clear.on('exit', (code) => {
    if (code && code !== 0) {
      process.exit(code);
    }
    spawnLogcat(options.serial);
  });
}
