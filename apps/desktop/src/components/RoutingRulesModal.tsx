import { useEffect, useState } from "react";
import { Badge, Button, Group, Switch, Text, TextInput, UnstyledButton } from "@mantine/core";
import { showToast } from "./Toast";
import { logUserErrorDiagnostic } from "../lib/appState";
import { describeUserError, shouldRecordDiagnostic, type UserErrorContext } from "../lib/userFacingErrors";
import { IconArrowLeft, IconChevronRight, IconPlus, IconRefresh, IconSearch, IconTrash } from "@tabler/icons-react";
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
  // 列表是主视图；添加和编辑共用同一个二级页（editing 为 null 表示添加）。
  const [view, setView] = useState<"list" | "edit">("list");
  const [editing, setEditing] = useState<ClientRoutingRuleDto | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [action, setAction] = useState<ClientRoutingRuleAction | null>(null);
  // 用户手动选过（或编辑已有规则）后，不再被查询结果自动改写。
  const [actionChosen, setActionChosen] = useState(false);
  const [testResult, setTestResult] = useState<ClientRoutingRuleTestResultDto | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // 只在打开时重置表单；令牌刷新只重新加载规则，不能丢掉正在编辑的内容。
  useEffect(() => {
    if (!props.opened) {
      return;
    }
    resetForm();
    setView("list");
  }, [props.opened]);

  useEffect(() => {
    if (!props.opened) {
      return;
    }
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
      const result = await testRoutingRule({
        value: normalizedValue,
        mode: props.mode,
        features: props.policies.features,
        customRoutingRules: rules.length > 0 ? rules : props.policies.customRoutingRules
      });
      setTestResult(result);
      // 强制规则的意义是改变现状，新建时默认选与当前结果相反的处理方式；每次新的查询都重新计算，手动选过的除外。
      if (!actionChosen) setAction(result.action === "proxy" ? "direct" : "proxy");
    } catch (reason) {
      setTestResult(null);
      showFailure(reason);
    } finally {
      setBusy(null);
    }
  }

  async function handleSave() {
    if (!trimmedValue) {
      setError("请输入要保存的域名或名称。");
      return;
    }
    if (!verified) {
      setError("域名已修改，请先查询当前输入再保存。");
      return;
    }
    if (!action) {
      setError("请选择强制直连或强制代理。");
      return;
    }

    setBusy("save");
    setError(null);
    try {
      const input = { name: name.trim() || null, value: trimmedValue, action };
      if (editing) {
        // 编辑不带 enabled：以服务端当前启停状态为准，避免用打开编辑页时的快照覆盖别处的改动。
        await updateRoutingRule(props.accessToken, editing.id, input);
      } else {
        await createRoutingRule(props.accessToken, { ...input, enabled: true });
      }
      backToList();
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
      backToList();
      await loadRules();
      await applyIfConnected("规则已删除");
    } catch (reason) {
      showFailure(reason);
    } finally {
      setBusy(null);
    }
  }

  function openAdd() {
    resetForm();
    setView("edit");
  }

  function openEdit(rule: ClientRoutingRuleDto) {
    resetForm();
    setEditing(rule);
    setName(rule.name ?? "");
    setValue(rule.value);
    setAction(rule.action);
    setActionChosen(true);
    setView("edit");
  }

  function backToList() {
    resetForm();
    setView("list");
  }

  function resetForm() {
    setEditing(null);
    setName("");
    setValue("");
    setAction(null);
    setActionChosen(false);
    setTestResult(null);
    setConfirmingDelete(false);
    setError(null);
  }

  const trimmedValue = value.trim();
  const queryReady = isCurrentQueryResult(testResult, trimmedValue);
  // 编辑时域名没改动就不必重新查询；改了域名或是新建，都要先查询确认匹配结果。
  const valueChanged = editing ? trimmedValue.toLowerCase() !== editing.value.trim().toLowerCase() : true;
  const verified = queryReady || (editing !== null && !valueChanged);
  const canSave = trimmedValue !== "" && verified && action !== null;
  const saveHint = !trimmedValue
    ? "输入域名或名称后，先查询匹配结果。"
    : !verified
      ? editing ? "域名已修改，请先查询再保存。" : "先查询匹配结果，再选择处理方式并保存。"
      : null;

  const editorTitle = editing ? "编辑规则" : "添加规则";
  const editorActions = confirmingDelete && editing ? (
    <>
      <Button variant="default" onClick={() => setConfirmingDelete(false)} disabled={busy !== null}>取消</Button>
      <Button color="red" loading={busy === `delete:${editing.id}`} disabled={busy !== null && busy !== `delete:${editing.id}`} onClick={() => void handleDelete(editing.id)}>
        确认删除
      </Button>
    </>
  ) : (
    <>
      <Button variant="default" onClick={backToList} disabled={busy !== null}>取消</Button>
      <Button loading={busy === "save"} disabled={!canSave || (busy !== null && busy !== "save")} onClick={() => void handleSave()}>保存</Button>
    </>
  );
  const editorFooterStart = confirmingDelete && editing ? (
    <Text size="xs" c="dimmed">确定删除这条规则？删除后无法恢复。</Text>
  ) : editing ? (
    <Button variant="subtle" color="red" size="compact-sm" leftSection={<IconTrash size={14} />} onClick={() => setConfirmingDelete(true)} disabled={busy !== null}>
      删除规则
    </Button>
  ) : null;

  return (
    <AppDialog
      opened={props.opened}
      onClose={props.onClose}
      size={520}
      title={view === "edit" ? editorTitle : "自定义分流"}
      closeLabel="关闭自定义分流"
      footerStart={view === "edit" ? editorFooterStart : null}
      actions={view === "edit" ? editorActions : null}
    >
      <div className={styles.stack}>
        {error ? <NoticeRow tone="danger" role="alert" action={error.code ? <ErrorCodeHint code={error.code} /> : null}>{error.message}</NoticeRow> : null}
        {props.connected ? (
          <NoticeRow tone="info" role="status">
            {props.reconnecting ? "正在重新连接，使分流规则立即生效…" : "当前已连接。保存、启停或删除规则后会自动重连生效。"}
          </NoticeRow>
        ) : null}

        {view === "list" ? (
          <section className={styles.rules} aria-labelledby="routing-rules-heading">
            <div className={styles.rulesHead}>
              <span className={styles.rulesTitle}>
                <span id="routing-rules-heading" className={styles.sectionTitle}>我的规则</span>
                <span className={styles.count}>{rules.length}</span>
              </span>
              <Group gap={4} wrap="nowrap">
                <Button size="compact-sm" variant="subtle" color="gray" leftSection={<IconRefresh size={14} />} loading={loading} onClick={() => void loadRules()}>
                  刷新
                </Button>
                <Button size="compact-sm" leftSection={<IconPlus size={14} />} onClick={openAdd}>
                  添加规则
                </Button>
              </Group>
            </div>

            {rules.length === 0 && !loading ? (
              <div className={styles.empty}>
                <Text size="sm" c="dimmed">暂无自定义分流规则。</Text>
                <Text size="xs" c="dimmed">为某个域名指定强制直连或强制代理，优先于内置分流。</Text>
                <Button variant="default" size="xs" leftSection={<IconPlus size={14} />} onClick={openAdd}>添加第一条规则</Button>
              </div>
            ) : (
              <div className={styles.list}>
                {rules.map((rule) => (
                  <div key={rule.id} className={styles.row} data-disabled={!rule.enabled || undefined}>
                    <Switch
                      size="sm"
                      checked={rule.enabled}
                      aria-label={rule.enabled ? "停用规则" : "启用规则"}
                      disabled={busy === `toggle:${rule.id}`}
                      onChange={(event) => void handleToggle(rule, event.currentTarget.checked)}
                    />
                    <UnstyledButton className={styles.rowButton} onClick={() => openEdit(rule)} aria-label={`编辑规则：${rule.name || rule.value}`}>
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
                      <IconChevronRight size={16} className={styles.rowChevron} aria-hidden="true" />
                    </UnstyledButton>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className={styles.editor} aria-label={editorTitle}>
            <Button
              className={styles.back}
              variant="subtle"
              color="gray"
              size="compact-sm"
              leftSection={<IconArrowLeft size={14} />}
              onClick={backToList}
              disabled={busy !== null}
            >
              返回规则列表
            </Button>

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

            {testResult ? <RoutingTestResult result={testResult} /> : saveHint ? (
              <Text size="xs" c="dimmed">{saveHint}</Text>
            ) : null}

            <TextInput
              label="显示名称"
              placeholder="可选，保存后便于识别"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />

            <div className={styles.field}>
              <span className={styles.fieldLabel}>处理方式</span>
              <Button.Group>
                <Button
                  fullWidth
                  variant={action === "direct" ? "filled" : "default"}
                  aria-pressed={action === "direct"}
                  onClick={() => { setAction("direct"); setActionChosen(true); }}
                  disabled={busy !== null}
                >
                  强制直连
                </Button>
                <Button
                  fullWidth
                  variant={action === "proxy" ? "filled" : "default"}
                  aria-pressed={action === "proxy"}
                  onClick={() => { setAction("proxy"); setActionChosen(true); }}
                  disabled={busy !== null}
                >
                  强制代理
                </Button>
              </Button.Group>
            </div>
          </section>
        )}
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
