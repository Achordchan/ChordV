import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join, relative } from 'node:path';
import { loadConfig } from '../src/config.js';

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

test('健康检查解析的默认状态库路径与 loadConfig 一致', () => {
  // Diverging defaults would keep a root-run probe from dropping to the real
  // database owner, and the ownership guard would then reject a healthy agent.
  const previous = { ...process.env };
  let fallback: string;
  try {
    for (const name of ['AGENT_DATABASE_PATH', 'CHORDV_AGENT_ID', 'CHORDV_NODE_ID', 'CHORDV_AGENT_TOKEN']) delete process.env[name];
    process.env.CHORDV_API_BASE_URL = 'https://example.com/api';
    process.env.CHORDV_REGISTER_TOKEN = 'chordv_register_default_path';
    fallback = relative(process.cwd(), loadConfig().databasePath);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
  }
  assert.equal(fallback, join('data', 'node-agent.db'));
  assert.ok(healthCheck.includes(`AGENT_DATABASE_PATH:-$PWD/${fallback}`), `脚本默认路径与 loadConfig 不一致：${fallback}`);
});
