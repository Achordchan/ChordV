import assert from "node:assert/strict";
import type { AnnouncementDto } from "@chordv/shared";
import {
  hasUnreadAnnouncements,
  isPassiveAnnouncementUnread,
  isForcedAnnouncementPending,
  patchAnnouncementRecord,
  sortAnnouncementsForReading,
  pickForcedAnnouncement,
  pickUnreadForcedAnnouncementIds
} from "../src/lib/announcementState";

function createAnnouncement(input: Partial<AnnouncementDto> & Pick<AnnouncementDto, "id" | "publishedAt">): AnnouncementDto {
  return {
    title: input.id,
    body: "body",
    level: "info",
    displayMode: "modal_confirm",
    countdownSeconds: 0,
    passiveSeenAt: null,
    acknowledgedAt: null,
    isUnread: true,
    ...input
  };
}

function testOnlyLatestForcedAnnouncementAutoPrompts() {
  const older = createAnnouncement({
    id: "announcement_older",
    publishedAt: "2026-05-01T00:00:00.000Z"
  });
  const latest = createAnnouncement({
    id: "announcement_latest",
    publishedAt: "2026-06-01T00:00:00.000Z"
  });

  assert.equal(pickForcedAnnouncement([older, latest])?.id, "announcement_latest");
}

function testAcknowledgedLatestDoesNotCascadeToHistoricalForcedAnnouncement() {
  const older = createAnnouncement({
    id: "announcement_older",
    publishedAt: "2026-05-01T00:00:00.000Z"
  });
  const latest = createAnnouncement({
    id: "announcement_latest",
    publishedAt: "2026-06-01T00:00:00.000Z",
    acknowledgedAt: "2026-06-02T00:00:00.000Z",
    isUnread: false
  });

  assert.equal(pickForcedAnnouncement([older, latest]), null);
  assert.equal(hasUnreadAnnouncements([older, latest]), true);
  assert.deepEqual(pickUnreadForcedAnnouncementIds([older, latest]), ["announcement_older"]);
}

function testReadingOnlyTouchesSelectedPassiveAnnouncement() {
  const passive = createAnnouncement({ id: "passive", displayMode: "passive", publishedAt: "2026-09-14T08:00:00Z" });
  const forced = createAnnouncement({ id: "forced", displayMode: "modal_countdown", countdownSeconds: 5, publishedAt: "2026-09-13T08:00:00Z" });
  const untouched = createAnnouncement({ id: "unopened", displayMode: "passive", publishedAt: "2026-09-12T08:00:00Z" });
  const next = [passive, forced, untouched].map(item => item.id === passive.id ? patchAnnouncementRecord(item, "seen", "2026-09-14T09:00:00Z") : item);
  assert.equal(isPassiveAnnouncementUnread(next[0]), false);
  assert.equal(isForcedAnnouncementPending(next[1]), true);
  assert.equal(isPassiveAnnouncementUnread(next[1]), false, "forced items cannot enter automatic seen requests");
  assert.equal(isPassiveAnnouncementUnread(next[2]), true);
  assert.equal(isForcedAnnouncementPending(patchAnnouncementRecord(forced, "ack", "2026-09-14T09:00:00Z")), false);
}

function testReadingOrderDoesNotMutateBootstrap() {
  const older = createAnnouncement({ id: "older", publishedAt: "2026-09-01T00:00:00Z" });
  const newer = createAnnouncement({ id: "newer", publishedAt: "2026-09-14T00:00:00Z" });
  const invalid = createAnnouncement({ id: "invalid", publishedAt: "invalid" });
  const original = [older, invalid, newer];
  assert.deepEqual(sortAnnouncementsForReading(original).map(item => item.id), ["newer", "older", "invalid"]);
  assert.deepEqual(original.map(item => item.id), ["older", "invalid", "newer"]);
  assert.deepEqual(sortAnnouncementsForReading([]), []);
}

function main() {
  testReadingOnlyTouchesSelectedPassiveAnnouncement();
  testReadingOrderDoesNotMutateBootstrap();
  testOnlyLatestForcedAnnouncementAutoPrompts();
  testAcknowledgedLatestDoesNotCascadeToHistoricalForcedAnnouncement();
  console.log("desktop announcement state regression checks passed");
}

main();
