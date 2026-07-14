import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Collapse,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
  UnstyledButton
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX
} from "@tabler/icons-react";
import type {
  ClientRoutingRuleAction,
  ClientRoutingRuleDto,
  ClientRoutingRuleTestResultDto,
  ConnectionMode,
  PolicyBundleDto
} from "@chordv/shared";
import {
  createRoutingRule,
  deleteRoutingRule,
  fetchRoutingRules,
  getApiErrorRawMessage,
  testRoutingRule,
  updateRoutingRule
} from "../api/client";

type RoutingRulesModalProps = {
  opened: boolean;
  accessToken: string;
  connected: boolean;
  mode: ConnectionMode;
  policies: PolicyBundleDto;
  reconnecting?: boolean;
  onClose: () => void;
  /** 已连接时规则变更后触发，用于自动重连使规则立即生效 */
  onApplyWhileConnected?: () => Promise<boolean | void> | boolean | void;
};

export function RoutingRulesModal(props: RoutingRulesModalProps) {
  const [rules, setRules] = useState<ClientRoutingRuleDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [testResult, setTestResult] = useState<ClientRoutingRuleTestResultDto | null>(null);
  const [rulesExpanded, setRulesExpanded] = useState(true);
  const [showAllRules, setShowAllRules] = useState(false);

  useEffect(() => {
    if (!props.opened) {
      return;
    }
    setShowAllRules(false);
    void loadRules();
  }, [props.opened, props.accessToken]);

  async function loadRules() {
    setLoading(true);
    setError(null);
    try {
      setRules(await fetchRoutingRules(props.accessToken));
    } catch (reason) {
      setError(getApiErrorRawMessage(reason));
    } finally {
      setLoading(false);
    }
  }


  async function applyIfConnected(title: string) {
    if (!props.connected) {
      notifications.show({
        color: "green",
        title,
        message: "规则已保存，下次连接生效。"
      });
      return;
    }
    notifications.show({
      color: "blue",
      title,
      message: "规则已保存，正在重新连接以立即生效。"
    });
    try {
      const result = await props.onApplyWhileConnected?.();
      if (result === false) {
        notifications.show({
          color: "yellow",
          title: "稍后手动重连",
          message: "规则已保存，当前有其他操作进行中，请稍后手动重新连接。"
        });
      }
    } catch (reason) {
      setError(getApiErrorRawMessage(reason) || "自动重连失败，请手动重新连接。");
      notifications.show({
        color: "red",
        title: "自动重连失败",
        message: "规则已保存，但重连未完成，请手动重新连接。"
      });
    }
  }

  async function handleTest() {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      setError("请输入要检测的域名或名称。");
      return;
    }
    setBusy("test");
    setError(null);
    try {
      setTestResult(
        await testRoutingRule({
          value: normalizedValue,
          mode: props.mode,
          features: props.policies.features,
          customRoutingRules: rules.length > 0 ? rules : props.policies.customRoutingRules
        })
      );
    } catch (reason) {
      setTestResult(null);
      setError(getApiErrorRawMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function handleSave(nextAction: ClientRoutingRuleAction) {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      setError("请输入要保存的域名或名称。");
      return;
    }
    if (!isCurrentQueryResult(testResult, normalizedValue)) {
      setError("请先查询当前输入，再选择强制直连或强制代理。");
      return;
    }

    setBusy(`save:${nextAction}`);
    setError(null);
    try {
      const input = { name: name.trim() || null, value: normalizedValue, action: nextAction, enabled: true };
      if (editingRuleId) {
        await updateRoutingRule(props.accessToken, editingRuleId, input);
      } else {
        await createRoutingRule(props.accessToken, input);
      }
      resetForm();
      await loadRules();
      await applyIfConnected("规则已保存");
    } catch (reason) {
      setError(getApiErrorRawMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function handleToggle(rule: ClientRoutingRuleDto, enabled: boolean) {
    setBusy(`toggle:${rule.id}`);
    setError(null);
    try {
      await updateRoutingRule(props.accessToken, rule.id, { enabled });
      await loadRules();
      await applyIfConnected(enabled ? "规则已启用" : "规则已停用");
    } catch (reason) {
      setError(getApiErrorRawMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(ruleId: string) {
    setBusy(`delete:${ruleId}`);
    setError(null);
    try {
      await deleteRoutingRule(props.accessToken, ruleId);
      if (editingRuleId === ruleId) {
        resetForm();
      }
      await loadRules();
      await applyIfConnected("规则已删除");
    } catch (reason) {
      setError(getApiErrorRawMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  function startEdit(rule: ClientRoutingRuleDto) {
    setEditingRuleId(rule.id);
    setName(rule.name ?? "");
    setValue(rule.value);
    setTestResult(null);
    setRulesExpanded(true);
  }

  function resetForm() {
    setEditingRuleId(null);
    setName("");
    setValue("");
    setTestResult(null);
    setError(null);
  }

  const trimmedValue = value.trim();
  const queryReady = isCurrentQueryResult(testResult, trimmedValue);
  const showNameField = queryReady || Boolean(editingRuleId);
  const previewCount = 5;
  const visibleRules = useMemo(
    () => (showAllRules ? rules : rules.slice(0, previewCount)),
    [rules, showAllRules]
  );
  const hiddenCount = Math.max(rules.length - previewCount, 0);

  return (
    <Modal opened={props.opened} onClose={props.onClose} centered size="lg" title="自定义分流">
      <Stack gap="md">
        {error ? <Alert color="red">{error}</Alert> : null}
        {props.connected ? (
          <Alert color="blue" variant="light">
            {props.reconnecting ? "正在重新连接，使分流规则立即生效…" : "当前已连接。保存、启停或删除规则后会自动重连生效。"}
          </Alert>
        ) : null}

        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Group align="flex-end" wrap="nowrap" gap="sm">
              <TextInput
                style={{ flex: 1, minWidth: 0 }}
                label="域名或名称"
                placeholder="example.com 或 youtube"
                value={value}
                onChange={(event) => {
                  setValue(event.currentTarget.value);
                  setTestResult(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleTest();
                  }
                }}
              />
              <Button
                variant="light"
                leftSection={<IconSearch size={16} />}
                onClick={() => void handleTest()}
                loading={busy === "test"}
                disabled={busy !== null && busy !== "test"}
              >
                查询
              </Button>
            </Group>

            <Text size="sm" c="dimmed">
              先查询匹配结果，再选择强制直连或强制代理。
            </Text>

            {testResult ? <RoutingTestResultCard result={testResult} /> : null}

            {queryReady ? (
              <Stack gap="sm">
                {showNameField ? (
                  <TextInput
                    label="显示名称"
                    placeholder="可选，保存后便于识别"
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                  />
                ) : null}
                <Group justify="space-between" align="center" wrap="wrap">
                  <Group gap="xs">
                    <Button
                      variant="light"
                      color="green"
                      loading={busy === "save:direct"}
                      disabled={busy !== null && busy !== "save:direct"}
                      onClick={() => void handleSave("direct")}
                    >
                      强制直连
                    </Button>
                    <Button
                      color="blue"
                      loading={busy === "save:proxy"}
                      disabled={busy !== null && busy !== "save:proxy"}
                      onClick={() => void handleSave("proxy")}
                    >
                      强制代理
                    </Button>
                  </Group>
                  {editingRuleId ? (
                    <Button
                      variant="subtle"
                      color="gray"
                      leftSection={<IconX size={14} />}
                      onClick={resetForm}
                      disabled={busy !== null}
                    >
                      取消编辑
                    </Button>
                  ) : null}
                </Group>
                {editingRuleId ? (
                  <Text size="sm" c="dimmed">
                    正在编辑已有规则，保存前需要重新查询。
                  </Text>
                ) : null}
              </Stack>
            ) : editingRuleId ? (
              <Group justify="space-between" align="center">
                <Text size="sm" c="dimmed">
                  正在编辑已有规则，请重新查询后再保存。
                </Text>
                <Button
                  variant="subtle"
                  color="gray"
                  leftSection={<IconX size={14} />}
                  onClick={resetForm}
                  disabled={busy !== null}
                >
                  取消编辑
                </Button>
              </Group>
            ) : null}
          </Stack>
        </Paper>

        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <UnstyledButton
              onClick={() => setRulesExpanded((current) => !current)}
              style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
              aria-label={rulesExpanded ? "折叠我的规则" : "展开我的规则"}
            >
              {rulesExpanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
              <Text fw={700}>我的规则</Text>
              <Badge color="gray" variant="light">
                {rules.length}
              </Badge>
            </UnstyledButton>
            <Button
              size="compact-sm"
              variant="subtle"
              leftSection={<IconRefresh size={14} />}
              loading={loading}
              onClick={() => void loadRules()}
            >
              刷新
            </Button>
          </Group>

          <Collapse in={rulesExpanded}>
            <ScrollArea.Autosize mah={280} type="auto">
              <Stack gap={6}>
                {rules.length === 0 && !loading ? (
                  <Paper withBorder radius="md" p="md">
                    <Text c="dimmed" ta="center" size="sm">
                      暂无自定义分流规则。
                    </Text>
                  </Paper>
                ) : null}

                {visibleRules.map((rule) => (
                  <Paper key={rule.id} withBorder radius="md" px="sm" py={8}>
                    <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
                      <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                          <Text fw={700} lineClamp={1} style={{ minWidth: 0 }}>
                            {rule.name || rule.value}
                          </Text>
                          <Badge color={rule.action === "proxy" ? "blue" : "green"} variant="light">
                            {rule.action === "proxy" ? "强制代理" : "强制直连"}
                          </Badge>
                          <Badge color="gray" variant="light">
                            {rule.matchType === "domain" ? "域名" : "关键词"}
                          </Badge>
                        </Group>
                        {rule.name ? (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {rule.matchType === "domain" ? `domain:${rule.value}` : `keyword:${rule.value}`}
                          </Text>
                        ) : null}
                      </Stack>
                      <Group gap={4} wrap="nowrap">
                        <Switch
                          size="sm"
                          checked={rule.enabled}
                          disabled={busy === `toggle:${rule.id}`}
                          onChange={(event) => void handleToggle(rule, event.currentTarget.checked)}
                        />
                        <ActionIcon variant="subtle" aria-label="编辑规则" onClick={() => startEdit(rule)}>
                          <IconEdit size={16} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label="删除规则"
                          loading={busy === `delete:${rule.id}`}
                          onClick={() => void handleDelete(rule.id)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    </Group>
                  </Paper>
                ))}

                {hiddenCount > 0 ? (
                  <Button variant="subtle" size="compact-sm" onClick={() => setShowAllRules((current) => !current)}>
                    {showAllRules ? "收起规则" : `展开全部 ${rules.length} 条`}
                  </Button>
                ) : null}
              </Stack>
            </ScrollArea.Autosize>
          </Collapse>
        </Stack>
      </Stack>
    </Modal>
  );
}

function RoutingTestResultCard(props: { result: ClientRoutingRuleTestResultDto }) {
  const actionLabel = props.result.action === "proxy" ? "当前规则：代理" : "当前规则：直连";
  const color = props.result.action === "proxy" ? "blue" : "green";

  return (
    <Alert color={color} variant="light">
      <Stack gap={4}>
        <Group gap="xs">
          <Badge color={color}>{actionLabel}</Badge>
          <Badge color="gray" variant="light">
            {props.result.matchType === "domain" ? "域名" : "名称"}
          </Badge>
        </Group>
        <Text size="sm">{props.result.message}</Text>
        {typeof props.result.elapsedMs === "number" ? (
          <Text size="xs" c="dimmed">
            查询耗时：{props.result.elapsedMs}ms
          </Text>
        ) : null}
      </Stack>
    </Alert>
  );
}

function isCurrentQueryResult(result: ClientRoutingRuleTestResultDto | null, value: string) {
  return Boolean(result && value && result.input.trim().toLowerCase() === value.trim().toLowerCase());
}
