import type { AdminAnnouncementRecordDto, CreateAnnouncementInputDto, UpdateAnnouncementInputDto } from "@chordv/shared";
import { request } from "./base";

export function createAnnouncement(input: CreateAnnouncementInputDto) {
  return request<AdminAnnouncementRecordDto>("/admin/announcements", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateAnnouncement(announcementId: string, input: UpdateAnnouncementInputDto) {
  return request<AdminAnnouncementRecordDto>(`/admin/announcements/${announcementId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}
