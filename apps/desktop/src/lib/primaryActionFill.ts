export type PrimaryBusyAction = "connect" | "disconnect" | null;
export type PrimaryFillPhase = "idle" | "connecting" | "completing" | "disconnecting";

// Connecting has no real percentage: state only picks the phase, CSS drives the fill.
export function resolvePrimaryFillPhase(status: string, busyAction: PrimaryBusyAction): Exclude<PrimaryFillPhase, "completing"> {
  if (status === "disconnecting" || busyAction === "disconnect") return "disconnecting";
  if (status === "connecting" || (busyAction === "connect" && status !== "connected")) return "connecting";
  return "idle";
}

// Only a connect that actually reached "connected" sweeps to 100%; failure or
// cancel drops straight back to the idle button.
export function shouldCompleteFill(previous: PrimaryFillPhase, next: PrimaryFillPhase, status: string) {
  return previous === "connecting" && next === "idle" && status === "connected";
}

// Matches the cv-connect-complete sweep in styles.css.
export const PRIMARY_FILL_COMPLETE_MS = 320;
