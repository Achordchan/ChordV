import { invoke } from "@tauri-apps/api/core";
import { detectRuntimePlatform } from "./runtime";

let revision = 0;
let pending: Promise<void> = Promise.resolve();

export function cancelDesktopWindowResize() { revision += 1; }

/** One native transition per state change; superseded queued requests are dropped. */
export function resizeDesktopWindow(signedIn: boolean, animate = true): Promise<void> {
  if (!["macos", "windows"].includes(detectRuntimePlatform())) return Promise.resolve();
  const request = ++revision;
  const task = pending.catch(() => undefined).then(async () => {
    if (request !== revision) return;
    await invoke("transition_main_window", {
      signedIn,
      animate: animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    });
  });
  pending = task;
  return task;
}
