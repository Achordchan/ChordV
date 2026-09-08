import type { ImportNodeInputDto, UpdateNodeInputDto } from "@chordv/shared";
import type { NodeFormState } from "./admin-forms";

function splitCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildUpdateNodePayload(nodeForm: NodeFormState): UpdateNodeInputDto {
  const subscriptionUrl = nodeForm.subscriptionUrl.trim();
  return {
    subscriptionUrl: subscriptionUrl || null,
    name: nodeForm.name || undefined,
    countryCode: nodeForm.countryCode || undefined,
    region: nodeForm.region || undefined,
    provider: nodeForm.provider || undefined,
    tags: splitCsv(nodeForm.tags),
    isActive: nodeForm.isActive,
    recommended: nodeForm.recommended,
    panelBaseUrl: nodeForm.panelBaseUrl || null,
    panelApiBasePath: nodeForm.panelApiBasePath || null,
    panelUsername: nodeForm.panelUsername || null,
    panelPassword: nodeForm.panelPassword.trim() ? nodeForm.panelPassword : undefined,
    panelInboundId: Number(nodeForm.panelInboundId) || null,
    panelEnabled: nodeForm.panelEnabled
  };
}

export function buildImportNodePayload(nodeForm: NodeFormState): ImportNodeInputDto {
  const updatePayload = buildUpdateNodePayload(nodeForm);
  return {
    ...updatePayload,
    subscriptionUrl: nodeForm.subscriptionUrl.trim() || undefined,
    panelBaseUrl: updatePayload.panelBaseUrl ?? undefined,
    panelApiBasePath: updatePayload.panelApiBasePath ?? undefined,
    panelUsername: updatePayload.panelUsername ?? undefined,
    panelPassword: updatePayload.panelPassword ?? undefined,
    panelInboundId: updatePayload.panelInboundId ?? undefined
  };
}

export type InboundDeployFormState = {
  listenPort: number | "";
  serverName: string;
  rotateKeys: boolean;
};

/**
 * ENSURE_INBOUND payload for the R2-B deploy flow. Only what the operator
 * actually decides: the port to listen on and the SNI to borrow. Everything
 * else (dest, flow, fingerprint, spiderX, inboundTag) keeps its control-plane
 * default — the server normalizes and validates the whole spec again anyway,
 * and a mismatched pair like a custom SNI with the default fallback target is
 * a camouflage concern, not a correctness one.
 */
export function buildInboundDeployPayload(form: InboundDeployFormState): Record<string, unknown> {
  return {
    listenPort: form.listenPort === "" ? 443 : form.listenPort,
    serverNames: [form.serverName.trim()],
    rotateKeys: form.rotateKeys === true
  };
}
