import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Loader, Modal, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { AdminDeletableEntityKind, AdminDeletePreviewDto } from "@chordv/shared";
import { fetchDeletePreview } from "../../api/deletion";
import { readError } from "../../utils/admin-filters";
import editorStyles from "../editors/EditorDialog.module.css";

export type DeleteEntityTarget = { kind: AdminDeletableEntityKind; id: string; name: string };

const KIND_LABEL: Record<AdminDeletableEntityKind, string> = { user: "账号", plan: "套餐", subscription: "订阅", team: "团队" };

/**
 * 删除前确认：先从后台读出会一起删掉的数据并列出来。
 * 没有关联数据时直接删除；有关联数据时要勾选确认后“强制删除”。
 */
export function DeleteEntityModal(props: {
  target: DeleteEntityTarget | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: (force: boolean) => void;
}) {
  const [preview, setPreview] = useState<AdminDeletePreviewDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const target = props.target;

  useEffect(() => {
    setPreview(null);
    setLoadError(null);
    setAcknowledged(false);
    if (!target) return;
    let cancelled = false;
    fetchDeletePreview(target.kind, target.id)
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((reason) => { if (!cancelled) setLoadError(readError(reason, "读取关联数据失败")); });
    return () => { cancelled = true; };
  }, [target?.kind, target?.id]);

  const close = () => { if (!props.submitting) props.onClose(); };
  const label = target ? KIND_LABEL[target.kind] : "";
  const related = preview?.related.filter((entry) => entry.count > 0) ?? [];
  const blocked = Boolean(preview?.blockedReason);
  const force = Boolean(preview?.requiresForce);
  const canConfirm = Boolean(preview) && !blocked && (!force || acknowledged);

  return (
    <Modal opened={target !== null} onClose={close} title={`删除${label}`} centered size={520}
      closeOnClickOutside={!props.submitting} closeOnEscape={!props.submitting} withCloseButton={!props.submitting}
      classNames={{ content: editorStyles.content, header: editorStyles.header, title: editorStyles.title, body: editorStyles.body }}>
      <Stack gap="sm">
        <Text fw={600}>{preview?.name ?? target?.name}</Text>
        {!preview && !loadError && <Loader size="sm" color="#1c4d37" aria-label="正在读取关联数据"/>}
        {loadError && <Alert color="red" icon={<IconAlertTriangle size={18}/>}>{loadError}</Alert>}
        {preview?.blockedReason && <Alert color="red" icon={<IconAlertTriangle size={18}/>}>{preview.blockedReason}</Alert>}
        {preview && !blocked && (related.length === 0
          ? <Text size="sm">没有关联数据，删除后无法恢复。</Text>
          : <>
            <Text size="sm">以下数据会一起删除或受影响，删除后无法恢复：</Text>
            <ul style={{ margin: 0, paddingLeft: 20 }} aria-label="关联数据">
              {related.map((entry) => <li key={entry.key} style={{ marginBottom: 6 }}>
                <Text size="sm" span fw={600}>{entry.label}：{entry.count}</Text>
                {entry.samples.length > 0 && <Text size="xs" c="dimmed">{entry.samples.join("、")}{entry.count > entry.samples.length ? " 等" : ""}</Text>}
              </li>)}
            </ul>
            {related.some((entry) => entry.key === "manualNodeAccounts") && <Alert color="yellow" icon={<IconAlertTriangle size={18}/>}>
              有节点账号无法自动删除，删除后这些账号在节点上可能仍能使用，需要到对应节点上手工清理。
            </Alert>}
            <Checkbox checked={acknowledged} onChange={(event) => setAcknowledged(event.currentTarget.checked)}
              label="我已了解，上面这些数据会一起删除且无法恢复" disabled={props.submitting}/>
          </>)}
      </Stack>
      <footer className={editorStyles.footer}>
        <Button variant="default" onClick={close} disabled={props.submitting}>取消</Button>
        <Button color="red.8" onClick={() => props.onConfirm(force)} loading={props.submitting} disabled={!canConfirm}>
          {force ? "强制删除" : `删除${label}`}
        </Button>
      </footer>
    </Modal>
  );
}
