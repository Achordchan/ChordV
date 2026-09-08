import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join, relative } from 'node:path';
import { loadConfig } from '../src/config.js';

const script = readFileSync(new URL('../deploy/build-release.sh', import.meta.url), 'utf8');
const configSource = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
const healthCheck = readFileSync(new URL('../deploy/health-check.sh', import.meta.url), 'utf8');
const apiFragment = JSON.parse(readFileSync(new URL('../deploy/xray-api.fragment.json', import.meta.url), 'utf8'));
const baseConfig = JSON.parse(readFileSync(new URL('../deploy/xray-base.json', import.meta.url), 'utf8'));


test('Linux 发布产物强制复制原生模块并拒绝运行时共享 inode', () => {
  assert.match(script, /--config\.package-import-method=copy/);
  assert.match(script, /-name '\*\.node' -links \+1/);
  assert.match(script, /systemctl is-active --quiet chordv-node-agent/);
});

test('健康检查以状态库所属用户身份执行，缺少 runuser 时中止而非以 root 探测', () => {
  assert.match(healthCheck, /exec runuser -u "\$db_owner" -- "\$node_bin" dist\/src\/main\.js --health/);
  assert.match(healthCheck, /缺少 runuser/);
});

test('单元里每个硬性 ReadWritePaths 都必须由 install-systemd.sh 建出', () => {
  // install-systemd.sh 只装 agent，不知道任何 Xray 交接目录。硬性要求的路径
  // 若不存在，systemd 连 mount namespace 都建不出来，服务起不来——既有的
  // 用户管理负载也被拖死。装不出来的路径必须带 "-" 前缀（可选）。
  const unit = readFileSync(new URL('../deploy/chordv-node-agent.service', import.meta.url), 'utf8');
  const installer = readFileSync(new URL('../deploy/install-systemd.sh', import.meta.url), 'utf8');
  const hard = [...unit.matchAll(/^ReadWritePaths=(?!-)(\S+)\s*$/gm)].map((match) => match[1]);
  assert.ok(hard.includes('/var/lib/chordv-node-agent'), '状态目录应是硬性可写路径');
  const created = [...installer.matchAll(/^install -d .*?((?:\/[^\s"'\\]+)+)\s*$/gm)].map((match) => match[1]);
  for (const path of hard) {
    assert.ok(
      created.includes(path),
      `ReadWritePaths=${path} 未由 install-systemd.sh 创建，必须加 "-" 前缀改为可选`,
    );
  }
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

test('Xray 基础配置提供出站，且计量片段端口与 agent 默认地址一致', () => {
  // The api fragment declares an `api` outbound rule and the api-in inbound but
  // no freedom outbound; without the base file Xray refuses to start and the
  // agent's xrayStatus would never turn healthy.
  const outbounds = (baseConfig.outbounds as Array<{ protocol: string }>).map((item) => item.protocol);
  assert.ok(outbounds.includes('freedom'), `基础配置必须提供 freedom 出站：${outbounds.join('、')}`);
  assert.equal(baseConfig.inbounds, undefined, '基础配置不得声明入站');

  const apiInbound = (apiFragment.inbounds as Array<{ tag: string; listen: string; port: number }>)
    .find((item) => item.tag === 'api-in');
  assert.ok(apiInbound, '计量片段必须提供 api-in');
  const [, fallback] = /XRAY_API_ADDRESS\?\.trim\(\) \|\| '([^']+)'/.exec(configSource) ?? [];
  // Two files that must not drift: the agent dials this address by default, so
  // a fragment that moves the port would silently break metering.
  assert.equal(`${apiInbound!.listen}:${apiInbound!.port}`, fallback);
});
