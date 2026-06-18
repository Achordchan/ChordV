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
    panelPassword: nodeForm.panelPassword || null,
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
