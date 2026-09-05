import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Collapse,
  Divider,
  Group,
  Loader,
  Modal,
  Popover,
  ScrollArea,
  Stack,
  Text,
  Tooltip
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
  SystemUpdateCheckDto,
  SystemUpdateOperationDto,
  SystemUpdateRollbackVersionDto
} from "@chordv/shared";
import {
  checkSystemUpdate,
  fetchRollbackVersions,
  fetchSystemOperation,
  fetchSystemOperations,
  fetchSystemVersion,
  startSystemRestart,
  startSystemRollback,
  startSystemUpdate,
  type SystemRuntimeStatusDto
} from "./api";

type BusyKind = "update" | "rollback" | "restart";
type Phase = "idle" | "running" | "reconnecting" | "done";

const POLL_INTERVAL_MS = 3000;
// We do NOT cap polling by wall-clock while the operation is still reachable: as long
// as the backend answers with a non-terminal status, the operation is demonstrably
// live and we keep waiting. We only give up after the API has been CONTINUOUSLY
// unreachable longer than the supervisor's worst-case DARK window (app exited → back
// serving), which must cover EVERY supervisor-side step done while the port is closed:
//   pre-migration snapshot (CHORDV_SYSTEM_UPDATE_SNAPSHOT_TIMEOUT, default 600s)
// + migration              (CHORDV_SYSTEM_MIGRATE_TIMEOUT,          default 900s)
// + health gate            (~90s) + stabilization (~10s) + restart overhead
//   ≈ 27 min. 40 min leaves margin above the full configured dark window so a valid,
// still-applying operation is never declared timed-out and its controls re-enabled.
// The absolute backstop (counted from start, including the app-side download/extract
// phase while still reachable) guards a backend bug that wedges an op "running".
const MAX_UNREACHABLE_MS = 40 * 60 * 1000;
const ABSOLUTE_MAX_MS = 90 * 60 * 1000;

function parseErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through
  }
  return raw;
}

function statusColor(status: SystemUpdateOperationDto["status"]): string {
  switch (status) {
    case "succeeded":
      return "teal";
    case "failed":
      return "red";
    case "rolled_back":
      return "orange";
    default:
      return "blue";
  }
}

function statusLabel(status: SystemUpdateOperationDto["status"]): string {
  switch (status) {
    case "pending":
      return "等待中";
    case "running":
      return "进行中";
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
    case "rolled_back":
      return "已回滚";
    default:
      return status;
  }
}

function kindLabel(kind: SystemUpdateOperationDto["kind"]): string {
  return kind === "update" ? "更新" : kind === "rollback" ? "回滚" : "重启";
}

export function SystemUpdateBadge() {
  const [opened, setOpened] = useState(false);
  const [runtime, setRuntime] = useState<SystemRuntimeStatusDto | null>(null);
  const [check, setCheck] = useState<SystemUpdateCheckDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [rollbackVersions, setRollbackVersions] = useState<SystemUpdateRollbackVersionDto[]>([]);
  const [operations, setOperations] = useState<SystemUpdateOperationDto[]>([]);
  const [showRollback, setShowRollback] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [activeOp, setActiveOp] = useState<SystemUpdateOperationDto | null>(null);
  const [confirm, setConfirm] = useState<{ kind: BusyKind; version?: string; title: string; body: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const pollTimer = useRef<number | null>(null);
  const polledOpId = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, []);

  const loadRuntime = useCallback(async () => {
    try {
      const status = await fetchSystemVersion();
      if (mounted.current) setRuntime(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  const runCheck = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      const result = await checkSystemUpdate(force);
      if (mounted.current) setCheck(result);
    } catch (error) {
      if (mounted.current) {
        notifications.show({ color: "red", title: "检查更新失败", message: parseErrorMessage(error) });
      }
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, []);

  const loadAux = useCallback(async () => {
    try {
      const [versions, ops] = await Promise.all([fetchRollbackVersions(), fetchSystemOperations(20)]);
      if (mounted.current) {
        setRollbackVersions(versions);
        setOperations(ops);
      }
    } catch {
      // best-effort
    }
  }, []);

  const finishPolling = useCallback(
    async (op: SystemUpdateOperationDto | null) => {
      polledOpId.current = null;
      setActiveOp(op);
      setPhase("done");
      setBusy(null);
      // Reload runtime FIRST: for a rollback, op.toVersion is deliberately the
      // release that FAILED (preserved for audit), so the actual landing version
      // is the refreshed running version, not op.toVersion.
      const status = await loadRuntime();
      const landingVersion = status?.currentVersion ?? null;
      await runCheck(true);
      await loadAux();
      if (!op) {
        notifications.show({ color: "teal", title: "服务已恢复", message: "服务已重新上线。" });
        return;
      }
      if (op.status === "succeeded") {
        notifications.show({ color: "teal", title: "操作成功", message: `已完成${kindLabel(op.kind)}，当前版本 v${landingVersion ?? op.toVersion ?? ""}。` });
      } else if (op.status === "rolled_back") {
        notifications.show({
          color: "orange",
          title: "已自动回滚",
          message: `${kindLabel(op.kind)} v${op.toVersion ?? "?"} 未通过健康检查，已自动回滚到 v${landingVersion ?? "上一版本"}，服务未受影响。${op.migrationApplied ? "注意：本次已执行数据库迁移，代码已回滚但库结构未回退，请人工确认。" : ""}`
        });
      } else if (op.status === "failed") {
        notifications.show({ color: "red", title: "操作失败", message: op.failureReason ?? "未知原因" });
      }
    },
    [loadAux, loadRuntime, runCheck]
  );

  const pollOperation = useCallback(
    (operationId: string, startedAt: number) => {
      // lastContactAt advances on every successful poll (op reachable, even while
      // running). We only time out when the API has been unreachable for longer than
      // MAX_UNREACHABLE_MS — never while the operation is still answering — so a slow
      // snapshot/migration can't make the UI wrongly declare failure and re-enable
      // controls mid-update. See the constant comments for the worst-case derivation.
      let lastContactAt = startedAt;
      const giveUp = (message: string) => {
        polledOpId.current = null;
        setPhase("done");
        setBusy(null);
        notifications.show({ color: "yellow", title: "状态确认超时", message });
      };
      const tick = async () => {
        if (!mounted.current) return;
        if (Date.now() - startedAt > ABSOLUTE_MAX_MS) {
          giveUp("操作已超过最长跟踪时间仍未确认到最终状态，请稍后手动刷新查看结果。");
          return;
        }
        try {
          const op = await fetchSystemOperation(operationId);
          if (!mounted.current) return;
          lastContactAt = Date.now();
          if (op && (op.status === "succeeded" || op.status === "failed" || op.status === "rolled_back")) {
            await finishPolling(op);
            return;
          }
          // Still running and reachable — keep waiting, no matter how long.
          if (op) setActiveOp(op);
          setPhase("running");
        } catch {
          if (!mounted.current) return;
          // Unreachable = the container is restarting / migrating on the new (or
          // rolled-back) version. Only give up if this has persisted past the
          // supervisor's worst-case dark window.
          if (Date.now() - lastContactAt > MAX_UNREACHABLE_MS) {
            giveUp("服务长时间未恢复，请稍后手动刷新查看结果。");
            return;
          }
          setPhase("reconnecting");
        }
        pollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
      };
      pollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    },
    [finishPolling]
  );

  const beginOperation = useCallback(
    async (kind: BusyKind, version?: string) => {
      setBusy(kind);
      setPhase("running");
      setActiveOp(null);
      try {
        const result =
          kind === "update"
            ? await startSystemUpdate(version) // version carries the confirmed target
            : kind === "rollback"
              ? await startSystemRollback(version)
              : await startSystemRestart();
        notifications.show({ color: "blue", title: "任务已开始", message: result.message });
        polledOpId.current = result.operationId;
        pollOperation(result.operationId, Date.now());
      } catch (error) {
        setBusy(null);
        setPhase("idle");
        notifications.show({ color: "red", title: "无法启动任务", message: parseErrorMessage(error) });
      }
    },
    [pollOperation]
  );

  // Resume following an operation that is already running on the backend (page
  // reload, panel reopened mid-update, or one started by another admin) instead
  // of showing normal enabled controls while the task is still live.
  const resumeActiveOperation = useCallback(async () => {
    if (polledOpId.current) return;
    try {
      const ops = await fetchSystemOperations(5);
      const active = ops.find((op) => op.status === "running" || op.status === "pending");
      if (active && !polledOpId.current && mounted.current) {
        polledOpId.current = active.operationId;
        setActiveOp(active);
        setBusy(active.kind);
        setPhase("running");
        pollOperation(active.operationId, Date.now());
      }
    } catch {
      // best-effort
    }
  }, [pollOperation]);

  // Initial load: current version + a cached update check + resume any live op.
  useEffect(() => {
    void (async () => {
      const status = await loadRuntime();
      if (status?.enabled) {
        void runCheck(false);
        void resumeActiveOperation();
      }
    })();
  }, [loadRuntime, runCheck, resumeActiveOperation]);

  useEffect(() => {
    if (!opened) return;
    void (async () => {
      // Reload runtime status on every open, not just on mount: if the initial mount
      // load failed during a brief API restart / network blip, `runtime` stays null
      // and every control is disabled until a full page reload. Reopening the popover
      // now re-fetches it and, once enabled, refreshes the update check too — so the
      // panel self-heals instead of stranding the admin on stale disabled controls.
      const status = await loadRuntime();
      if (status?.enabled) void runCheck(false);
      void loadAux();
      void resumeActiveOperation();
    })();
  }, [opened, loadRuntime, runCheck, loadAux, resumeActiveOperation]);

  const requestConfirm = (next: { kind: BusyKind; version?: string; title: string; body: string }) => {
    setConfirm(next);
  };

  // Guard against a rapid double-click submitting the operation twice: the second
  // send would 409 (an op is already in flight) and reset busy/phase, leaving the
  // UI showing normal controls while an update is actually running. `submitting`
  // (plus the button's disabled/loading state) makes the confirm one-shot.
  const confirmProceed = async () => {
    if (!confirm || submitting) return;
    const { kind, version } = confirm;
    setSubmitting(true);
    try {
      await beginOperation(kind, version);
    } finally {
      setSubmitting(false);
      setConfirm(null);
    }
  };

  const currentVersion = runtime?.currentVersion ?? check?.currentVersion ?? "—";
  const hasUpdate = Boolean(check?.hasUpdate);
  const enabled = runtime?.enabled ?? false;
  const inProgress = busy !== null && phase !== "done";

  return (
    <>
      <Popover opened={opened} onChange={setOpened} position="bottom-start" width={360} shadow="md" withArrow>
        <Popover.Target>
          <Tooltip label="后台系统版本" openDelay={400}>
            <Badge
              variant={hasUpdate ? "filled" : "light"}
              color={inProgress ? "blue" : hasUpdate ? "orange" : "gray"}
              tt="none"
              style={{ cursor: "pointer" }}
              onClick={() => setOpened((v) => !v)}
              leftSection={inProgress ? <Loader size={10} color="white" /> : undefined}
            >
              {inProgress ? "更新中" : `v${currentVersion}`}
              {hasUpdate && !inProgress ? " ●" : ""}
            </Badge>
          </Tooltip>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="sm">
            <Group justify="space-between" align="center">
              <div>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                  后台系统版本
                </Text>
                <Text fw={600}>v{currentVersion}</Text>
              </div>
              <Button
                size="xs"
                variant="subtle"
                loading={checking}
                disabled={inProgress || !enabled}
                onClick={() => void runCheck(true)}
              >
                检查更新
              </Button>
            </Group>

            {!enabled ? (
              <Alert color="gray" variant="light" p="xs">
                <Text size="xs">当前环境未启用系统自更新（仅生产容器部署可用）。</Text>
              </Alert>
            ) : null}

            {check?.warning ? (
              <Alert color="yellow" variant="light" p="xs">
                <Text size="xs">{check.warning}</Text>
              </Alert>
            ) : null}

            {inProgress ? (
              <Alert color="blue" variant="light" p="xs">
                <Group gap="xs" wrap="nowrap">
                  <Loader size="xs" />
                  <Text size="xs">
                    {phase === "reconnecting"
                      ? "服务重启中，正在重新连接…请勿关闭页面。"
                      : busy === "restart"
                        ? "正在重启服务…"
                        : busy === "rollback"
                          ? "正在回滚并重启服务…"
                          : "正在下载并应用更新（下载 → 校验 → 迁移 → 切换 → 重启）…"}
                  </Text>
                </Group>
              </Alert>
            ) : null}

            {enabled && !inProgress && hasUpdate && check?.release ? (
              <Stack gap={6}>
                <Group gap="xs">
                  <Badge color="orange" variant="light">
                    新版本 v{check.release.version}
                  </Badge>
                  {check.release.htmlUrl ? (
                    <Text
                      size="xs"
                      c="blue"
                      component="a"
                      href={check.release.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      更新日志 ↗
                    </Text>
                  ) : null}
                </Group>
                {check.release.changelog.length > 0 ? (
                  <ScrollArea.Autosize mah={120}>
                    <Stack gap={2}>
                      {check.release.changelog.map((line, index) => (
                        <Text key={index} size="xs" c="dimmed">
                          • {line}
                        </Text>
                      ))}
                    </Stack>
                  </ScrollArea.Autosize>
                ) : null}
                <Button
                  size="xs"
                  color="orange"
                  onClick={() =>
                    requestConfirm({
                      kind: "update",
                      // Bind to the reviewed version: the backend refuses to install a
                      // different release than this if a newer one was just published.
                      version: check.release?.version,
                      title: "确认更新",
                      body: `将更新至 v${check.release?.version} 并重启服务，期间管理端会短暂不可用。确认继续？`
                    })
                  }
                >
                  立即更新
                </Button>
              </Stack>
            ) : null}

            {enabled && !inProgress && !checking && check && !check.hasUpdate && !check.warning ? (
              <Text size="xs" c="teal">
                ✓ 已是最新版本
              </Text>
            ) : null}

            {enabled ? (
              <>
                <Divider />
                <Group justify="space-between">
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => setShowRollback((v) => !v)}
                  >
                    回滚到历史版本
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    disabled={inProgress}
                    onClick={() =>
                      requestConfirm({
                        kind: "restart",
                        title: "确认重启",
                        body: "将重启后台服务（不改变版本），期间管理端会短暂不可用。确认继续？"
                      })
                    }
                  >
                    重启服务
                  </Button>
                </Group>
                <Collapse in={showRollback}>
                  <Stack gap={4}>
                    {rollbackVersions.filter((v) => !v.isCurrent).length === 0 ? (
                      <Text size="xs" c="dimmed">
                        没有可回滚的历史版本。
                      </Text>
                    ) : (
                      rollbackVersions
                        .filter((v) => !v.isCurrent)
                        .map((v) => (
                          <Group key={v.version} justify="space-between">
                            <Text size="xs">v{v.version}</Text>
                            <Button
                              size="compact-xs"
                              variant="light"
                              color="orange"
                              disabled={inProgress}
                              onClick={() =>
                                requestConfirm({
                                  kind: "rollback",
                                  version: v.version,
                                  title: "确认回滚",
                                  body: `将回滚到 v${v.version} 并重启服务。若目标版本与当前存在数据库结构差异，回滚不会自动撤销已执行的迁移。确认继续？`
                                })
                              }
                            >
                              回滚
                            </Button>
                          </Group>
                        ))
                    )}
                  </Stack>
                </Collapse>

                <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setShowHistory((v) => !v)}>
                  操作历史
                </Button>
                <Collapse in={showHistory}>
                  <ScrollArea.Autosize mah={180}>
                    <Stack gap={6}>
                      {operations.length === 0 ? (
                        <Text size="xs" c="dimmed">
                          暂无操作记录。
                        </Text>
                      ) : (
                        operations.map((op) => (
                          <Group key={op.id} justify="space-between" wrap="nowrap" align="flex-start">
                            <div style={{ minWidth: 0 }}>
                              <Text size="xs">
                                {kindLabel(op.kind)}
                                {op.fromVersion || op.toVersion
                                  ? ` v${op.fromVersion ?? "?"} → v${op.toVersion ?? "?"}`
                                  : ""}
                              </Text>
                              <Text size="10px" c="dimmed">
                                {new Date(op.startedAt).toLocaleString()} · {op.actorLabel ?? "系统"}
                              </Text>
                              {op.failureReason ? (
                                <Text size="10px" c="red">
                                  {op.failureReason}
                                </Text>
                              ) : null}
                            </div>
                            <Badge size="xs" color={statusColor(op.status)} variant="light">
                              {statusLabel(op.status)}
                            </Badge>
                          </Group>
                        ))
                      )}
                    </Stack>
                  </ScrollArea.Autosize>
                </Collapse>
              </>
            ) : null}
          </Stack>
        </Popover.Dropdown>
      </Popover>

      <Modal
        opened={confirm !== null}
        onClose={() => {
          if (!submitting) setConfirm(null);
        }}
        title={confirm?.title ?? ""}
        centered
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">{confirm?.body}</Text>
          <Group justify="flex-end">
            <Button variant="default" size="xs" disabled={submitting} onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              size="xs"
              color={confirm?.kind === "rollback" ? "orange" : confirm?.kind === "restart" ? "gray" : "blue"}
              loading={submitting}
              onClick={() => void confirmProceed()}
            >
              确认
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
