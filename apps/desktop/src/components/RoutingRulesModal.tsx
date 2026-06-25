import { useEffect, useState } from "react";
import { ActionIcon, Alert, Badge, Button, Group, Modal, Paper, ScrollArea, SegmentedControl, Stack, Switch, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconEdit, IconRefresh, IconTrash } from "@tabler/icons-react";
import type { ClientRoutingRuleAction, ClientRoutingRuleDto, ClientRoutingRuleTestResultDto } from "@chordv/shared";
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
  onClose: () => void;
};

export function RoutingRulesModal(props: RoutingRulesModalProps) {
  const [rules, setRules] = useState<ClientRoutingRuleDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [action, setAction] = useState<ClientRoutingRuleAction>("proxy");
  const [testResult, setTestResult] = useState<ClientRoutingRuleTestResultDto | null>(null);

  useEffect(() => {
    if (props.opened) {
      void loadRules();
    }
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

  async function handleTest() {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      setError("请输入要检测的域名或关键词。");
      return;
    }
    setBusy("test");
    setError(null);
    try {
      setTestResult(await testRoutingRule(props.accessToken, normalizedValue));
    } catch (reason) {
      setError(getApiErrorRawMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function handleSave() {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      setError("请输入要保存的域名或关键词。");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const input = { name: name.trim() || null, value: normalizedValue, action, enabled: true };
      if (editingRuleId) {
        await updateRoutingRule(props.accessToken, editingRuleId, input);
      } else {
        await createRoutingRule(props.accessToken, input);
      }
      resetForm();
      await loadRules();
      notifications.show({
        color: props.connected ? "yellow" : "green",
        title: "规则已保存",
        message: props.connected ? "规则已保存，重连后生效。" : "规则已保存，下次连接生效。"
      });
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
      notifications.show({
        color: props.connected ? "yellow" : "green",
        title: enabled ? "规则已启用" : "规则已停用",
        message: props.connected ? "规则变更将在重连后生效。" : "规则变更将在下次连接生效。"
      });
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
      notifications.show({
        color: props.connected ? "yellow" : "green",
        title: "规则已删除",
        message: props.connected ? "删除结果将在重连后生效。" : "删除结果将在下次连接生效。"
      });
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
    setAction(rule.action);
    setTestResult(null);
  }

  function resetForm() {
    setEditingRuleId(null);
    setName("");
    setValue("");
    setAction("proxy");
    setTestResult(null);
  }

  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      centered
      size="lg"
      title="自定义分流"
    >
      <Stack gap="md">
        {error ? <Alert color="red">{error}</Alert> : null}

        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Group grow align="flex-end">
              <TextInput
                label="名称"
                placeholder="可选，例如视频服务"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <TextInput
                label="域名或关键词"
                placeholder="example.com 或 youtube"
                value={value}
                onChange={(event) => {
                  setValue(event.currentTarget.value);
                  setTestResult(null);
                }}
              />
            </Group>
            <SegmentedControl
              value={action}
              onChange={(nextAction) => setAction(nextAction as ClientRoutingRuleAction)}
              data={[
                { value: "proxy", label: "强制代理" },
                { value: "direct", label: "强制直连" }
              ]}
            />
            {testResult ? (
              <Alert color={testResult.action === "proxy" ? "blue" : "green"} variant="light">
                {testResult.message}
              </Alert>
            ) : null}
            <Group justify="space-between">
              <Button variant="default" onClick={resetForm} disabled={busy !== null}>
                {editingRuleId ? "取消编辑" : "清空"}
              </Button>
              <Group>
                <Button variant="light" onClick={() => void handleTest()} loading={busy === "test"}>
                  检测
                </Button>
                <Button onClick={() => void handleSave()} loading={busy === "save"}>
                  {editingRuleId ? "保存修改" : "保存规则"}
                </Button>
              </Group>
            </Group>
          </Stack>
        </Paper>

        <Group justify="space-between">
          <Text fw={700}>我的规则</Text>
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

        <ScrollArea.Autosize mah={320} type="auto">
          <Stack gap="sm">
            {rules.length === 0 && !loading ? (
              <Paper withBorder radius="md" p="lg">
                <Text c="dimmed" ta="center">
                  还没有自定义分流规则。
                </Text>
              </Paper>
            ) : null}
            {rules.map((rule) => (
              <Paper key={rule.id} withBorder radius="md" p="sm">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <Stack gap={4}>
                    <Group gap="xs">
                      <Text fw={700}>{rule.name || rule.value}</Text>
                      <Badge color={rule.action === "proxy" ? "blue" : "green"} variant="light">
                        {rule.action === "proxy" ? "强制代理" : "强制直连"}
                      </Badge>
                      <Badge color="gray" variant="light">
                        {rule.matchType === "domain" ? "域名" : "关键词"}
                      </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                      {rule.matchType === "domain" ? `domain:${rule.value}` : `keyword:${rule.value}`}
                    </Text>
                  </Stack>
                  <Group gap="xs" wrap="nowrap">
                    <Switch
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
          </Stack>
        </ScrollArea.Autosize>
      </Stack>
    </Modal>
  );
}
