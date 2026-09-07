/** Registration alone does not make the R1 placeholder endpoint usable by clients. */
export type NodeOnboardingRuntime = {
  registrationStatus?: string | null;
  protocol?: string;
  security?: string;
  serverHost?: string;
  serverPort?: number;
  uuid?: string;
  realityPublicKey?: string;
  serverName?: string;
  fingerprint?: string;
};

export function isNodeOnboardingReady(node: NodeOnboardingRuntime): boolean {
  // Explicit placeholders are never usable, even on an inconsistent legacy row.
  const host = node.serverHost?.trim();
  if (host !== undefined && (!host || host.toLowerCase() === "pending-agent")) return false;
  if (node.serverPort !== undefined && (!Number.isInteger(node.serverPort) || node.serverPort <= 0 || node.serverPort > 65535)) return false;
  // Imported/panel nodes retain their established protocol-parameter validation.
  if (node.registrationStatus == null) return true;
  if (node.registrationStatus !== "agent_ready") return false;
  return node.protocol === "vless" && node.security === "reality" &&
    Boolean(node.serverHost?.trim()) && node.serverHost!.trim().toLowerCase() !== "pending-agent" &&
    Number.isInteger(node.serverPort) && node.serverPort! > 0 && node.serverPort! <= 65535 &&
    Boolean(node.uuid?.trim() && node.realityPublicKey?.trim() && node.serverName?.trim() && node.fingerprint?.trim());
}
