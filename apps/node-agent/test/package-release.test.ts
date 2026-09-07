import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Works from both src/test (tsx) and dist/test (compiled release).
function locate(relative: string): string {
  let directory = fileURLToPath(new URL('.', import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, relative);
    if (fs.existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(`未找到 ${relative}`);
}

const script = locate('deploy/package-release.sh');
const arch = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';

function release(root: string, marker: string): string {
  const source = join(root, `release-${marker}`);
  fs.mkdirSync(join(source, 'dist/src'), { recursive: true });
  fs.mkdirSync(join(source, 'node_modules'), { recursive: true });
  fs.writeFileSync(join(source, 'dist/src/main.js'), `console.log('${marker}');\n`);
  // Padding so a truncating rewrite would be observable in a concurrent read.
  fs.writeFileSync(join(source, 'dist/src/payload.txt'), marker.repeat(200_000));
  fs.writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@chordv/node-agent', version: `1.0.0-${marker}` }));
  return source;
}

test('republishing a tarball cannot truncate an in-flight download', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-package-release-'));
  try {
    const out = join(root, 'agent-dist');
    const tarball = join(out, `chordv-agent-${arch}.tar.gz`);

    const first = spawnSync('bash', [script, release(root, 'first'), arch, out], { encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
    const published = fs.readFileSync(tarball);
    const inode = fs.statSync(tarball).ino;

    // A download in progress holds an open descriptor, which does NOT protect
    // against an in-place rewrite — only publishing via rename does.
    const streaming = fs.openSync(tarball, 'r');
    try {
      const second = spawnSync('bash', [script, release(root, 'second'), arch, out], { encoding: 'utf8' });
      assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
      const inFlight = Buffer.alloc(published.length);
      const read = fs.readSync(streaming, inFlight, 0, published.length, 0);
      assert.equal(read, published.length, '正在下载的旧文件被截断了');
      assert.deepEqual(inFlight, published, '正在下载的旧文件内容被覆盖了');
    } finally { fs.closeSync(streaming); }

    // The published name now points at the NEW archive, via a new inode.
    assert.notEqual(fs.statSync(tarball).ino, inode);
    const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.ok(listing.stdout.includes('./dist/src/main.js'));
    assert.notDeepEqual(fs.readFileSync(tarball), published);
    // No staging file is left behind next to the published artifact.
    assert.deepEqual(fs.readdirSync(out), [`chordv-agent-${arch}.tar.gz`]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed packaging run leaves the published artifact untouched', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'agent-package-fail-'));
  try {
    const out = join(root, 'agent-dist');
    const tarball = join(out, `chordv-agent-${arch}.tar.gz`);
    assert.equal(spawnSync('bash', [script, release(root, 'good'), arch, out], { encoding: 'utf8' }).status, 0);
    const published = fs.readFileSync(tarball);

    // Missing build output: rejected before anything is written.
    const missing = spawnSync('bash', [script, join(root, 'absent'), arch, out], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /打包失败/);

    // tar fails mid-run: the staging file is cleaned up and the published
    // tarball still serves the previous release. The failure is INJECTED via a
    // PATH shim rather than a 000-mode file — build-release.sh runs this suite
    // and often runs as root, where file permissions would not stop tar and the
    // release build would fail on this assertion instead of the code.
    const shim = join(root, 'shim');
    fs.mkdirSync(shim);
    const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(realTar, '未找到 tar');
    fs.writeFileSync(join(shim, 'tar'), `#!/bin/sh
case " $* " in *" -czf "*) echo 'injected tar failure' >&2; exit 2 ;; esac
exec ${realTar} "$@"
`, { mode: 0o755 });
    const failed = spawnSync('bash', [script, release(root, 'broken'), arch, out], {
      encoding: 'utf8', env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }
    });
    assert.notEqual(failed.status, 0, '打包失败必须传播为非零退出码');
    assert.match(failed.stderr, /injected tar failure/);
    assert.deepEqual(fs.readdirSync(out), [`chordv-agent-${arch}.tar.gz`], '失败的打包不得留下临时文件');
    assert.deepEqual(fs.readFileSync(tarball), published, '失败的打包不得改动已发布产物');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
