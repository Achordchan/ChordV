import type { SystemUpdateOperationDto } from "@chordv/shared";

const COMPLETION_KEY = "chordv:system-update:completion";
export type UpdateCompletion = { operationId: string; kind: SystemUpdateOperationDto["kind"]; status: SystemUpdateOperationDto["status"]; version: string; at: number };
export function readCompletion(): UpdateCompletion | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(COMPLETION_KEY) ?? "null");
    return value && typeof value.version === "string" && typeof value.operationId === "string" &&
      ["succeeded", "rolled_back"].includes(value.status) && Date.now() - value.at < 30 * 60_000 ? value : null;
  } catch { return null; }
}
export function clearCompletion() { try { sessionStorage.removeItem(COMPLETION_KEY); } catch { /* storage may be disabled */ } }
export function saveCompletion(value: UpdateCompletion) { try { sessionStorage.setItem(COMPLETION_KEY, JSON.stringify(value)); } catch { /* reload remains safe */ } }

export function htmlVersion(html: string) {
  return new DOMParser().parseFromString(html, "text/html").querySelector<HTMLMetaElement>('meta[name="chordv-backend-version"]')?.content ?? null;
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
      // Older rollback targets do not carry a stamp; require an explicit reload
      // rather than claiming the old document is confirmed to be the target.
      if (found === null) return false;
    } catch { if (signal.aborted) return false; }
    if (attempt < 9) await sleep(1000);
  }
  return false;
}
