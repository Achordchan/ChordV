// Runs against an extracted backend bundle, never the source working directory.
// Only admin authentication and systemd scheduling are fixture adapters; the
// database, controllers, agent protocol, panel, Xray and downloads are real.
const { createRequire } = require('node:module');
const req = createRequire('/release/apps/api/package.json');
req('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { Module, ValidationPipe } = req('@nestjs/common');
const { NestFactory } = req('@nestjs/core');
const { PrismaClient } = req('@prisma/client');
const base = '/release/apps/api/dist/apps/api/src/modules/';
const load = (file, name) => require(base + file + '.js')[name];
const PrismaService = load('common/prisma.service', 'PrismaService');
const AdminAuthGuard = load('common/admin-auth.guard', 'AdminAuthGuard');
const AuthSessionService = load('common/auth-session.service', 'AuthSessionService');
const AgentAuthGuard = load('agent/agent-auth.guard', 'AgentAuthGuard');
const AgentService = load('agent/agent.service', 'AgentService');
const AgentRegisterService = load('agent/agent-register.service', 'AgentRegisterService');
const AgentEventsService = load('agent/agent-events.service', 'AgentEventsService');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(binary, args) {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, output);
  return output;
}
async function main() {
  assert.ok(new URL(process.env.DATABASE_URL).pathname.endsWith('/chordv_onboarding_test'));
  const prisma = new PrismaClient();
  const events = new AgentEventsService(prisma);
  const changes = [];
  const adminEvents = { publish: event => changes.push(event) };
  const registration = new AgentRegisterService(prisma, adminEvents);
  const service = new AgentService(prisma, events, {}, adminEvents);
  class TestModule {}
  Module({
    controllers: ['AgentController', 'AgentRegisterController', 'AgentInstallController', 'AgentDownloadController', 'AgentAdminController'].map(name => {
      const file = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace('-controller', '.controller');
      return load('agent/' + file, name);
    }),
    providers: [AgentAuthGuard, AdminAuthGuard,
      { provide: AuthSessionService, useValue: { authenticateAccessToken: async () => ({ role: 'admin' }) } },
      { provide: PrismaService, useValue: prisma }, { provide: AgentService, useValue: service },
      { provide: AgentRegisterService, useValue: registration }, { provide: AgentEventsService, useValue: events }]
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: ['error'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api');
  await app.listen(3100, '127.0.0.1');
  const api = async (path, body) => {
    const response = await fetch('http://127.0.0.1:3100/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const text = await response.text(); assert.ok(response.ok, `${response.status} ${text}`);
    return JSON.parse(text);
  };
  let nodeId;
  try {
    let csrf;
    for (let n = 0; n < 30; n++) {
      try { csrf = await fetch('http://127.0.0.1:54321/csrf-token'); if (csrf.ok) break; } catch {}
      await sleep(200);
    }
    assert.ok(csrf?.ok, 'panel did not start');
    const csrfBody = await csrf.json();
    const csrfToken = csrfBody.obj;
    assert.ok(csrfToken, JSON.stringify(csrfBody));
    let cookie = csrf.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const login = await fetch('http://127.0.0.1:54321/login', { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'go-e2e', password: 'test-only-isolated-strong-password' }) });
    if (!login.ok) throw new Error(`panel login HTTP ${login.status}: ${await login.text()}`);
    const loginResult = await login.json(); assert.equal(loginResult.success, true, JSON.stringify(loginResult));
    cookie = login.headers.get('set-cookie')?.split(';')[0] || cookie;
    const pair = generateKeyPairSync('x25519');
    const publicKey = pair.publicKey.export({ format: 'jwk' }).x;
    const privateKey = pair.privateKey.export({ format: 'jwk' }).d;
    const panelInbound = {
      remark: 'isolated-go-agent-test', enable: true, expiryTime: 0, total: 0, listen: '', port: 18443, protocol: 'vless',
      settings: JSON.stringify({ clients: [{ id: 'd52ca32b-784a-4f4b-ab51-b8341884f213', email: 'panel-owned@test', enable: true, flow: 'xtls-rprx-vision', limitIp: 0, totalGB: 0, expiryTime: 0 }], decryption: 'none', fallbacks: [] }),
      streamSettings: JSON.stringify({ network: 'tcp', security: 'reality', realitySettings: { show: false, dest: 'example.com:443', xver: 0, serverNames: ['example.com'], privateKey, shortIds: ['ab'], settings: { publicKey, fingerprint: 'chrome', spiderX: '/' } } }),
      sniffing: JSON.stringify({ enabled: false }), allocate: JSON.stringify({ strategy: 'always', refresh: 5, concurrency: 3 })
    };
    const add = await fetch('http://127.0.0.1:54321/panel/api/inbounds/add', { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(panelInbound) });
    const added = await add.json(); assert.equal(added.success, true, JSON.stringify(added));
    console.log('Panel created inbound:', { tag: added.obj?.tag, port: added.obj?.port, enable: added.obj?.enable });
    await sleep(1500);
    const panelFiles = ['/usr/local/x-ui/x-ui', '/usr/local/x-ui/bin/xray-linux-arm64', '/usr/local/x-ui/bin/config.json'];
    const before = panelFiles.map(hash);
    const link = `vless://d52ca32b-784a-4f4b-ab51-b8341884f213@node.example.com:18443?security=reality&type=tcp&pbk=${publicKey}&sid=ab&sni=example.com&flow=xtls-rprx-vision`;
    const spec = await api('admin/nodes/panel-inbound/parse', { link, panelVersion: 'auto' });
    assert.ok(!JSON.stringify(spec).includes('d52ca32b'));
    const created = await api('admin/nodes/agent-native', { name: 'Real panel onboarding', panelInbound: spec });
    nodeId = created.node.id;
    const install = await fetch('http://127.0.0.1:3100/api/agent-install/script.sh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: created.registerToken }) });
    const installScript = await install.text();
    fs.writeFileSync('/scenario/install.sh', installScript, { mode: 0o600 });
    const output = await command('bash', ['/scenario/install.sh']);
    assert.match(output, /Go agent 已注册/);
    let status;
    for (let n = 0; n < 40; n++) {
      status = await api(`admin/nodes/${nodeId}/onboarding`);
      if (status.command?.status === 'completed') break;
      if (status.command?.status === 'failed') throw new Error(status.command.lastError);
      await sleep(250);
    }
    assert.equal(status.command?.status, 'completed', JSON.stringify(status));
    assert.equal(status.node.inboundAppliedRevision, status.command.targetRevision);
    assert.equal(status.node.agent.version, 'go-' + fs.readFileSync('/release/SYSTEM_VERSION', 'utf8').trim());
    assert.equal(status.node.isActive, false);
    assert.equal(status.node.serverPort, 18443);
    assert.equal(status.spec.inboundTag, added.obj.tag);
    const identityHash = hash('/var/lib/chordv-node-agent/credentials.json');
    const second = await fetch('http://127.0.0.1:3100/api/agent-install/script.sh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: created.registerToken }) });
    fs.writeFileSync('/scenario/repeat.sh', await second.text(), { mode: 0o600 });
    await command('bash', ['/scenario/repeat.sh']);
    assert.equal(hash('/var/lib/chordv-node-agent/credentials.json'), identityHash);
    assert.equal(await prisma.nodeAgent.count({ where: { nodeId } }), 1);
    assert.equal(await prisma.nodeCommandJob.count({ where: { nodeId, commandType: 'ENSURE_INBOUND' } }), 1);
    const env = fs.readFileSync('/etc/chordv/node-agent.env', 'utf8');
    const address = /^XRAY_API_ADDRESS=(.+)$/m.exec(env)?.[1];
    assert.ok(address);
    const panelUser = execFileSync('/usr/local/x-ui/bin/xray-linux-arm64', ['api', 'inbounduser', `--server=${address}`, `-tag=${added.obj.tag}`, '-email=panel-owned@test'], { encoding: 'utf8' });
    assert.match(panelUser, /"email"\s*:\s*"panel-owned@test"/, 'the running panel-owned account must survive onboarding and restart');
    assert.deepEqual(panelFiles.map(hash), before, 'installer modified the panel binary/config');
    assert.ok(changes.some(event => event.nodeId === nodeId));
    assert.equal((await fetch('http://127.0.0.1:3100/api/agent-download/linux-x64')).status, 410);
    console.log('LIVE onboarding passed: extracted backend -> parse/create -> pinned download -> real 3x-ui discovery -> unprivileged Go registration -> SSE command -> live Reality validation -> saved parameters -> repeated install retains identity and panel files');
  } finally {
    execFileSync('systemctl', ['stop', 'chordv-node-agent.service']);
    if (nodeId) await prisma.node.delete({ where: { id: nodeId } });
    await app.close(); await prisma.$disconnect();
  }
}
main().catch(error => {
  console.error(error);
  const configPath = '/usr/local/x-ui/bin/config.json';
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.error('Panel API diagnostics:', JSON.stringify({ api: config.api,
      inbounds: config.inbounds?.map(({ tag, listen, port, protocol }) => ({ tag, listen, port, protocol })),
      routing: config.routing?.rules?.filter(rule => rule.outboundTag === config.api?.tag), policy: config.policy, stats: config.stats }));
  }
  for (const file of ['/scenario/agent.log', '/scenario/panel.log']) if (fs.existsSync(file)) console.error(fs.readFileSync(file, 'utf8').split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
});
