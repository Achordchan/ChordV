import { useEffect, useMemo, useState } from "react";
import { ActionIcon, Badge, Button, Collapse, Group, Switch, Text, TextInput, UnstyledButton } from "@mantine/core";
import { showToast } from "./Toast";
import { logUserErrorDiagnostic } from "../lib/appState";
import { describeUserError, shouldRecordDiagnostic, type UserErrorContext } from "../lib/userFacingErrors";
import {
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX
} from "@tabler/icons-react";
import { AppDialog, ErrorCodeHint } from "./AppDialog";
import { NoticeRow } from "./NoticeRow";
import styles from "./RoutingRulesModal.module.css";
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
  const [error, setErrorState] = useState<{ message: string; code: string | null } | null>(null);
  // 失败原因统一经过客户文案映射；错误编号单独用「错误编号 + 复制」展示。
  const setError = (message: string | null) => setErrorState(message ? { message, code: null } : null);
  const showFailure = (reason: unknown, context?: UserErrorContext) => {
    const failure = describeUserError(reason, { context });
    if (shouldRecordDiagnostic(failure)) logUserErrorDiagnostic(failure, context ?? "general");
    setErrorState({ message: failure.message, code: failure.code });
  };
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
      showFailure(reason);
    } finally {
      setLoading(false);
    }
  }


  async function applyIfConnected(title: string) {
    if (!props.connected) {
      showToast({
        tone: "success",
        title,
        message: "规则已保存，下次连接生效。"
      });
      return;
    }
    showToast({
      tone: "info",
      title,
      message: "规则已保存，正在重新连接以立即生效。"
    });
    try {
      const result = await props.onApplyWhileConnected?.();
      if (result === false) {
        showToast({
          tone: "warning",
          title: "稍后手动重连",
          message: "规则已保存，当前有其他操作进行中，请稍后手动重新连接。"
        });
      }
    } catch (reason) {
      showFailure(reason, "connect");
      showToast({
        tone: "danger",
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
      showFailure(reason);
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
      showFailure(reason);
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
      showFailure(reason);
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
      showFailure(reason);
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
    <AppDialog opened={props.opened} onClose={props.onClose} size={520} title="自定义分流" closeLabel="关闭自定义分流">
      <div className={styles.stack}>
        {error ? <NoticeRow tone="danger" role="alert" action={error.code ? <ErrorCodeHint code={error.code} /> : null}>{error.message}</NoticeRow> : null}
        {props.connected ? (
          <NoticeRow tone="info" role="status">
            {props.reconnecting ? "正在重新连接，使分流规则立即生效…" : "当前已连接。保存、启停或删除规则后会自动重连生效。"}
          </NoticeRow>
        ) : null}

        <section className={styles.query} aria-label="查询与保存规则">
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
              variant="default"
              leftSection={<IconSearch size={15} />}
              onClick={() => void handleTest()}
              loading={busy === "test"}
              disabled={busy !== null && busy !== "test"}
            >
              查询
            </Button>
          </Group>

          {testResult ? <RoutingTestResult result={testResult} /> : (
            <Text size="xs" c="dimmed">先查询匹配结果，再选择强制直连或强制代理。</Text>
          )}

          {queryReady ? (
            <>
              {showNameField ? (
                <TextInput
                  label="显示名称"
                  placeholder="可选，保存后便于识别"
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              ) : null}
              <div className={styles.saveRow}>
                {editingRuleId ? (
                  <Text size="xs" c="dimmed" className={styles.saveHint}>正在编辑已有规则，保存前需要重新查询。</Text>
                ) : <span className={styles.saveHint} />}
                <Group gap="xs" wrap="nowrap">
                  {editingRuleId ? (
                    <Button variant="subtle" color="gray" onClick={resetForm} disabled={busy !== null}>
                      取消编辑
                    </Button>
                  ) : null}
                  <Button
                    variant="default"
                    loading={busy === "save:direct"}
                    disabled={busy !== null && busy !== "save:direct"}
                    onClick={() => void handleSave("direct")}
                  >
                    强制直连
                  </Button>
                  <Button
                    loading={busy === "save:proxy"}
                    disabled={busy !== null && busy !== "save:proxy"}
                    onClick={() => void handleSave("proxy")}
                  >
                    强制代理
                  </Button>
                </Group>
              </div>
            </>
          ) : editingRuleId ? (
            <div className={styles.saveRow}>
              <Text size="xs" c="dimmed" className={styles.saveHint}>正在编辑已有规则，请重新查询后再保存。</Text>
              <Button variant="subtle" color="gray" leftSection={<IconX size={14} />} onClick={resetForm} disabled={busy !== null}>
                取消编辑
              </Button>
            </div>
          ) : null}
        </section>

        <section className={styles.rules} aria-labelledby="routing-rules-heading">
          <div className={styles.rulesHead}>
            <UnstyledButton
              className={styles.rulesToggle}
              onClick={() => setRulesExpanded((current) => !current)}
              aria-expanded={rulesExpanded}
              aria-label={rulesExpanded ? "折叠我的规则" : "展开我的规则"}
            >
              {rulesExpanded ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
              <span id="routing-rules-heading" className={styles.sectionTitle}>我的规则</span>
              <span className={styles.count}>{rules.length}</span>
            </UnstyledButton>
            <Button
              size="compact-sm"
              variant="subtle"
              color="gray"
              leftSection={<IconRefresh size={14} />}
              loading={loading}
              onClick={() => void loadRules()}
            >
              刷新
            </Button>
          </div>

          <Collapse in={rulesExpanded}>
            {rules.length === 0 && !loading ? (
              <Text size="sm" c="dimmed" className={styles.empty}>暂无自定义分流规则。</Text>
            ) : (
              <div className={styles.list}>
                {visibleRules.map((rule) => (
                  <div key={rule.id} className={styles.row} data-disabled={!rule.enabled || undefined}>
                    <div className={styles.rowMain}>
                      <div className={styles.rowTitle}>
                        <Text size="sm" fw={600} lineClamp={1} className={styles.rowName}>
                          {rule.name || rule.value}
                        </Text>
                        <Badge size="xs" color={rule.action === "proxy" ? "cyan" : "green"} variant="light">
                          {rule.action === "proxy" ? "强制代理" : "强制直连"}
                        </Badge>
                        <Badge size="xs" color="gray" variant="light">
                          {rule.matchType === "domain" ? "域名" : "关键词"}
                        </Badge>
                      </div>
                      {rule.name ? (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {rule.matchType === "domain" ? `domain:${rule.value}` : `keyword:${rule.value}`}
                        </Text>
                      ) : null}
                    </div>
                    <Group gap={4} wrap="nowrap">
                      <Switch
                        size="sm"
                        checked={rule.enabled}
                        aria-label={rule.enabled ? "停用规则" : "启用规则"}
                        disabled={busy === `toggle:${rule.id}`}
                        onChange={(event) => void handleToggle(rule, event.currentTarget.checked)}
                      />
                      <ActionIcon variant="subtle" color="gray" aria-label="编辑规则" onClick={() => startEdit(rule)}>
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
                  </div>
                ))}
              </div>
            )}
            {hiddenCount > 0 ? (
              <Button variant="subtle" size="compact-sm" mt={6} onClick={() => setShowAllRules((current) => !current)}>
                {showAllRules ? "收起规则" : `展开全部 ${rules.length} 条`}
              </Button>
            ) : null}
          </Collapse>
        </section>
      </div>
    </AppDialog>
  );
}

function RoutingTestResult(props: { result: ClientRoutingRuleTestResultDto }) {
  const proxy = props.result.action === "proxy";
  return (
    <NoticeRow tone={proxy ? "info" : "success"} role="status">
      <div className={styles.resultHead}>
        <span className={styles.resultLabel}>{proxy ? "当前规则：代理" : "当前规则：直连"}</span>
        <span className={styles.resultMeta}>
          {props.result.matchType === "domain" ? "域名" : "名称"}
          {typeof props.result.elapsedMs === "number" ? ` · 查询耗时 ${props.result.elapsedMs}ms` : ""}
        </span>
      </div>
      <div>{props.result.message}</div>
    </NoticeRow>
  );
}

function isCurrentQueryResult(result: ClientRoutingRuleTestResultDto | null, value: string) {
  return Boolean(result && value && result.input.trim().toLowerCase() === value.trim().toLowerCase());
}
