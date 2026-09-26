import type { SystemUpdateOperationDto } from "@chordv/shared";
import type { RestartWait } from "./operation-presentation";

const COMPLETION_KEY = "chordv:system-update:completion";
export type UpdateCompletion = { operationId: string; kind: SystemUpdateOperationDto["kind"]; status: SystemUpdateOperationDto["status"]; version: string; migrationApplied: boolean; at: number };
export function readCompletion(): UpdateCompletion | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(COMPLETION_KEY) ?? "null");
    return value && typeof value.version === "string" && typeof value.operationId === "string" &&
      ["succeeded", "rolled_back"].includes(value.status) && Date.now() - value.at < 30 * 60_000 ? value : null;
  } catch { return null; }
}
export function clearCompletion() { try { sessionStorage.removeItem(COMPLETION_KEY); } catch { /* storage may be disabled */ } }
export function saveCompletion(value: UpdateCompletion) { try { sessionStorage.setItem(COMPLETION_KEY, JSON.stringify(value)); } catch { /* reload remains safe */ } }

// An expected restart survives a page reload (manual or otherwise): the new page
// resumes observing the operation and keeps the waiting view instead of greeting
// the operator with "cannot reach backend" while the API is still coming back.
const RESTART_KEY = "chordv:system-update:restart";
export function readRestartWait(now = Date.now()): RestartWait | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(RESTART_KEY) ?? "null");
    return value && typeof value.operationId === "string" && ["update", "rollback", "restart"].includes(value.kind) &&
      (value.toVersion === null || typeof value.toVersion === "string") && typeof value.since === "number" &&
      now - value.since >= 0 && now - value.since < 30 * 60_000 ? value : null;
  } catch { return null; }
}
export function saveRestartWait(value: RestartWait) { try { sessionStorage.setItem(RESTART_KEY, JSON.stringify(value)); } catch { /* in-memory state still works */ } }
export function clearRestartWait() { try { sessionStorage.removeItem(RESTART_KEY); } catch { /* storage may be disabled */ } }

export function htmlVersion(html: string) {
  return new DOMParser().parseFromString(html, "text/html").querySelector<HTMLMetaElement>('meta[name="chordv-backend-version"]')?.content ?? null;
}

/** Build stamp of the document currently displayed (null when unstamped). */
export function currentPageVersion() {
  return typeof document === "undefined" ? null
    : document.querySelector<HTMLMetaElement>('meta[name="chordv-backend-version"]')?.content ?? null;
}

/** The API can become ready before nginx observes its new webroot. Only reload
 * after the HTML's build stamp matches the confirmed running version. This is
 * a bounded static-resource readiness check, not operation status polling. */
export async function waitForUpdatedPage(version: string, signal: AbortSignal, probe = async () => {
  const response = await fetch(window.location.href, { cache: "no-store", credentials: "same-origin", headers: { Accept: "text/html" }, signal });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return undefined;
  return htmlVersion(await response.text());
}, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (signal.aborted) return false;
    try {
      const found = await probe();
      if (signal.aborted) return false;
      if (found === version) return true;
      // An unstamped document may be the previous release while nginx switches
      // webroots. Retry within the same bound; only a matching stamp permits reload.
    } catch { if (signal.aborted) return false; }
    if (attempt < 9) await sleep(1000);
  }
  return false;
}

export function completionWarning(completion: UpdateCompletion): string | null {
  return completion.status === "rolled_back" && completion.migrationApplied
    ? "数据库迁移未回滚，请人工核对数据库与恢复版本的兼容性。" : null;
}
