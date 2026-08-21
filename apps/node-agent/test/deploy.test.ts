import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(new URL('../deploy/build-release.sh', import.meta.url), 'utf8');

test('Linux 发布产物强制复制原生模块并拒绝运行时共享 inode', () => {
  assert.match(script, /--config\.package-import-method=copy/);
  assert.match(script, /-name '\*\.node' -links \+1/);
  assert.match(script, /systemctl is-active --quiet chordv-node-agent/);
});
