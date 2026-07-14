import { Badge, Button, Group, Modal, Stack, Switch, Text } from "@mantine/core";
import {
  formatUpdateCenterItemMessage,
  type UpdateCenterItem,
  type UpdateCenterItemKey,
  type UpdateCenterState
} from "../lib/updateCenter";

type UpdateCenterModalProps = {
  state: UpdateCenterState;
  busy: boolean;
  onClose: () => void;
  onToggle: (key: UpdateCenterItemKey, enabled: boolean) => void;
  onCheckOnly: () => void;
  onUpdateSelected: () => void;
  onUpdateOne: (key: UpdateCenterItemKey) => void;
};

export function UpdateCenterModal(props: UpdateCenterModalProps) {
  const enabledKeys = props.state.items.filter((item) => item.enabled).map((item) => item.key);
  const updatable = props.state.items.filter((item) => item.enabled && item.canUpdate);

  return (
    <Modal
      opened={props.state.opened}
      onClose={props.onClose}
      centered
      title="检查更新"
      size="lg"
    >
      <Stack gap="md">
        <Stack gap={10}>
          {props.state.items.map((item) => (
            <UpdateCenterRow
              key={item.key}
              item={item}
              busy={props.busy}
              onToggle={(enabled) => props.onToggle(item.key, enabled)}
              onUpdate={() => props.onUpdateOne(item.key)}
            />
          ))}
        </Stack>

        <Group justify="space-between" align="center" gap="sm" wrap="wrap">
          <Text size="sm" c="dimmed">
            {props.state.checking
              ? "正在检查组件版本…"
              : props.state.lastCheckedAt
                ? `上次检查：${new Date(props.state.lastCheckedAt).toLocaleString()}`
                : "先检查版本，再按需更新"}
          </Text>
          <Group gap="sm">
            <Button variant="default" loading={props.state.checking} disabled={props.busy && !props.state.checking} onClick={props.onCheckOnly}>
              仅检查
            </Button>
            <Button
              loading={props.state.updatingKey === "all"}
              disabled={props.busy || enabledKeys.length === 0 || updatable.length === 0}
              onClick={props.onUpdateSelected}
            >
              检查更新
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function UpdateCenterRow(props: {
  item: UpdateCenterItem;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onUpdate: () => void;
}) {
  return (
    <Group
      justify="space-between"
      align="center"
      wrap="nowrap"
      gap="md"
      style={{
        border: "1px solid var(--mantine-color-gray-3)",
        borderRadius: 12,
        padding: "12px 14px",
        background: "var(--mantine-color-body)"
      }}
    >
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
        <Switch
          checked={props.item.enabled}
          onChange={(event) => props.onToggle(event.currentTarget.checked)}
          disabled={props.busy}
          label={props.item.label}
          styles={{ label: { fontWeight: 600, minWidth: 64 } }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" style={{ lineHeight: 1.4 }}>
            {formatUpdateCenterItemMessage(props.item)}
          </Text>
          <Group gap={6} mt={4}>
            <StatusBadge status={props.item.status} />
            {props.item.localVersion ? (
              <Text size="xs" c="dimmed">
                本地 {props.item.localVersion}
              </Text>
            ) : null}
            {props.item.remoteVersion &&
            (props.item.canUpdate || props.item.remoteVersion !== props.item.localVersion) ? (
              <Text size="xs" c="dimmed">
                远端 {props.item.remoteVersion}
              </Text>
            ) : null}
          </Group>
        </div>
      </Group>
      <Button
        size="xs"
        variant={props.item.canUpdate ? "filled" : "default"}
        disabled={props.busy || !props.item.enabled || !props.item.canUpdate}
        loading={props.item.status === "updating"}
        onClick={props.onUpdate}
      >
        更新
      </Button>
    </Group>
  );
}

function StatusBadge(props: { status: UpdateCenterItem["status"] }) {
  if (props.status === "available") {
    return (
      <Badge size="xs" color="blue" variant="light">
        可更新
      </Badge>
    );
  }
  if (props.status === "current") {
    return (
      <Badge size="xs" color="green" variant="light">
        最新
      </Badge>
    );
  }
  if (props.status === "failed") {
    return (
      <Badge size="xs" color="red" variant="light">
        失败
      </Badge>
    );
  }
  if (props.status === "checking" || props.status === "updating") {
    return (
      <Badge size="xs" color="gray" variant="light">
        处理中
      </Badge>
    );
  }
  return (
    <Badge size="xs" color="gray" variant="light">
      未检查
    </Badge>
  );
}
