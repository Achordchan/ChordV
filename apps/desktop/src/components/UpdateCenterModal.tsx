import { useState } from "react";
import { Badge, Button, Collapse, Group, Loader, Modal, Text, UnstyledButton } from "@mantine/core";
import { IconAlertCircle, IconChevronDown, IconCircleCheckFilled, IconClock } from "@tabler/icons-react";
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
  onClose: () => void;
  onCheckOnly: () => void;
  onUpdateOne: (key: UpdateCenterItemKey) => void;
};

export function UpdateCenterModal(props: UpdateCenterModalProps) {
  const [detailsOpened, setDetailsOpened] = useState(false);
  const app = props.state.items.find((item) => item.key === "app");
  const runtimeItems = props.state.items.filter((item) => item.key !== "app");
  const runtimeChecking = props.runtimeBusy || props.state.checking;
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

      <section className={styles.components} aria-labelledby="runtime-components-heading">
        <Text id="runtime-components-heading" className={styles.sectionTitle}>运行组件</Text>
        <Text c="dimmed" size="sm" mt={5}>
          {props.syncDeferred ? "组件待同步，断开连接后将自动更新。"
            : props.syncError && !runtimeChecking ? props.syncError
              : "自动同步，连接期间暂缓更新。"}
        </Text>
        <div className={styles.rows} aria-live="polite">
          {runtimeItems.map((item) => {
            const waiting = props.runtimeInUse && (props.syncDeferred || item.status === "available");
            const actionable = item.canUpdate || item.status === "failed";
            return (
              <div key={item.key} className={styles.row}>
                <Text size="sm" fw={600}>{item.key === "xray" ? "Xray 内核" : "GEO 数据"}</Text>
                <Group gap="sm" justify="flex-end" className={styles.rowStatus}>
                  {runtimeChecking ? <Group gap={6}><Loader size={16} /><Text size="sm" c="dimmed">{props.state.checking ? "正在检查" : "正在同步"}</Text></Group>
                    : waiting ? <Group gap={6}><IconClock size={18} /><Text size="sm" c="dimmed">等待断开连接</Text></Group>
                      : <ItemStatus item={item} />}
                  {actionable && !runtimeChecking && !waiting && (
                    <Button size="xs" variant="light" disabled={props.busy || props.runtimeInUse} onClick={() => props.onUpdateOne(item.key)}>
                      {item.status === "failed" ? "重试同步" : "同步"}
                    </Button>
                  )}
                </Group>
              </div>
            );
          })}
        </div>
      </section>

      <UnstyledButton
        className={styles.detailsToggle}
        aria-expanded={detailsOpened}
        aria-controls="update-version-details"
        onClick={() => setDetailsOpened((value) => !value)}
      >
        <IconChevronDown size={16} style={{ transform: detailsOpened ? "rotate(180deg)" : undefined }} />
        <span>{detailsOpened ? "收起版本详情" : "查看版本详情"}</span>
      </UnstyledButton>
      <Collapse in={detailsOpened}>
        <div id="update-version-details" className={styles.details}>
          {props.state.items.map((item) => (
            <div key={item.key} className={styles.detailItem}>
              <Text size="sm" fw={600}>{item.key === "app" ? "客户端" : item.label}</Text>
              <Text size="sm" c="dimmed">当前版本：{item.localVersion || (item.key === "app" ? props.appVersion : "尚未读取")}</Text>
              <Text size="sm" c="dimmed">{item.key === "app" ? "可用版本" : "后台目标版本"}：{item.remoteVersion || "尚未获取"}</Text>
              {item.message && item.status !== "current" && <Text size="sm" c={item.status === "failed" ? "red" : "dimmed"}>{item.message}</Text>}
            </div>
          ))}
        </div>
      </Collapse>
      <div className={styles.footer}>
        <Text size="xs" c="dimmed">{props.state.lastCheckedAt
          ? `上次检查：${new Date(props.state.lastCheckedAt).toLocaleString("zh-CN", { hour12: false })}`
          : "尚未检查"}</Text>
        <Button size="sm" loading={props.state.checking} disabled={props.busy} onClick={props.onCheckOnly}>检查更新</Button>
      </div>
    </Modal>
  );
}

function ItemStatus({ item }: { item: UpdateCenterItem }) {
  if (item.status === "checking" || item.status === "updating") {
    return <Group gap={6}><Loader size={16} /><Text size="sm" c="dimmed">{item.status === "checking" ? "正在检查" : "正在更新"}</Text></Group>;
  }
  if (item.status === "current") {
    return item.key === "app" ? <Badge color="green" variant="light">已是最新</Badge>
      : <Group gap={7} c="green"><IconCircleCheckFilled size={18} /><Text size="sm">已同步</Text></Group>;
  }
  if (item.status === "failed") {
    return <Group gap={6} c="red"><IconAlertCircle size={18} /><Text size="sm">{item.key === "app" ? "检查失败" : "同步未完成"}</Text></Group>;
  }
  return <Text size="sm" c={item.status === "available" ? "cyan" : "dimmed"}>
    {item.status === "available" ? (item.key === "app" ? "有新版本" : "待同步") : item.status === "unsupported" ? "暂不可用" : "尚未检查"}
  </Text>;
}
