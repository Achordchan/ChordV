import type { ImportNodeInputDto, UpdateNodeInputDto } from "@chordv/shared";
import type { NodeFormState } from "./admin-forms";

export function splitCsv(value: string) {
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
  /** SNIs to borrow, comma-separated; prefilled with the COMPLETE deployed list. */
  serverNamesCsv: string;
  /** Fallback target ("host:port"). Empty derives from the first SNI at build time. */
  dest: string;
  rotateKeys: boolean;
  /**
   * Fields the form does NOT edit, preserved from the CURRENT deployment spec
   * (the last applied ENSURE_INBOUND job's payload — the node record is a
   * LOSSY projection: one serverName, no dest, no tag). Without them the
   * server's normalizeInboundSpec would silently reset every omitted field to
   * its default — e.g. a node deployed with flow: "" would flip to
   * xtls-rprx-vision and cut off every client config already handed out.
   * Omitted entirely on a FIRST deployment so the control-plane defaults
   * apply.
   */
  preserve?: { flow: string; fingerprint: string; spiderX: string; inboundTag?: string };
};

/**
 * ENSURE_INBOUND payload for the R2-B deploy flow. Only what the operator
 * actually decides: the port to listen on, the SNIs to borrow (the complete
 * list — prefilled from the current deployment so an untouched field reissues
 * it unchanged), and the fallback target — left empty it derives from the
 * first SNI, because Reality's target must be able to present a valid
 * certificate for that SNI (a custom SNI with the default microsoft target
 * deploys fine and then fails every handshake). Reissues preserve the deployed
 * flow/fingerprint/spiderX/inboundTag; everything else keeps its control-plane
 * default on a first deployment. The server normalizes and validates the whole
 * spec again.
 */
export function buildInboundDeployPayload(form: InboundDeployFormState): Record<string, unknown> {
  const serverNames = splitCsv(form.serverNamesCsv);
  if (serverNames.length === 0) throw new Error("SNI 不能为空");
  return {
    listenPort: form.listenPort === "" ? 443 : form.listenPort,
    serverNames,
    dest: form.dest.trim() || `${serverNames[0]}:443`,
    rotateKeys: form.rotateKeys === true,
    ...(form.preserve ? {
      flow: form.preserve.flow,
      fingerprint: form.preserve.fingerprint,
      spiderX: form.preserve.spiderX,
      ...(form.preserve.inboundTag ? { inboundTag: form.preserve.inboundTag } : {})
    } : {})
  };
}
