export type PrimaryBusyAction = "connect" | "disconnect" | null;
export type PrimaryFillPhase = "idle" | "connecting" | "completing" | "disconnecting" | "releasing";

// Connecting has no real percentage: state only picks the phase, CSS drives the fill.
export function resolvePrimaryFillPhase(status: string, busyAction: PrimaryBusyAction): Exclude<PrimaryFillPhase, "completing" | "releasing"> {
  if (status === "disconnecting" || busyAction === "disconnect") return "disconnecting";
  if (status === "connecting" || (busyAction === "connect" && status !== "connected")) return "connecting";
  return "idle";
}

// Only a connect that actually reached "connected" sweeps to 100%; failure or
// cancel drops straight back to the idle button.
export function shouldCompleteFill(previous: PrimaryFillPhase, next: PrimaryFillPhase, status: string) {
  return previous === "connecting" && next === "idle" && status === "connected";
}

// Disconnecting is real work (stop the core, restore the system proxy, confirm the stop, refresh state)
// that often finishes in a few hundred milliseconds, so the drain would be cut off mid-way. Only a
// disconnect that actually ended idle sweeps the rest of the bar away; a failed stop drops back as is.
export function shouldReleaseFill(previous: PrimaryFillPhase, next: PrimaryFillPhase, status: string) {
  return previous === "disconnecting" && next === "idle" && status === "idle";
}

// Matches the cv-connect-complete sweep in styles.css.
export const PRIMARY_FILL_COMPLETE_MS = 320;
// Matches the cv-disconnect-release sweep in styles.css.
export const PRIMARY_FILL_RELEASE_MS = 320;
