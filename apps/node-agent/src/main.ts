import { randomUUID } from 'node:crypto';
import { AgentApiClient } from './api-client.js';
import { loadConfig } from './config.js';
import { AgentRunner } from './runner.js';
import { AgentStore } from './store.js';
import { XtlsXrayAdapter } from './xray-adapter.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const bootId = randomUUID();
  const store = new AgentStore(config.databasePath, {
    nodeId: config.nodeId,
    bootId,
    defaultOfflineAllowanceBytes: config.offlineAllowanceBytes,
  });
  const xray = new XtlsXrayAdapter(config.xrayApiAddress, config.xrayInboundTag);
  const api = new AgentApiClient({
    baseUrl: config.apiBaseUrl,
    token: config.token,
    agentId: config.agentId,
    nodeId: config.nodeId,
  });

  if (process.argv.includes('--health')) {
    await xray.health();
    console.log(JSON.stringify({ ok: true, ...store.healthSnapshot() }));
    store.close();
    return;
  }

  const runner = new AgentRunner(config, store, api, xray);
  await runner.start();
  console.log(`[node-agent] 已启动，node=${config.nodeId} boot=${bootId}`);

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
  console.error(`[node-agent] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
