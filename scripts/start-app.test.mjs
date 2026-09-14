import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../start-app.sh');
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

// Isolated command doubles exercise shell orchestration, not native compilation.
function fixture(platform = 'macos') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordv app preview '));
  const bin = path.join(root, 'tools');
  const desktop = path.join(root, 'apps/desktop');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(desktop, 'config'), { recursive: true });
  fs.mkdirSync(path.join(desktop, 'node_modules/@tauri-apps/cli'), { recursive: true });
  fs.mkdirSync(path.join(desktop, 'node_modules/typescript'), { recursive: true });
  fs.mkdirSync(path.join(desktop, 'node_modules/vite'), { recursive: true });
  fs.writeFileSync(path.join(desktop, 'node_modules/@tauri-apps/cli/tauri.js'), '');
  fs.writeFileSync(path.join(desktop, 'config/platform-versions.json'), JSON.stringify({ macos: '1.1.8', windows: '1.1.8' }));
  fs.copyFileSync(script, path.join(root, 'start-app.sh'));
  const host = platform === 'macos' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc';
  const writeCommand = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  writeCommand('uname', `echo ${platform === 'macos' ? 'Darwin' : 'MINGW64_NT-10.0'}`);
  writeCommand('rustc', `echo 'host: ${host}'`);
  writeCommand('cargo', 'exit 0');
  writeCommand('xcode-select', 'exit 0');
  writeCommand('pnpm', 'echo frontend >> "$TEST_LOG"; exit "${TEST_BUILD_EXIT:-0}"');
  const driver = path.join(root, 'driver.cjs');
  fs.writeFileSync(driver, `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '-p' && args[1] === 'process.platform') {
  process.stdout.write(${JSON.stringify(platform === 'macos' ? 'darwin' : 'win32')});
} else if (args[0] === './node_modules/@tauri-apps/cli/tauri.js') {
  const config = JSON.parse(args[args.indexOf('--config') + 1]);
  if (!args.includes('--no-bundle') || !args.includes('--debug') || config.build.beforeBuildCommand !== '') process.exit(90);
  fs.appendFileSync(process.env.TEST_LOG, 'native\\n');
  const dir = path.join(process.env.CARGO_TARGET_DIR, ${JSON.stringify(host)}, 'debug');
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, config.mainBinaryName + ${JSON.stringify(platform === 'windows' ? '.exe' : '')}),
    '#!' + ${JSON.stringify(process.execPath)} + '\\n' +
    'require("node:fs").appendFileSync(process.env.TEST_LOG, "launched\\\\n"); if (process.env.TEST_NATIVE_ENV_LOG) require("node:fs").writeFileSync(process.env.TEST_NATIVE_ENV_LOG, JSON.stringify({ api: process.env.CHORDV_API_BASE_URL })); if (process.env.TEST_HOLD_APP) { console.log("PREVIEW_TEST_READY"); setInterval(() => {}, 1000); }', {mode:0o755});
} else {
  const r = require('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, args, {stdio:'inherit'});
  process.exit(r.status ?? 1);
}
`);
  writeCommand('node', `exec ${quote(process.execPath)} ${quote(driver)} "$@"`);
  const log = path.join(root, 'log');
  const run = (args = [], extra = {}) => spawnSync('/bin/bash', [path.join(root, 'start-app.sh'), ...args], {
    cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, ...extra }
  });
  return { root, run, bin, log, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const platform of ['macos', 'windows']) {
  test(`${platform}: build and launch from another cwd with spaces in path`, () => {
    const f = fixture(platform);
    try {
      const r = f.run(); assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(f.log, 'utf8'), 'frontend\nnative\nlaunched\n');
      assert.equal(fs.existsSync(path.join(f.root, '.data/local-app/session.lock')), false);
      assert.equal(f.run().status, 0, 'normal exit releases session lock');
    } finally { f.dispose(); }
  });
}
test('preflight and build-only do not launch', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['--check']).status, 0);
    assert.equal(fs.existsSync(f.log), false);
    assert.equal(f.run(['--build-only']).status, 0);
    assert.equal(fs.readFileSync(f.log, 'utf8'), 'frontend\nnative\n');
  } finally { f.dispose(); }
});
test('frontend failure stops native build and releases lock', () => {
  const f = fixture();
  try {
    const r = f.run([], { TEST_BUILD_EXIT: '17' }); assert.equal(r.status, 17);
    assert.equal(fs.readFileSync(f.log, 'utf8'), 'frontend\n');
    assert.equal(fs.existsSync(path.join(f.root, '.data/local-app/session.lock')), false);
  } finally { f.dispose(); }
});
test('existing session prevents all build work', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, '.data/local-app/session.lock'), {recursive:true});
    const r = f.run(); assert.equal(r.status, 1); assert.match(r.stderr, /已有客户端/);
    assert.equal(fs.existsSync(f.log), false);
    assert.equal(fs.existsSync(path.join(f.root, '.data/local-app/session.lock')), true);
  } finally { f.dispose(); }
});
test('invalid arguments and unsupported platform fail before build', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['5174']).status, 1);
    fs.writeFileSync(path.join(f.bin, 'uname'), '#!/bin/bash\necho Linux\n');
    assert.equal(f.run().status, 1);
    assert.equal(fs.existsSync(f.log), false);
  } finally { f.dispose(); }
});

test('interrupt stops owned preview process group and releases session lock', async () => {
  const f = fixture();
  let child;
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn('/bin/bash', [path.join(f.root, 'start-app.sh')], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, TEST_LOG: f.log, TEST_HOLD_APP: '1' }
      });
      let output = '';
      let interrupted = false;
      const timeout = setTimeout(() => { process.kill(-child.pid, 'SIGKILL'); reject(new Error('preview timeout: ' + output + ' interrupted=' + interrupted)); }, 15000);
      child.stderr.on('data', data => { output += data.toString(); });
      child.stdout.on('data', data => {
        output += data.toString();
        if (!interrupted && output.includes('PREVIEW_TEST_READY')) {
          interrupted = true;
          process.kill(-child.pid, 'SIGINT');
        }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timeout); resolve({code, signal, interrupted}); });
    });
    assert.equal(result.interrupted, true);
    assert.equal(fs.existsSync(path.join(f.root, '.data/local-app/session.lock')), false);
    assert.throws(() => process.kill(-child.pid, 0), /ESRCH/);
  } finally { f.dispose(); }
});

for (const platform of ['macos', 'windows']) {
  test(`${platform}: API override reaches native process without replacing an explicit override`, () => {
    const f = fixture(platform);
    try {
      const envLog = path.join(f.root, 'native-env.json');
      let r = f.run([], { VITE_API_BASE_URL: 'http://127.0.0.1:3000', CHORDV_API_BASE_URL: undefined, TEST_NATIVE_ENV_LOG: envLog });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(fs.readFileSync(envLog, 'utf8')).api, 'http://127.0.0.1:3000');
      r = f.run([], { VITE_API_BASE_URL: 'http://127.0.0.1:3000', CHORDV_API_BASE_URL: 'http://127.0.0.1:4000', TEST_NATIVE_ENV_LOG: envLog });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(fs.readFileSync(envLog, 'utf8')).api, 'http://127.0.0.1:4000');
    } finally { f.dispose(); }
  });
}
