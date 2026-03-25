import type { AnnouncementDto } from "@chordv/shared";

type LegacyAnnouncementState = {
  seenAt?: string | null;
  isSeen?: boolean;
  isAcknowledged?: boolean;
  readState?: {
    passiveSeenAt?: string | null;
    seenAt?: string | null;
    acknowledgedAt?: string | null;
    isSeen?: boolean;
    isAcknowledged?: boolean;
  } | null;
};

type PatchedAnnouncement = AnnouncementDto & LegacyAnnouncementState;

export function patchAnnouncementRecord(
  item: AnnouncementDto,
  action: "seen" | "ack",
  touchedAt: string
): AnnouncementDto {
  const current = item as PatchedAnnouncement;
  const nextPassiveSeenAt =
    action === "seen"
      ? touchedAt
      : (current.passiveSeenAt ?? current.readState?.passiveSeenAt ?? current.readState?.seenAt ?? current.seenAt ?? null);
  const nextAcknowledgedAt =
    action === "ack" ? touchedAt : (current.acknowledgedAt ?? current.readState?.acknowledgedAt ?? null);
  const nextReadState = {
    ...(current.readState ?? {}),
    passiveSeenAt: nextPassiveSeenAt,
    seenAt: nextPassiveSeenAt,
    acknowledgedAt: nextAcknowledgedAt,
    isSeen: Boolean(nextPassiveSeenAt),
    isAcknowledged: action === "ack" ? true : (current.readState?.isAcknowledged ?? current.isAcknowledged ?? false)
  };

  return {
    ...current,
    passiveSeenAt: nextPassiveSeenAt,
    acknowledgedAt: nextReadState.acknowledgedAt,
    isUnread: action === "ack" || current.displayMode === "passive" ? false : current.isUnread,
    seenAt: nextReadState.seenAt,
    isSeen: nextReadState.isSeen,
    isAcknowledged: nextReadState.isAcknowledged,
    readState: nextReadState
  } as AnnouncementDto;
}

export function isPassiveAnnouncementUnread(item: AnnouncementDto) {
  const current = item as PatchedAnnouncement;
  if (typeof current.isUnread === "boolean") {
    return current.displayMode === "passive" ? current.isUnread : false;
  }
  if (Boolean(current.passiveSeenAt ?? current.readState?.passiveSeenAt)) {
    return false;
  }
  if (current.readState?.isSeen === true || Boolean(current.readState?.seenAt)) {
    return false;
  }
  if (current.isSeen === true || Boolean(current.seenAt)) {
    return false;
  }
  return current.displayMode === "passive";
}

export function isForcedAnnouncementPending(item: AnnouncementDto) {
  const current = item as PatchedAnnouncement;
  if (current.displayMode === "passive") {
    return false;
  }
  if (typeof current.isUnread === "boolean") {
    return current.isUnread;
  }
  if (current.readState?.isAcknowledged === true || Boolean(current.readState?.acknowledgedAt)) {
    return false;
  }
  if (current.isAcknowledged === true || Boolean(current.acknowledgedAt)) {
    return false;
  }
  return true;
}

export function pickForcedAnnouncement(announcements: AnnouncementDto[]) {
  return announcements.find((item) => isForcedAnnouncementPending(item)) ?? null;
}

export function pickPassiveAnnouncements(announcements: AnnouncementDto[]) {
  return announcements.filter((item) => item.displayMode === "passive");
}

export function pickUnreadPassiveAnnouncementIds(announcements: AnnouncementDto[]) {
  return announcements.filter((item) => isPassiveAnnouncementUnread(item)).map((item) => item.id);
}

export function hasUnreadAnnouncements(announcements: AnnouncementDto[]) {
  return announcements.some((item) =>
    item.displayMode === "passive" ? isPassiveAnnouncementUnread(item) : isForcedAnnouncementPending(item)
  );
}
