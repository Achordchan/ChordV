import { invokeNative as invoke } from "./nativeBridge";
import { detectRuntimePlatform } from "./runtime";

let revision = 0;
let pending: Promise<boolean> = Promise.resolve(true);

export function cancelDesktopWindowResize() { revision += 1; }

/** One native transition per state change; superseded queued requests are dropped. */
export function resizeDesktopWindow(signedIn: boolean, animate = true): Promise<boolean> {
  if (!["macos", "windows"].includes(detectRuntimePlatform())) return Promise.resolve(true);
  const request = ++revision;
  const task = pending.catch(() => false).then(async () => {
    if (request !== revision) return false;
    await invoke("transition_main_window", {
      signedIn,
      animate: animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    });
    return request === revision;
  });
  pending = task;
  return task;
}
