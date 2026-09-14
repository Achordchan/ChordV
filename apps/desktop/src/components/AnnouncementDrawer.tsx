import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Group, Modal, Text } from "@mantine/core";
import type { AnnouncementDto } from "@chordv/shared";
import { isForcedAnnouncementPending, isPassiveAnnouncementUnread, sortAnnouncementsForReading } from "../lib/announcementState";
import styles from "./AnnouncementDrawer.module.css";

type AnnouncementDrawerProps = {
  opened: boolean;
  announcements: AnnouncementDto[];
  onClose: () => void;
  onSeen: (id: string) => Promise<boolean>;
  onAcknowledge: (announcement: AnnouncementDto) => Promise<boolean>;
};

export function AnnouncementDrawer(props: AnnouncementDrawerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const announcements = useMemo(() => sortAnnouncementsForReading(props.announcements), [props.announcements]);
  const selected = announcements.find((item) => item.id === selectedId) ?? announcements[0];
  useEffect(() => { if (!props.opened) setSelectedId(null); }, [props.opened]);

  return (
    <Modal
      opened={props.opened} onClose={props.onClose} title="公告中心"
      size={620} radius="lg" centered closeButtonProps={{ "aria-label": "关闭公告中心" }}
      classNames={{ content: selected ? styles.content : styles.emptyContent, header: styles.header, title: styles.title, body: styles.body }}
    >
      {selected ? (
        <div className={styles.layout}>
          <nav className={styles.list} aria-label="公告列表">
            {announcements.map((item) => {
              const unread = isPassiveAnnouncementUnread(item) || isForcedAnnouncementPending(item);
              return (
                <button key={item.id} type="button" className={styles.listItem} data-selected={item.id === selected.id || undefined}
                  aria-current={item.id === selected.id ? true : undefined} onClick={() => setSelectedId(item.id)}>
                  <span className={styles.listTitle}>{item.title}{unread && <span className={styles.unread} aria-label="未读" />}</span>
                  <span className={styles.listMeta}>
                    {item.level === "warning" && <Badge size="xs" color="yellow" variant="light">提醒</Badge>}
                    <time dateTime={item.publishedAt}>{formatDate(item.publishedAt, true)}</time>
                  </span>
                </button>
              );
            })}
          </nav>
          {props.opened && <AnnouncementReader key={selected.id} item={selected} onSeen={props.onSeen} onAcknowledge={props.onAcknowledge} />}
        </div>
      ) : <Text size="sm" c="dimmed" className={styles.empty}>当前没有公告</Text>}
    </Modal>
  );
}

function AnnouncementReader({ item, onSeen, onAcknowledge }: {
  item: AnnouncementDto;
  onSeen: AnnouncementDrawerProps["onSeen"];
  onAcknowledge: AnnouncementDrawerProps["onAcknowledge"];
}) {
  const pending = isForcedAnnouncementPending(item);
  const [remaining, setRemaining] = useState(() => item.displayMode === "modal_countdown" ? item.countdownSeconds : 0);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  const unread = isPassiveAnnouncementUnread(item);

  useEffect(() => {
    if (!unread) { setBusy(false); setReadError(false); return; }
    let active = true;
    setBusy(true);
    void onSeen(item.id).then((ok) => { if (active) setReadError(!ok); })
      .catch(() => { if (active) setReadError(true); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [item.id, unread, onSeen]);

  useEffect(() => {
    setRemaining(item.displayMode === "modal_countdown" ? item.countdownSeconds : 0);
  }, [item.displayMode, item.countdownSeconds]);
  useEffect(() => {
    if (!pending || remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [pending, remaining]);

  async function retryRead() {
    if (busy) return;
    setBusy(true);
    try { setReadError(!await onSeen(item.id)); } catch { setReadError(true); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (busy || remaining > 0 || !pending) return;
    setBusy(true); setConfirmError(false);
    try { setConfirmError(!await onAcknowledge(item)); } catch { setConfirmError(true); }
    finally { setBusy(false); }
  }

  return (
    <article className={styles.reader} aria-labelledby={`announcement-title-${item.id}`}>
      <header className={styles.readerHeader}>
        <Text id={`announcement-title-${item.id}`} component="h3" className={styles.readerTitle}>{item.title}</Text>
        <Group gap={8} mt={8}>
          <Text size="xs" c="dimmed"><time dateTime={item.publishedAt}>{formatDate(item.publishedAt)}</time></Text>
          <Badge size="xs" variant="light" color={item.level === "warning" ? "yellow" : item.level === "success" ? "green" : "cyan"}>
            {item.level === "warning" ? "提醒" : item.level === "success" ? "成功" : "通知"}
          </Badge>
          <Text size="xs" c="dimmed" role="status">{pending ? "待确认" : unread ? (busy ? "同步已读状态…" : "未读") : "已读"}</Text>
        </Group>
      </header>
      <div className={styles.articleBody} tabIndex={0} aria-label="公告正文">{item.body}</div>
      {(readError || pending || confirmError) && (
        <footer className={styles.footer}>
          {readError && <Group gap="xs"><Text size="xs" c="dimmed">已读状态未同步</Text><Button size="compact-xs" variant="subtle" loading={busy} onClick={() => void retryRead()}>重试</Button></Group>}
          {confirmError && <Text size="xs" c="red" role="alert">确认未保存，请重试。</Text>}
          {pending && <Button size="sm" loading={busy} disabled={remaining > 0} onClick={() => void confirm()}>{remaining > 0 ? `请等待 ${remaining} 秒` : "我知道了"}</Button>}
        </footer>
      )}
    </article>
  );
}

function formatDate(value: string, compact = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    ...(compact ? {} : { year: "numeric" as const }),
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}
