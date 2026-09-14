import type { ClientUpdateCheckResult } from "../api/client";

export type UpdateCheckStatus = "idle" | "checking" | "ready" | "failed";
export type UpdateCheckState = { status: UpdateCheckStatus; result: ClientUpdateCheckResult | null };
export type UpdateCheckEvent = { type: "checking" | "failed" | "reset" } | { type: "confirmed"; result: ClientUpdateCheckResult | null };

export const initialUpdateCheckState: UpdateCheckState = { status: "idle", result: null };

// Pending and failed requests retain only previously confirmed policy. Bootstrap
// compatibility data must never become policy before the update endpoint replies.
export function reduceUpdateCheckState(state: UpdateCheckState, event: UpdateCheckEvent): UpdateCheckState {
  switch (event.type) {
    case "checking": return { ...state, status: "checking" };
    case "failed": return { ...state, status: "failed" };
    case "confirmed": return { status: "ready", result: event.result };
    case "reset": return initialUpdateCheckState;
  }
}
