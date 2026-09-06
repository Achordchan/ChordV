export type NodeControlModeValue = "xui_primary" | "shadow_direct" | "direct_primary" | "rollback_pending";

export function usesXuiMetering(mode: NodeControlModeValue | null | undefined) {
  return mode === undefined || mode === null || mode === "xui_primary" || mode === "shadow_direct";
}

export function usesAgentShadowMetering(mode: NodeControlModeValue | null | undefined) {
  return mode === "shadow_direct";
}

export function usesAgentPrimaryMetering(mode: NodeControlModeValue | null | undefined) {
  return mode === "direct_primary";
}

export function usesAgentControl(mode: NodeControlModeValue | null | undefined) {
  return mode === "direct_primary";
}

export function canServeManagedClients(mode: NodeControlModeValue | null | undefined, panelEnabled: boolean) {
  if (mode === "rollback_pending") return false;
  return usesAgentPrimaryMetering(mode) || panelEnabled;
}
