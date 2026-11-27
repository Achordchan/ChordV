import type { AdminDeletableEntityKind, AdminDeletePreviewDto, AdminDeleteResultDto } from "@chordv/shared";
import { request } from "./base";

const ADMIN_ACTION_TIMEOUT_MS = 60 * 1000;

const KIND_PATH: Record<AdminDeletableEntityKind, string> = {
  user: "users",
  plan: "plans",
  subscription: "subscriptions",
  team: "teams"
};

export function fetchDeletePreview(kind: AdminDeletableEntityKind, id: string) {
  return request<AdminDeletePreviewDto>(`/admin/${KIND_PATH[kind]}/${encodeURIComponent(id)}/delete-preview`, {
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function deleteAdminEntity(kind: AdminDeletableEntityKind, id: string, force: boolean) {
  return request<AdminDeleteResultDto>(`/admin/${KIND_PATH[kind]}/${encodeURIComponent(id)}${force ? "?force=1" : ""}`, {
    method: "DELETE",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}
