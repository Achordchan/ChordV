import type { RuntimeStatus } from "./runtime";

export const COMPONENT_CHECK_INTERVAL_MS = 12 * 60 * 60_000;
export const COMPONENT_CHECK_THROTTLE_MS = 30_000;
export const COMPONENT_CHECK_RETRY_BASE_MS = 5 * 60_000;
export const COMPONENT_CHECK_RETRY_MAX_MS = 60 * 60_000;

export function componentRuntimeInUse(status: RuntimeStatus) {
  return Boolean(status.activePid || status.activeSessionId || status.tunName)
    || ["connected", "connecting", "starting", "disconnecting"].includes(status.status);
}

type Context = { accessToken: string | null; platform: string; enabled: boolean; blocked: boolean; inUse: boolean; visible: boolean };
export type ComponentSyncState = { syncError: string | null; deferred: boolean };
type Dependencies = {
  context: () => Context;
  configured: () => boolean;
  loadStatus: () => Promise<RuntimeStatus>;
  onStatus: (status: RuntimeStatus) => void;
  ensure: () => Promise<boolean>;
  onState: (state: ComponentSyncState) => void;
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/** GitHub 渠道没有客户端推送；仅在可见、空闲且有会话时用一个可取消计时器低频检查。 */
export function createComponentSyncLoop(deps: Dependencies) {
  let stopped = false, running = false, pending = false;
  let identity = "", epoch = 0, failures = 0;
  let retryAt = 0, nextAllowedAt = 0, nextPeriodicAt = 0;
  let timer: unknown = null, syncError: string | null = null;
  let previous: ComponentSyncState = { syncError: null, deferred: false };
  const supported = (context: Context) => Boolean(context.accessToken && ["macos", "windows"].includes(context.platform));
  const clearTimer = () => {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
  };
  const emit = () => {
    if (stopped) return;
    const context = deps.context();
    const next = { syncError, deferred: Boolean(pending && context.inUse && supported(context) && deps.configured()) };
    if (previous.syncError !== next.syncError || previous.deferred !== next.deferred) {
      previous = next; deps.onState(next);
    }
  };
  const current = (generation: number) => {
    const context = deps.context();
    return !stopped && generation === epoch && supported(context) && identity === `${context.accessToken ?? ""}:${context.platform}`;
  };
  const canRead = (context: Context) => supported(context) && context.enabled && !context.blocked && !context.inUse && context.visible;

  const arm = () => {
    clearTimer();
    if (stopped || running || !canRead(deps.context()) || !deps.configured()) { emit(); return; }
    const due = pending ? Math.max(deps.now(), nextAllowedAt, retryAt) : Math.max(nextPeriodicAt, nextAllowedAt, retryAt);
    timer = deps.setTimeout(() => { timer = null; void check(); }, Math.max(0, due - deps.now()));
    emit();
  };
  const failure = (message: string) => {
    failures = Math.min(failures + 1, 5);
    retryAt = deps.now() + Math.min(COMPONENT_CHECK_RETRY_BASE_MS * 2 ** (failures - 1), COMPONENT_CHECK_RETRY_MAX_MS);
    pending = true; syncError = message;
  };
  const check = async () => {
    if (stopped || running || !canRead(deps.context()) || !deps.configured()) { arm(); return; }
    const generation = epoch;
    running = true; pending = false;
    nextAllowedAt = deps.now() + COMPONENT_CHECK_THROTTLE_MS;
    emit();
    try {
      const native = await deps.loadStatus();
      if (!current(generation)) return;
      if (componentRuntimeInUse(native)) { pending = true; deps.onStatus(native); return; }
      if (!canRead(deps.context())) { pending = true; return; }
      if (!deps.configured()) { pending = false; syncError = null; return; }
      const success = await deps.ensure();
      if (!current(generation)) return;
      if (!deps.configured()) { pending = false; syncError = null; return; }
      if (success) {
        failures = 0; retryAt = 0; syncError = null;
        nextPeriodicAt = deps.now() + COMPONENT_CHECK_INTERVAL_MS;
      } else failure("组件暂未同步，可在更新中心查看原因并重试。");
    } catch {
      if (current(generation)) {
        if (deps.configured()) failure("暂时无法检查组件，可在更新中心重试。");
        else { pending = false; syncError = null; }
      }
    } finally { running = false; arm(); }
  };
  const update = () => {
    if (stopped) return;
    const context = deps.context(), nextIdentity = `${context.accessToken ?? ""}:${context.platform}`;
    if (identity !== nextIdentity) {
      identity = nextIdentity; epoch++; failures = 0; retryAt = 0; nextAllowedAt = 0;
      nextPeriodicAt = deps.now() + COMPONENT_CHECK_INTERVAL_MS;
      pending = supported(context) && deps.configured(); syncError = null;
    }
    if (!supported(context) || !deps.configured()) { pending = false; syncError = null; failures = 0; retryAt = 0; }
    arm();
  };
  return {
    update,
    request() {
      if (stopped) return;
      update();
      if (!supported(deps.context()) || !deps.configured()) return;
      pending = true; arm();
    },
    manualSuccess() {
      if (stopped) return;
      epoch++; pending = false; failures = 0; retryAt = 0; syncError = null;
      nextAllowedAt = deps.now() + COMPONENT_CHECK_THROTTLE_MS;
      nextPeriodicAt = deps.now() + COMPONENT_CHECK_INTERVAL_MS;
      arm();
    },
    stop() { if (stopped) return; stopped = true; epoch++; pending = false; clearTimer(); }
  };
}
