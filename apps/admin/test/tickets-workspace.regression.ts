import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { register } from "node:module";
import type { AdminSupportTicketDetailDto, AdminSupportTicketSummaryDto, SupportTicketStatus } from "@chordv/shared";
import type { TicketStatusFilter } from "../src/features/tickets/ticket-model";

register(new URL("./css-module-loader.mjs", import.meta.url));
const { TicketDetail } = await import("../src/features/tickets/TicketDetail");
const { TicketList } = await import("../src/features/tickets/TicketList");
const model = await import("../src/features/tickets/ticket-model");

const noop = () => undefined;
const render = (element: ReactElement) => renderToStaticMarkup(createElement(MantineProvider, null, element));

function summary(overrides: Partial<AdminSupportTicketSummaryDto> = {}): AdminSupportTicketSummaryDto {
  return {
    id: "ticket_0001",
    title: "连接后几分钟自动断开",
    status: "waiting_admin",
    source: "desktop",
    ownerType: "personal",
    userId: "user_1",
    userEmail: "user@example.invalid",
    userDisplayName: "张伟",
    subscriptionId: "sub_1",
    teamId: null,
    teamName: null,
    lastMessageAt: "2026-09-27T08:00:00.000Z",
    closedAt: null,
    createdAt: "2026-09-26T08:00:00.000Z",
    updatedAt: "2026-09-27T08:00:00.000Z",
    lastMessagePreview: "连接不稳定",
    ...overrides
  };
}

function detail(status: SupportTicketStatus, overrides: Partial<AdminSupportTicketDetailDto> = {}): AdminSupportTicketDetailDto {
  return {
    ...summary({ status }),
    messages: [
      {
        id: "m2", ticketId: "ticket_0001", authorRole: "admin", authorUserId: "admin", authorDisplayName: null, authorEmail: null,
        body: "已经修复，请再试一下。", attachments: [], createdAt: "2026-09-27T08:00:00.000Z"
      },
      {
        id: "m1", ticketId: "ticket_0001", authorRole: "user", authorUserId: "user_1", authorDisplayName: "张伟", authorEmail: "user@example.invalid",
        body: "每隔几分钟断开一次。", createdAt: "2026-09-26T08:00:00.000Z",
        attachments: [{ id: "a1", url: "https://img.example.invalid/a.png", fileName: "截图.png", mimeType: "image/png", fileSizeBytes: "1", createdAt: "2026-09-26T08:00:00.000Z" }]
      },
      {
        id: "m3", ticketId: "ticket_0001", authorRole: "system", authorUserId: null, authorDisplayName: null, authorEmail: null,
        body: "工单状态已更新", attachments: [], createdAt: "2026-09-27T09:00:00.000Z"
      }
    ],
    ...overrides
  };
}

function renderDetail(ticket: AdminSupportTicketDetailDto, readOnly: boolean, withCustomerLink = true) {
  return render(createElement(TicketDetail, {
    ticket,
    readOnly,
    statusChanging: null,
    replySaving: false,
    onStatusAction: noop,
    onPreviewAttachment: noop,
    onOpenCustomer: withCustomerLink ? noop : undefined,
    // 页面在只读时本就不传回复框；这里故意传入，确认详情本身也不会渲染。
    composer: createElement("div", { "data-composer": "yes" }, "REPLY-COMPOSER")
  }));
}

function renderList(tickets: AdminSupportTicketSummaryDto[], readOnly: boolean, filters: { keyword?: string; status?: TicketStatusFilter } = {}) {
  return render(createElement(TicketList, {
    tickets,
    totalCount: 3,
    selectedId: tickets[0]?.id ?? null,
    onSelect: noop,
    keyword: filters.keyword ?? "",
    onKeywordChange: noop,
    status: filters.status ?? "all",
    onStatusChange: noop,
    owner: "all",
    onOwnerChange: noop,
    onClearFilters: noop,
    readOnly,
    refreshing: false,
    onRefresh: noop
  }));
}

function testWriteActionsFollowArchiveMode() {
  assert.deepEqual(model.readTicketWriteActions({ status: "waiting_admin" }, true), { showComposer: false, canReply: false, statusAction: null });
  assert.deepEqual(model.readTicketWriteActions({ status: "closed" }, true), { showComposer: false, canReply: false, statusAction: null });
  assert.deepEqual(model.readTicketWriteActions({ status: "closed" }, false), { showComposer: true, canReply: false, statusAction: "reopen" });
  for (const status of ["open", "waiting_admin", "waiting_user"] as const) {
    assert.deepEqual(model.readTicketWriteActions({ status }, false), { showComposer: true, canReply: true, statusAction: "close" });
  }
}

function testArchiveDetailHasNoWriteControls() {
  const archived = renderDetail(detail("waiting_admin"), true);
  assert.doesNotMatch(archived, /REPLY-COMPOSER/, "只读存档不渲染回复框");
  assert.doesNotMatch(archived, /关闭工单|重开工单/, "只读存档不提供关闭、重开");
  assert.match(archived, /历史状态：待管理员回复/, "只读存档把状态作为历史展示");
  assert.match(archived, /历史存档，仅供查看/);
  // 查看能力保留：会话、附件预览、客户跳转。
  assert.match(archived, /每隔几分钟断开一次。/);
  assert.match(archived, /预览附件 截图\.png/);
  assert.match(archived, /查看客户/);

  const archivedClosed = renderDetail(detail("closed", { closedAt: "2026-09-28T08:00:00.000Z" }), true);
  assert.doesNotMatch(archivedClosed, /REPLY-COMPOSER|关闭工单|重开工单/);
  assert.match(archivedClosed, /历史状态：已关闭/);
  assert.match(archivedClosed, /关闭于/);
}

function testActiveDetailKeepsWriteControls() {
  const active = renderDetail(detail("waiting_admin"), false);
  assert.match(active, /REPLY-COMPOSER/);
  assert.match(active, /关闭工单/);
  assert.doesNotMatch(active, /重开工单|历史状态/);
  assert.ok(active.indexOf("每隔几分钟断开一次。") < active.indexOf("已经修复，请再试一下。"), "会话按时间顺序展示");
  assert.match(active, /工单状态已更新/, "系统消息作为时间线事件展示");

  const closed = renderDetail(detail("closed"), false);
  assert.match(closed, /重开工单/);
  assert.doesNotMatch(closed, /关闭工单/);
  assert.match(closed, /REPLY-COMPOSER/, "已关闭工单仍显示（禁用的）回复框，提示先重开");

  assert.doesNotMatch(renderDetail(detail("open"), false, false), /查看客户|查看团队/, "未接入跳转时不显示客户链接");
}

function testListMarksPendingRepliesOnlyWhenActive() {
  const tickets = [summary(), summary({ id: "ticket_0002", status: "closed", ownerType: "team", teamName: "设计团队" })];
  const active = renderList(tickets, false);
  assert.match(active, /aria-label="待回复"/, "未迁移时待管理员回复的工单带提示点");
  assert.match(active, />工单<span>2<\/span>/);
  assert.match(active, /张伟 · 设计团队/);
  const archived = renderList(tickets, true);
  assert.doesNotMatch(archived, /aria-label="待回复"/, "只读存档不再把历史待回复当成待处理");
  assert.match(archived, />历史工单<span>2<\/span>/);
  assert.match(archived, /data-archived="true"/);
  assert.match(renderList([], true), /没有历史工单/);
  assert.match(renderList([], false, { keyword: "不存在" }), /没有匹配的工单[\s\S]*清除筛选/);
}

function testModelHelpers() {
  const tickets = [
    summary({ id: "a", updatedAt: "2026-09-01T00:00:00.000Z", status: "closed" }),
    summary({ id: "b", updatedAt: "2026-09-03T00:00:00.000Z", ownerType: "team", teamName: "设计团队" }),
    summary({ id: "c", updatedAt: "2026-09-02T00:00:00.000Z", userEmail: "other@example.invalid", title: "发票" })
  ];
  assert.deepEqual(model.filterTickets(tickets, { keyword: "", status: "all", owner: "all" }).map((item) => item.id), ["b", "c", "a"]);
  assert.deepEqual(model.filterTickets(tickets, { keyword: "", status: "closed", owner: "all" }).map((item) => item.id), ["a"]);
  assert.deepEqual(model.filterTickets(tickets, { keyword: "", status: "all", owner: "team" }).map((item) => item.id), ["b"]);
  assert.deepEqual(model.filterTickets(tickets, { keyword: "OTHER@", status: "all", owner: "all" }).map((item) => item.id), ["c"], "搜索覆盖邮箱");

  assert.deepEqual(model.readTicketCustomerTarget(summary()), { tab: "personal", keyword: "user@example.invalid" });
  assert.deepEqual(model.readTicketCustomerTarget(summary({ ownerType: "team", teamName: "设计团队" })), { tab: "team", keyword: "设计团队" });
  assert.equal(model.readTicketCustomerTarget(summary({ ownerType: "team", teamName: null })), null);

  assert.equal(model.readSafeExternalUrl("https://support.example.invalid"), "https://support.example.invalid/");
  assert.equal(model.readSafeExternalUrl("javascript:alert(1)"), null);
  assert.equal(model.readSafeExternalUrl("not a url"), null);
  assert.equal(model.readSafeExternalUrl(null), null);

  const now = new Date(2026, 8, 28, 18, 0);
  assert.equal(model.formatTicketListTime(new Date(2026, 8, 28, 9, 5).toISOString(), now), "09:05");
  assert.equal(model.formatTicketListTime(new Date(2026, 1, 3, 9, 5).toISOString(), now), "2月3日");
  assert.equal(model.formatTicketListTime(new Date(2025, 11, 31, 9, 5).toISOString(), now), "2025/12/31");
  assert.equal(model.LEGACY_TICKETS_READ_ONLY_NOTICE, "工单系统已迁移到 Achord Connect，这里仅保留历史记录，只读。");
}

testWriteActionsFollowArchiveMode();
testArchiveDetailHasNoWriteControls();
testActiveDetailKeepsWriteControls();
testListMarksPendingRepliesOnlyWhenActive();
testModelHelpers();

console.log("admin tickets workspace archive/active rendering checks passed");
