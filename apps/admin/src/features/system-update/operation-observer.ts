import type { SystemUpdateOperationDto } from "@chordv/shared";

export type UpdateConnection = "connecting" | "live" | "reconnecting" | "paused";
export function isTerminal(operation: SystemUpdateOperationDto) {
  return ["succeeded", "failed", "rolled_back"].includes(operation.status);
}

export function parseOperationEvents(buffer: string, consume: (operation: SystemUpdateOperationDto | null) => void) {
  const chunks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const remaining = chunks.pop() ?? "";
  for (const chunk of chunks) {
    const data = chunk.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    const parsed = JSON.parse(data);
    if (Object.prototype.hasOwnProperty.call(parsed, "operation")) consume(parsed.operation);
  }
  return remaining;
}

/** SSE is primary. Only an explicit 404 from a rolled-back older backend uses
 * its legacy status endpoint. Neither transport failure nor elapsed time can
 * turn an operation into success/failure or unlock mutating controls. */
export function observeSystemOperation(operationId: string, options: {
  stream: (signal: AbortSignal) => Promise<Response>;
  snapshot: (signal: AbortSignal) => Promise<SystemUpdateOperationDto | null>;
  onOperation: (operation: SystemUpdateOperationDto) => void;
  onConnection: (state: UpdateConnection) => void;
  onError?: (message: string) => void;
  initialDelay?: number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}) {
  const timers = options.timers ?? { set: globalThis.setTimeout.bind(globalThis), clear: globalThis.clearTimeout.bind(globalThis) };
  let stopped = false, legacy = false, delay = 3000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    timers.clear(watchdog);
    watchdog = timers.set(() => controller?.abort(new Error("更新状态连接超时")), 30_000);
  };
  const schedule = (ms: number) => {
    if (!stopped) timer = timers.set(() => void connect(), ms);
  };
  const consume = (operation: SystemUpdateOperationDto | null) => {
    if (stopped || !operation) return;
    if (operation.operationId !== operationId) throw new Error("更新状态与当前任务不一致");
    delay = 3000; options.onConnection("live"); options.onOperation(operation);
    if (isTerminal(operation)) { stopped = true; controller?.abort(); timers.clear(timer); }
  };
  const connect = async () => {
    if (stopped) return;
    controller = new AbortController(); armWatchdog();
    try {
      if (legacy) {
        const operation = await options.snapshot(controller.signal);
        if (!operation) throw new Error("暂未确认更新状态");
        consume(operation);
      } else {
        const response = await options.stream(controller.signal);
        if (response.status === 404) {
          await response.body?.cancel(); legacy = true;
          timers.clear(watchdog); schedule(0); return;
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel(); stopped = true; options.onConnection("paused");
          options.onError?.("当前登录状态无法读取更新任务，请重新登录。"); return;
        }
        if (!response.ok || !response.body) throw new Error(`更新状态 HTTP ${response.status}`);
        options.onConnection("live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder(); let buffer = "";
        try {
          while (!stopped) {
            const part = await reader.read();
            if (stopped || part.done) break;
            armWatchdog(); buffer += decoder.decode(part.value, { stream: true });
            if (buffer.length > 1024 * 1024) throw new Error("更新状态响应过大");
            buffer = parseOperationEvents(buffer, consume);
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        if (!stopped) throw new Error("更新状态连接中断");
      }
    } catch {
      if (!stopped) { options.onConnection("reconnecting"); delay = Math.min(delay * 2, 30_000); }
    } finally { timers.clear(watchdog); }
    if (!stopped) schedule(delay);
  };
  options.onConnection("connecting"); schedule(options.initialDelay ?? 0);
  return () => { stopped = true; timers.clear(timer); timers.clear(watchdog); controller?.abort(); };
}
