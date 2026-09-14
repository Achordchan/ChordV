/** An empty node list means revocation only after authenticated bootstrap completes. */
export function shouldReportNodeAccessRevoked(input: {
  booting: boolean;
  sessionReady: boolean;
  bootstrapReady: boolean;
  activeNodeId: string;
  nodes: ReadonlyArray<{ id: string }>;
}): boolean {
  return !input.booting && input.sessionReady && input.bootstrapReady
    && !input.nodes.some((node) => node.id === input.activeNodeId);
}
