import assert from "node:assert/strict";
import type { AnnouncementDto } from "@chordv/shared";
import {
  hasUnreadAnnouncements,
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

function main() {
  testOnlyLatestForcedAnnouncementAutoPrompts();
  testAcknowledgedLatestDoesNotCascadeToHistoricalForcedAnnouncement();
  console.log("desktop announcement state regression checks passed");
}

main();
