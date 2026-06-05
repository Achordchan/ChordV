import type { AdminAnnouncementRecordDto, CreateAnnouncementInputDto, UpdateAnnouncementInputDto } from "@chordv/shared";
import { request } from "./base";

const ADMIN_ACTION_TIMEOUT_MS = 60 * 1000;
const ADMIN_READ_TIMEOUT_MS = 60 * 1000;

export function fetchAdminAnnouncements() {
  return request<AdminAnnouncementRecordDto[]>("/admin/announcements", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function createAnnouncement(input: CreateAnnouncementInputDto) {
  return request<AdminAnnouncementRecordDto>("/admin/announcements", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function updateAnnouncement(announcementId: string, input: UpdateAnnouncementInputDto) {
  return request<AdminAnnouncementRecordDto>(`/admin/announcements/${announcementId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function deleteAnnouncement(announcementId: string) {
  return request<{ ok: boolean; announcementId: string }>(`/admin/announcements/${announcementId}`, {
    method: "DELETE",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}
