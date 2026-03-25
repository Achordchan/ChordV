import { useCallback, useMemo, useState } from "react";
import type {
  ClientSupportTicketDetailDto,
  ClientSupportTicketSummaryDto,
  CreateClientSupportTicketInputDto,
  ReplyClientSupportTicketInputDto
} from "@chordv/shared";
import {
  createSupportTicket,
  fetchSupportTicketDetail,
  fetchSupportTickets,
  isUnauthorizedApiError,
  markSupportTicketRead,
  replySupportTicket
} from "../api/client";
import { isSupportTicketUnread, markSupportTicketAsRead } from "../lib/supportTickets";

type NoticeInput = {
  color: "green" | "yellow" | "red" | "blue";
  title: string;
  message: string;
};

type TicketDraft = CreateClientSupportTicketInputDto;

type UseSupportTicketsOptions = {
  accessToken: string | null;
  onUnauthorized?: () => Promise<unknown> | unknown;
  readError?: (message: string) => string;
  notify?: (notice: NoticeInput) => void;
};

function defaultReadError(message: string) {
  return message;
}

function pickTicketId(
  tickets: ClientSupportTicketSummaryDto[],
  preferredId: string | null | undefined
) {
  if (preferredId && tickets.some((ticket) => ticket.id === preferredId)) {
    return preferredId;
  }
  return tickets[0]?.id ?? null;
}

export function useSupportTickets(options: UseSupportTicketsOptions) {
  const [ticketCenterOpened, setTicketCenterOpened] = useState(false);
  const [ticketCreateMode, setTicketCreateMode] = useState(false);
  const [ticketList, setTicketList] = useState<ClientSupportTicketSummaryDto[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [ticketDetail, setTicketDetail] = useState<ClientSupportTicketDetailDto | null>(null);
  const [ticketDraft, setTicketDraft] = useState<TicketDraft>({ title: "", body: "" });
  const [ticketReplyDraft, setTicketReplyDraft] = useState("");
  const [ticketCenterError, setTicketCenterError] = useState<string | null>(null);
  const [ticketListBusy, setTicketListBusy] = useState(false);
  const [ticketDetailBusy, setTicketDetailBusy] = useState(false);
  const [ticketSubmitting, setTicketSubmitting] = useState(false);

  const hasUnreadTickets = useMemo(
    () => ticketList.some((ticket) => isSupportTicketUnread(ticket)),
    [ticketList]
  );

  const markTicketAsRead = useCallback(
    async (ticketId: string, accessTokenOverride?: string | null) => {
      const accessToken = accessTokenOverride ?? options.accessToken;
      if (!accessToken) {
        return false;
      }

      try {
        await markSupportTicketRead(accessToken, ticketId);
        setTicketList((current) => current.map((ticket) => markSupportTicketAsRead(ticket, ticketId)));
        setTicketDetail((current) => (current ? markSupportTicketAsRead(current, ticketId) : current));
        return true;
      } catch (reason) {
        if (isUnauthorizedApiError(reason)) {
          await options.onUnauthorized?.();
        }
        return false;
      }
    },
    [options.accessToken, options.onUnauthorized]
  );

  const loadTicketList = useCallback(
    async (preferredTicketId?: string | null) => {
      if (!options.accessToken) {
        return [];
      }

      try {
        setTicketListBusy(true);
        setTicketCenterError(null);
        const nextTickets = await fetchSupportTickets(options.accessToken);
        setTicketList(nextTickets);
        setSelectedTicketId((current) => pickTicketId(nextTickets, preferredTicketId ?? current));
        if (nextTickets.length === 0) {
          setTicketDetail(null);
        }
        return nextTickets;
      } catch (reason) {
        if (isUnauthorizedApiError(reason)) {
          await options.onUnauthorized?.();
          return [];
        }
        setTicketCenterError(reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "工单列表加载失败");
        return [];
      } finally {
        setTicketListBusy(false);
      }
    },
    [options.accessToken, options.onUnauthorized, options.readError]
  );

  const loadTicketDetail = useCallback(
    async (ticketId: string) => {
      if (!options.accessToken) {
        return null;
      }

      try {
        setTicketDetailBusy(true);
        setTicketCenterError(null);
        const detail = await fetchSupportTicketDetail(options.accessToken, ticketId);
        setTicketDetail(detail);
        if (isSupportTicketUnread(detail)) {
          void markTicketAsRead(ticketId, options.accessToken);
        }
        return detail;
      } catch (reason) {
        if (isUnauthorizedApiError(reason)) {
          await options.onUnauthorized?.();
          return null;
        }
        setTicketCenterError(reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "工单详情加载失败");
        return null;
      } finally {
        setTicketDetailBusy(false);
      }
    },
    [markTicketAsRead, options.accessToken, options.onUnauthorized, options.readError]
  );

  const openTicketCenter = useCallback(async () => {
    setTicketCenterOpened(true);
    setTicketCreateMode(false);
    await loadTicketList();
  }, [loadTicketList]);

  const openTicketComposer = useCallback(() => {
    setTicketCenterOpened(true);
    setTicketCreateMode(true);
    setTicketCenterError(null);
    setTicketReplyDraft("");
  }, []);

  const closeTicketComposer = useCallback(() => {
    setTicketCreateMode(false);
    setTicketCenterError(null);
  }, []);

  const handleCreateTicket = useCallback(async () => {
    if (!options.accessToken || ticketSubmitting) {
      return null;
    }

    try {
      setTicketSubmitting(true);
      setTicketCenterError(null);
      const detail = await createSupportTicket(options.accessToken, {
        title: ticketDraft.title.trim(),
        body: ticketDraft.body.trim()
      });
      setTicketDraft({ title: "", body: "" });
      setTicketReplyDraft("");
      setTicketCreateMode(false);
      setTicketDetail(detail);
      setSelectedTicketId(detail.id);
      await loadTicketList(detail.id);
      options.notify?.({
        color: "green",
        title: "工单已提交",
        message: "你的问题已经提交成功，可以在这里继续补充信息。"
      });
      return detail;
    } catch (reason) {
      if (isUnauthorizedApiError(reason)) {
        await options.onUnauthorized?.();
        return null;
      }
      setTicketCenterError(reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "工单提交失败");
      return null;
    } finally {
      setTicketSubmitting(false);
    }
  }, [loadTicketList, options, ticketDraft, ticketSubmitting]);

  const handleReplyTicket = useCallback(async () => {
    if (!options.accessToken || !selectedTicketId || ticketSubmitting || !ticketReplyDraft.trim()) {
      return null;
    }

    try {
      setTicketSubmitting(true);
      setTicketCenterError(null);
      const input: ReplyClientSupportTicketInputDto = {
        body: ticketReplyDraft.trim()
      };
      const detail = await replySupportTicket(options.accessToken, selectedTicketId, input);
      setTicketDetail(detail);
      setTicketReplyDraft("");
      await loadTicketList(detail.id);
      options.notify?.({
        color: "green",
        title: "回复已发送",
        message: "客服看到后会继续在这条工单里回复你。"
      });
      return detail;
    } catch (reason) {
      if (isUnauthorizedApiError(reason)) {
        await options.onUnauthorized?.();
        return null;
      }
      setTicketCenterError(reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "发送回复失败");
      return null;
    } finally {
      setTicketSubmitting(false);
    }
  }, [loadTicketList, options, selectedTicketId, ticketReplyDraft, ticketSubmitting]);

  return {
    ticketCenterOpened,
    setTicketCenterOpened,
    ticketCreateMode,
    setTicketCreateMode,
    ticketList,
    setTicketList,
    selectedTicketId,
    setSelectedTicketId,
    ticketDetail,
    setTicketDetail,
    ticketDraft,
    setTicketDraft,
    ticketReplyDraft,
    setTicketReplyDraft,
    ticketCenterError,
    setTicketCenterError,
    ticketListBusy,
    ticketDetailBusy,
    ticketSubmitting,
    hasUnreadTickets,
    loadTicketList,
    loadTicketDetail,
    markTicketAsRead,
    openTicketCenter,
    openTicketComposer,
    closeTicketComposer,
    handleCreateTicket,
    handleReplyTicket
  };
}
