import { useCallback, useMemo, useState } from "react";
import type { AnnouncementDto } from "@chordv/shared";
import { isUnauthorizedApiError, markAnnouncementsRead } from "../api/client";
import {
  hasUnreadAnnouncements as computeHasUnreadAnnouncements,
  isForcedAnnouncementPending,
  patchAnnouncementRecord,
  pickForcedAnnouncement,
  pickPassiveAnnouncements,
  pickUnreadPassiveAnnouncementIds
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

  const markPassiveAnnouncementsSeen = useCallback(async () => {
    if (!options.accessToken) {
      return false;
    }
    const unreadIds = pickUnreadPassiveAnnouncementIds(passiveAnnouncements);
    if (unreadIds.length === 0) {
      return true;
    }

    try {
      await markAnnouncementsRead(options.accessToken, {
        announcementIds: unreadIds,
        action: "seen"
      });
      patchAnnouncementReadState(unreadIds, "seen");
      return true;
    } catch (reason) {
      if (isUnauthorizedApiError(reason)) {
        await options.onUnauthorized?.();
      }
      return false;
    }
  }, [options, passiveAnnouncements, patchAnnouncementReadState]);

  const acknowledgeAnnouncement = useCallback(
    async (announcement = forcedAnnouncement) => {
      if (!announcement || !options.accessToken) {
        return false;
      }

      try {
        await markAnnouncementsRead(options.accessToken, {
          announcementIds: [announcement.id],
          action: "ack"
        });
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
    markPassiveAnnouncementsSeen,
    acknowledgeAnnouncement
  };
}
