import type {
  AgentCommand,
  AgentConfigSnapshot,
  AgentHeartbeat,
  CommandResult,
  UsageBatch,
  UsageBatchAck,
} from './types.js';

interface ApiClientOptions { baseUrl: string; token: string; agentId: string; nodeId: string }

export class AgentApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
        'x-chordv-agent-id': this.options.agentId,
        'x-chordv-node-id': this.options.nodeId,
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Agent API ${path} 返回 HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  getConfig(): Promise<AgentConfigSnapshot> { return this.request('/api/agent/v1/config'); }

  heartbeat(payload: AgentHeartbeat): Promise<{ accepted: boolean; ackThrough: string; configRevision: string }> {
    return this.request('/api/agent/v1/heartbeat', { method: 'POST', body: JSON.stringify(payload) });
  }

  uploadBatch(batch: UsageBatch): Promise<UsageBatchAck> {
    return this.request('/api/agent/v1/usage-batches', { method: 'POST', body: JSON.stringify(batch) });
  }

  reportCommandResult(result: CommandResult): Promise<{ accepted: boolean }> {
    const { commandId, ...body } = result;
    return this.request(`/api/agent/v1/commands/${encodeURIComponent(commandId)}/result`, {
      method: 'POST', body: JSON.stringify(body),
    });
  }

  async consumeEvents(onCommand: (command: AgentCommand) => Promise<void>, signal: AbortSignal): Promise<void> {
    const response = await fetch(`${this.options.baseUrl}/api/agent/v1/events`, {
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${this.options.token}`,
        'x-chordv-agent-id': this.options.agentId,
        'x-chordv-node-id': this.options.nodeId,
      },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Agent SSE 返回 HTTP ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer = (buffer + value).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const command = parseSseFrame(frame);
        if (command) await onCommand(command);
      }
    }
  }
}

export function parseSseFrame(frame: string): AgentCommand | null {
  const lines = frame.replace(/\r/g, '').split('\n');
  const eventType = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
  if (eventType === 'keepalive') return null;
  const data = lines.filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart()).join('\n');
  if (!data) return null;
  const parsed = JSON.parse(data) as Partial<AgentCommand>;
  if (!parsed.commandId || !parsed.type || !parsed.targetRevision || !parsed.payload) return null;
  return parsed as AgentCommand;
}
