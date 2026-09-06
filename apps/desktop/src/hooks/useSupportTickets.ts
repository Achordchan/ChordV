import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ClientSupportTicketDetailDto,
  ClientSupportTicketSummaryDto,
  CreateClientSupportTicketInputDto,
  ReplyClientSupportTicketInputDto,
  UploadedSupportTicketAttachmentReferenceInputDto
} from "@chordv/shared";
import {
  createSupportTicket,
  fetchSupportTicketDetail,
  fetchSupportTickets,
  isUnauthorizedApiError,
  markSupportTicketRead,
  replySupportTicket,
  uploadSupportTicketAttachment
} from "../api/client";
import {
  consumeSupportTicketBackgroundDetailRefresh,
  isSupportTicketUnread,
  markSupportTicketAsRead,
  markSupportTicketAsUnread,
  reconcileLocalSupportTicketUnread
} from "../lib/supportTickets";

type NoticeInput = {
  color: "green" | "yellow" | "red" | "blue";
  title: string;
  message: string;
};

type TicketDraft = CreateClientSupportTicketInputDto;

export type LoadTicketListOptions = {
  silent?: boolean;
};

export type LoadTicketDetailOptions = {
  markRead?: boolean;
  silent?: boolean;
};

type UseSupportTicketsOptions = {
  accessToken: string | null;
  onUnauthorized?: () => Promise<unknown> | unknown;
  readError?: (message: string) => string;
  notify?: (notice: NoticeInput) => void;
};

function defaultReadError(message: string) {
  return message;
}

export type TicketAttachmentUploadState = {
  phase: "idle" | "uploading" | "uploaded" | "failed";
  progress: number;
  attachment: UploadedSupportTicketAttachmentReferenceInputDto | null;
  error: string | null;
};

const idleAttachmentUploadState: TicketAttachmentUploadState = {
  phase: "idle",
  progress: 0,
  attachment: null,
  error: null
};

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
  const [ticketReplyAttachment, setTicketReplyAttachment] = useState<File | null>(null);
  const [ticketReplyAttachmentUpload, setTicketReplyAttachmentUpload] =
    useState<TicketAttachmentUploadState>(idleAttachmentUploadState);
  const [ticketCenterError, setTicketCenterError] = useState<string | null>(null);
  const [ticketListBusy, setTicketListBusy] = useState(false);
  const [ticketDetailBusy, setTicketDetailBusy] = useState(false);
  const [ticketSubmitting, setTicketSubmitting] = useState(false);
  const locallyUnreadTicketIdsRef = useRef(new Set<string>());
  const attachmentUploadRunRef = useRef(0);

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
        locallyUnreadTicketIdsRef.current.delete(ticketId);
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

  const markTicketUnread = useCallback((ticketId: string) => {
    locallyUnreadTicketIdsRef.current.add(ticketId);
    setTicketList((current) => current.map((ticket) => markSupportTicketAsUnread(ticket, ticketId)));
  }, []);

  const loadTicketList = useCallback(
    async (preferredTicketId?: string | null, loadOptions?: LoadTicketListOptions) => {
      if (!options.accessToken) {
        return [];
      }

      try {
        if (!loadOptions?.silent) {
          setTicketListBusy(true);
          setTicketCenterError(null);
        }
        const nextTickets = (await fetchSupportTickets(options.accessToken)).map((ticket) =>
          reconcileLocalSupportTicketUnread(ticket, locallyUnreadTicketIdsRef.current)
        );
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
        if (!loadOptions?.silent) {
          setTicketCenterError(reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "工单列表加载失败");
        }
        return [];
      } finally {
        if (!loadOptions?.silent) {
          setTicketListBusy(false);
        }
      }
    },
    [options.accessToken, options.onUnauthorized, options.readError]
  );

  const loadTicketDetail = useCallback(
    async (ticketId: string, loadOptions?: LoadTicketDetailOptions) => {
      if (!options.accessToken) {
        return null;
      }

      try {
        if (!loadOptions?.silent) {
          setTicketDetailBusy(true);
          setTicketCenterError(null);
        }
        const isBackgroundRefresh = consumeSupportTicketBackgroundDetailRefresh(ticketId);
        const shouldMarkRead = loadOptions?.markRead ?? !isBackgroundRefresh;
        const detail = await fetchSupportTicketDetail(options.accessToken, ticketId);
        setTicketDetail(detail);
        if (shouldMarkRead && isSupportTicketUnread(detail)) {
          await markTicketAsRead(ticketId, options.accessToken);
        }
        return detail;
      } catch (reason) {
        if (isUnauthorizedApiError(reason)) {
          await options.onUnauthorized?.();
          return null;
        }
        if (!loadOptions?.silent) {
          setTicketCenterError(reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "工单详情加载失败");
        }
        return null;
      } finally {
        if (!loadOptions?.silent) {
          setTicketDetailBusy(false);
        }
      }
    },
    [markTicketAsRead, options.accessToken, options.onUnauthorized, options.readError]
  );

  const resetReplyAttachment = useCallback(() => {
    attachmentUploadRunRef.current += 1;
    setTicketReplyAttachment(null);
    setTicketReplyAttachmentUpload(idleAttachmentUploadState);
  }, []);

  const handleReplyAttachmentChange = useCallback(
    (file: File | null) => {
      attachmentUploadRunRef.current += 1;
      const runId = attachmentUploadRunRef.current;
      setTicketReplyAttachment(file);
      if (!file) {
        setTicketReplyAttachmentUpload(idleAttachmentUploadState);
        return;
      }
      if (!options.accessToken || !selectedTicketId) {
        setTicketReplyAttachmentUpload({
          phase: "failed",
          progress: 0,
          attachment: null,
          error: "请先打开要回复的工单，再上传附件。"
        });
        return;
      }

      setTicketCenterError(null);
      setTicketReplyAttachmentUpload({
        phase: "uploading",
        progress: 1,
        attachment: null,
        error: null
      });

      void uploadSupportTicketAttachment(options.accessToken, selectedTicketId, file, (progress) => {
        if (attachmentUploadRunRef.current !== runId) {
          return;
        }
        setTicketReplyAttachmentUpload((current) => ({
          ...current,
          phase: "uploading",
          progress: Math.max(current.progress, progress),
          error: null
        }));
      })
        .then((attachment) => {
          if (attachmentUploadRunRef.current !== runId) {
            return;
          }
          setTicketReplyAttachmentUpload({
            phase: "uploaded",
            progress: 100,
            attachment,
            error: null
          });
        })
        .catch(async (reason) => {
          if (isUnauthorizedApiError(reason)) {
            await options.onUnauthorized?.();
          }
          if (attachmentUploadRunRef.current !== runId) {
            return;
          }
          const message = reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "附件上传失败";
          setTicketReplyAttachmentUpload({
            phase: "failed",
            progress: 0,
            attachment: null,
            error: message
          });
          setTicketCenterError(message);
        });
    },
    [options.accessToken, options.onUnauthorized, options.readError, selectedTicketId]
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
    resetReplyAttachment();
  }, [resetReplyAttachment]);

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
    if (!options.accessToken || !selectedTicketId || ticketSubmitting) {
      return null;
    }
    if (!ticketReplyDraft.trim() && !ticketReplyAttachment) {
      return null;
    }
    if (ticketReplyAttachment && ticketReplyAttachmentUpload.phase !== "uploaded") {
      const message =
        ticketReplyAttachmentUpload.phase === "uploading"
          ? "附件上传完成后才能发送回复。"
          : ticketReplyAttachmentUpload.error ?? "附件未上传成功，请重新选择图片。";
      setTicketCenterError(message);
      options.notify?.({
        color: ticketReplyAttachmentUpload.phase === "uploading" ? "blue" : "red",
        title: ticketReplyAttachmentUpload.phase === "uploading" ? "附件上传中" : "附件上传失败",
        message
      });
      return null;
    }

    try {
      setTicketSubmitting(true);
      setTicketCenterError(null);
      const trimmedBody = ticketReplyDraft.trim();
      const detail = await replySupportTicket(options.accessToken, selectedTicketId, {
        body: trimmedBody,
        attachment: ticketReplyAttachment ? ticketReplyAttachmentUpload.attachment : null
      } satisfies ReplyClientSupportTicketInputDto);
      setTicketDetail(detail);
      setTicketReplyDraft("");
      resetReplyAttachment();
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
      const message = reason instanceof Error ? (options.readError ?? defaultReadError)(reason.message) : "发送回复失败";
      setTicketCenterError(message);
      return null;
    } finally {
      setTicketSubmitting(false);
    }
  }, [
    loadTicketList,
    options,
    resetReplyAttachment,
    selectedTicketId,
    ticketReplyAttachment,
    ticketReplyAttachmentUpload,
    ticketReplyDraft,
    ticketSubmitting
  ]);

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
    ticketReplyAttachment,
    ticketReplyAttachmentUpload,
    setTicketReplyAttachment: handleReplyAttachmentChange,
    resetReplyAttachment,
    ticketCenterError,
    setTicketCenterError,
    ticketListBusy,
    ticketDetailBusy,
    ticketSubmitting,
    hasUnreadTickets,
    loadTicketList,
    loadTicketDetail,
    markTicketAsRead,
    markTicketUnread,
    openTicketCenter,
    openTicketComposer,
    closeTicketComposer,
    handleCreateTicket,
    handleReplyTicket
  };
}
