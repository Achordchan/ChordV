import { randomUUID } from 'node:crypto';
import { AgentApiClient } from './api-client.js';
import { loadConfig, type AgentConfig } from './config.js';
import { readExistingCredentials, resolveCredentials } from './credentials.js';
import { AgentRunner } from './runner.js';
import { AgentStore } from './store.js';
import { XtlsXrayAdapter } from './xray-adapter.js';

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `--health` is a PROBE, not a boot. deploy/health-check.sh is normally run by
 * an operator as root, so this path must not register, mint credentials, or
 * create/modify any file: a root-owned credentials.json or sqlite -wal under
 * /var/lib/chordv-node-agent would leave the unprivileged service unable to
 * read or write its own state, and a second generated secret would race the
 * service's registration. It reports the service's state instead of producing it.
 */
async function runHealthCheck(config: AgentConfig): Promise<void> {
  const fail = (reason: string) => {
    console.log(JSON.stringify({ ok: false, reason }));
    process.exitCode = 1;
  };
  let credentials;
  try { credentials = readExistingCredentials(config); }
  catch (error) { return fail(describe(error)); }
  if (!credentials) return fail('未注册：本机尚无 Agent 凭据，服务尚未完成首次接入');
  let store: AgentStore;
  try {
    store = new AgentStore(config.databasePath, {
      nodeId: credentials.nodeId,
      bootId: 'health-probe',
      defaultOfflineAllowanceBytes: config.offlineAllowanceBytes,
      readonly: true,
    });
  } catch (error) { return fail(`本地状态库不可读（服务可能尚未启动过）：${describe(error)}`); }
  try {
    await new XtlsXrayAdapter(config.xrayApiAddress, config.xrayInboundTag).health();
    console.log(JSON.stringify({ ok: true, ...store.healthSnapshot() }));
  } catch (error) { fail(describe(error)); }
  finally { store.close(); }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.argv.includes('--health')) return runHealthCheck(config);
  const credentials = await resolveCredentials(config);
  const bootId = randomUUID();
  const store = new AgentStore(config.databasePath, {
    nodeId: credentials.nodeId,
    bootId,
    defaultOfflineAllowanceBytes: config.offlineAllowanceBytes,
  });
  const xray = new XtlsXrayAdapter(config.xrayApiAddress, config.xrayInboundTag);
  const api = new AgentApiClient({
    baseUrl: config.apiBaseUrl,
    token: credentials.token,
    agentId: credentials.agentId,
    nodeId: credentials.nodeId,
  });

  const runner = new AgentRunner(config, store, api, xray);
  await runner.start();
  console.log(`[node-agent] 已启动，node=${credentials.nodeId} boot=${bootId}`);

  const shutdown = async (signal: string) => {
    console.log(`[node-agent] 收到 ${signal}，正在保存最后计量样本`);
    await runner.stop();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(`[node-agent] 启动失败：${describe(error)}`);
  process.exitCode = 1;
});
