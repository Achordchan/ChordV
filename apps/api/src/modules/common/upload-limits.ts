export const DEFAULT_RELEASE_ARTIFACT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_SUPPORT_TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const RELEASE_ARTIFACT_MAX_UPLOAD_BYTES = readPositiveIntegerEnv(
  "CHORDV_RELEASE_MAX_UPLOAD_BYTES",
  DEFAULT_RELEASE_ARTIFACT_MAX_UPLOAD_BYTES
);

export const SUPPORT_TICKET_ATTACHMENT_MAX_BYTES = readPositiveIntegerEnv(
  "CHORDV_SUPPORT_TICKET_ATTACHMENT_MAX_BYTES",
  DEFAULT_SUPPORT_TICKET_ATTACHMENT_MAX_BYTES
);

export function getAdminUploadLimits() {
  return {
    releaseArtifactMaxBytes: RELEASE_ARTIFACT_MAX_UPLOAD_BYTES,
    runtimeComponentMaxBytes: RELEASE_ARTIFACT_MAX_UPLOAD_BYTES,
    supportTicketAttachmentMaxBytes: SUPPORT_TICKET_ATTACHMENT_MAX_BYTES
  };
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}
