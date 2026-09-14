import { useCallback, useMemo, useRef, useState } from "react";
import type { AnnouncementDto } from "@chordv/shared";
import { isUnauthorizedApiError, markAnnouncementsRead } from "../api/client";
import {
  hasUnreadAnnouncements as computeHasUnreadAnnouncements,
  isForcedAnnouncementPending,
  patchAnnouncementRecord,
  pickForcedAnnouncement,
  pickPassiveAnnouncements,
  isPassiveAnnouncementUnread
} from "../lib/announcementState";

type AnnouncementPatchFn = (updater: (announcements: AnnouncementDto[]) => AnnouncementDto[]) => void;

type NoticeInput = {
  color: "green" | "yellow" | "red" | "blue";
  title: string;
  message: string;
};

type UseAnnouncementsOptions = {
  accessToken: string | null;
  announcements: AnnouncementDto[];
  patchAnnouncements: AnnouncementPatchFn;
  onUnauthorized?: () => Promise<unknown> | unknown;
  readError?: (message: string) => string;
  notify?: (notice: NoticeInput) => void;
};

function defaultReadError(message: string) {
  return message;
}

export function useAnnouncements(options: UseAnnouncementsOptions) {
  const [announcementReadRevision, setAnnouncementReadRevision] = useState(0);
  const latest = useRef(options);
  latest.current = options;
  const seenRequests = useRef(new Map<string, Promise<boolean>>());

  const passiveAnnouncements = useMemo(
    () => pickPassiveAnnouncements(options.announcements),
    [options.announcements]
  );
  const forcedAnnouncement = useMemo(
    () => pickForcedAnnouncement(options.announcements),
    [options.announcements]
  );
  const hasUnreadAnnouncements = useMemo(
    () => computeHasUnreadAnnouncements(options.announcements),
    [options.announcements]
  );

  const patchAnnouncementReadState = useCallback(
    (announcementIds: string[], action: "seen" | "ack") => {
      const touchedAt = new Date().toISOString();
      options.patchAnnouncements((current) =>
        current.map((item) => (announcementIds.includes(item.id) ? patchAnnouncementRecord(item, action, touchedAt) : item))
      );
      setAnnouncementReadRevision((current) => current + 1);
    },
    [options]
  );

  const markAnnouncementSeen = useCallback((id: string): Promise<boolean> => {
    const current = latest.current;
    const token = current.accessToken;
    const item = current.announcements.find((value) => value.id === id);
    if (!token || !item) return Promise.resolve(false);
    // Viewing a forced announcement never acknowledges it.
    if (!isPassiveAnnouncementUnread(item)) return Promise.resolve(true);
    const key = `${token}:${id}`;
    const existing = seenRequests.current.get(key);
    if (existing) return existing;
    const task = (async () => {
      try {
        const result = await markAnnouncementsRead(token, { announcementIds: [id], action: "seen" });
        if (!result.ok || (result.updatedIds && !result.updatedIds.includes(id)) || latest.current.accessToken !== token) return false;
        const touchedAt = new Date().toISOString();
        latest.current.patchAnnouncements((items) => items.map((value) => value.id === id
          ? patchAnnouncementRecord(value, "seen", touchedAt) : value));
        setAnnouncementReadRevision((value) => value + 1);
        return true;
      } catch (reason) {
        if (latest.current.accessToken === token && isUnauthorizedApiError(reason)) await latest.current.onUnauthorized?.();
        return false;
      } finally { seenRequests.current.delete(key); }
    })();
    seenRequests.current.set(key, task);
    return task;
  }, []);

  const acknowledgeAnnouncement = useCallback(
    async (announcement = forcedAnnouncement) => {
      if (!announcement || !options.accessToken) {
        return false;
      }

      try {
        const result = await markAnnouncementsRead(options.accessToken, {
          announcementIds: [announcement.id],
          action: "ack"
        });
        if (!result.ok || (result.updatedIds && !result.updatedIds.includes(announcement.id)) || latest.current.accessToken !== options.accessToken) return false;
        patchAnnouncementReadState([announcement.id], "ack");
        return true;
      } catch (reason) {
        if (isUnauthorizedApiError(reason)) {
          await options.onUnauthorized?.();
          return false;
        }
        options.notify?.({
          color: "red",
          title: "公告状态同步失败",
          message:
            reason instanceof Error
              ? (options.readError ?? defaultReadError)(reason.message)
              : "当前无法保存公告已读状态"
        });
        return false;
      }
    },
    [forcedAnnouncement, options, patchAnnouncementReadState]
  );

  return {
    announcementReadRevision,
    passiveAnnouncements,
    forcedAnnouncement,
    hasUnreadAnnouncements,
    isForcedAnnouncementPending,
    patchAnnouncementReadState,
    markAnnouncementSeen,
    acknowledgeAnnouncement
  };
}
