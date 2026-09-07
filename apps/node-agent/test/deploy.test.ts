import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(new URL('../deploy/build-release.sh', import.meta.url), 'utf8');
const healthCheck = readFileSync(new URL('../deploy/health-check.sh', import.meta.url), 'utf8');

test('Linux 发布产物强制复制原生模块并拒绝运行时共享 inode', () => {
  assert.match(script, /--config\.package-import-method=copy/);
  assert.match(script, /-name '\*\.node' -links \+1/);
  assert.match(script, /systemctl is-active --quiet chordv-node-agent/);
});

test('健康检查以状态库所属用户身份执行，缺少 runuser 时中止而非以 root 探测', () => {
  assert.match(healthCheck, /exec runuser -u "\$db_owner" -- "\$node_bin" dist\/src\/main\.js --health/);
  assert.match(healthCheck, /缺少 runuser/);
});
