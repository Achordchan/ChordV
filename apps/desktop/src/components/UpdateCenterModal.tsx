import { Badge, Button, Group, Loader, Modal, Switch, Text } from "@mantine/core";
import { IconAlertCircle, IconArrowRight, IconCircleCheckFilled, IconClock } from "@tabler/icons-react";
import appIcon from "../../src-tauri/icons/icon.png";
import type { UpdateCenterItem, UpdateCenterItemKey, UpdateCenterState } from "../lib/updateCenter";
import styles from "./UpdateCenterModal.module.css";

type UpdateCenterModalProps = {
  state: UpdateCenterState;
  appVersion: string;
  busy: boolean;
  runtimeBusy: boolean;
  runtimeInUse: boolean;
  syncDeferred: boolean;
  syncError?: string | null;
  betaChannel: boolean;
  onBetaChannelChange: (enabled: boolean) => void;
  onClose: () => void;
  onCheckOnly: () => void;
  onUpdateOne: (key: UpdateCenterItemKey) => void;
};

export function UpdateCenterModal(props: UpdateCenterModalProps) {
  const app = props.state.items.find((item) => item.key === "app");
  const runtimeItems = props.state.items.filter((item) => item.key !== "app");
  const runtimeChecking = props.runtimeBusy || props.state.checking;
  // Only states the user can act on or should wait for get a line of explanation.
  const runtimeNotice = props.syncDeferred ? "连接期间暂缓更新，断开连接后将自动同步。"
    : props.syncError && !runtimeChecking ? props.syncError : null;
  return (
    <Modal
      opened={props.state.opened}
      onClose={props.onClose}
      centered
      closeButtonProps={{ "aria-label": "关闭更新中心" }}
      title="更新中心"
      size={500}
      radius="lg"
      classNames={{ title: styles.title, header: styles.header, body: styles.body }}
    >
      <div className={styles.client}>
        <img src={appIcon} alt="ChordV" className={styles.logo} />
        <div className={styles.clientInfo}>
          <Text className={styles.clientName}>ChordV 客户端</Text>
          <Group gap="xs" mt={4}>
            <Text size="sm" c="dimmed">当前版本 {app?.localVersion || props.appVersion}</Text>
            {app && <ItemStatus item={app} />}
          </Group>
          {app?.status === "available" && app.remoteVersion && <Text size="sm" c="dimmed" mt={6}>可更新至 {app.remoteVersion}</Text>}
        </div>
        {app?.canUpdate && <Button size="xs" disabled={props.busy} onClick={() => props.onUpdateOne("app")}>查看更新</Button>}
      </div>

      <Switch
        className={styles.channel}
        checked={props.betaChannel}
        disabled={props.busy}
        onChange={(event) => props.onBetaChannelChange(event.currentTarget.checked)}
        label="接收测试版更新"
        description={props.betaChannel
          ? "将优先收到测试版，可能不够稳定。关闭后不会降级，正式版追上后恢复正常更新。"
          : "提前体验新版本，可能不够稳定。"}
      />

      <section className={styles.components} aria-labelledby="runtime-components-heading">
        <Text id="runtime-components-heading" className={styles.sectionTitle}>运行组件</Text>
        {runtimeNotice ? <Text c={props.syncError && !props.syncDeferred ? "red" : "dimmed"} size="sm" mt={5}>{runtimeNotice}</Text> : null}
        <div className={styles.rows} aria-live="polite">
          {runtimeItems.map((item) => {
            const waiting = props.runtimeInUse && (props.syncDeferred || item.status === "available");
            const actionable = item.canUpdate || item.status === "failed";
            return (
              <div key={item.key} className={styles.row}>
                <div className={styles.rowMain}>
                  <Text size="sm" fw={600}>{item.key === "xray" ? "Xray 内核" : "GEO 数据"}</Text>
                  <Group gap="sm" justify="flex-end" wrap="nowrap" className={styles.rowStatus}>
                    {runtimeChecking ? <Group gap={6} wrap="nowrap"><Loader size={14} /><Text size="sm" c="dimmed">{props.state.checking ? "正在检查" : "正在同步"}</Text></Group>
                      : <RuntimeVersion item={item} waiting={waiting} />}
                    {actionable && !runtimeChecking && !waiting && (
                      <Button size="compact-sm" variant="light" disabled={props.busy || props.runtimeInUse} onClick={() => props.onUpdateOne(item.key)}>
                        {item.status === "failed" ? "重试" : "同步"}
                      </Button>
                    )}
                  </Group>
                </div>
                {item.status === "failed" && item.message && !runtimeChecking
                  ? <Text size="xs" c="red" className={styles.rowMessage}>{item.message}</Text> : null}
              </div>
            );
          })}
        </div>
      </section>

      <div className={styles.footer}>
        <Text size="xs" c="dimmed">{props.state.lastCheckedAt
          ? `上次检查：${new Date(props.state.lastCheckedAt).toLocaleString("zh-CN", { hour12: false })}`
          : "尚未检查"}</Text>
        <Button size="sm" loading={props.state.checking} disabled={props.busy} onClick={props.onCheckOnly}>检查更新</Button>
      </div>
    </Modal>
  );
}

/** Current version, plus a check when it matches the version the backend distributes. */
function RuntimeVersion({ item, waiting }: { item: UpdateCenterItem; waiting: boolean }) {
  const local = item.localVersion?.trim() || null;
  const remote = item.remoteVersion?.trim() || null;
  if (item.status === "updating") {
    return <Group gap={6} wrap="nowrap"><Loader size={14} /><Text size="sm" c="dimmed">正在更新</Text></Group>;
  }
  if (item.status === "current") {
    return (
      <Group gap={6} wrap="nowrap" className={styles.version}>
        <Text size="sm" className={styles.versionText}>{local ?? remote ?? "已安装"}</Text>
        <IconCircleCheckFilled size={16} className={styles.versionOk} aria-label="与后台版本一致" />
      </Group>
    );
  }
  if (item.status === "available") {
    return (
      <Group gap={6} wrap="nowrap" className={styles.version}>
        {waiting ? <IconClock size={15} className={styles.versionMuted} aria-hidden="true" /> : null}
        <Text size="sm" className={styles.versionText} c="dimmed">{local ?? "未安装"}</Text>
        {remote ? <><IconArrowRight size={13} className={styles.versionMuted} aria-hidden="true" /><Text size="sm" c="cyan.7" className={styles.versionText}>{remote}</Text></> : null}
      </Group>
    );
  }
  if (item.status === "failed") {
    return (
      <Group gap={6} wrap="nowrap" className={styles.version}>
        {local ? <Text size="sm" className={styles.versionText} c="dimmed">{local}</Text> : null}
        <IconAlertCircle size={16} className={styles.versionFailed} aria-label="同步未完成" />
      </Group>
    );
  }
  return <Text size="sm" c="dimmed">{item.status === "unsupported" ? "暂不可用" : "尚未检查"}</Text>;
}

function ItemStatus({ item }: { item: UpdateCenterItem }) {
  if (item.status === "checking" || item.status === "updating") {
    return <Group gap={6}><Loader size={14} /><Text size="sm" c="dimmed">{item.status === "checking" ? "正在检查" : "正在更新"}</Text></Group>;
  }
  if (item.status === "current") return <Badge color="green" variant="light">已是最新</Badge>;
  if (item.status === "failed") return <Group gap={6} c="red"><IconAlertCircle size={16} /><Text size="sm">检查失败</Text></Group>;
  return <Text size="sm" c={item.status === "available" ? "cyan" : "dimmed"}>
    {item.status === "available" ? "有新版本" : item.status === "unsupported" ? "暂不可用" : "尚未检查"}
  </Text>;
}
