import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import type { AdminTeamRecordDto } from "@chordv/shared";

export function TeamTrafficResetModal(props: {
  team: AdminTeamRecordDto | null;
  onClose: () => void;
  onReset: (userId: string, memberName: string) => Promise<boolean>;
}) {
  const [userId, setUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0), busyRef = useRef(false);
  useEffect(() => {
    epoch.current++;setUserId(null);setBusy(false);busyRef.current=false;setError("");
    return () => {epoch.current++;};
  }, [props.team?.id]);
  const member = props.team?.members.find(item => item.userId === userId);
  const submit = async () => {
    if (!member || busyRef.current) return;
    const current = epoch.current;busyRef.current=true;setBusy(true);setError("");
    try {
      const saved = await props.onReset(member.userId,member.displayName);
      if (current === epoch.current && saved) props.onClose();
    } catch {if(current === epoch.current)setError("重置未完成，请核对成员与流量状态后重试。");}
    finally {if(current === epoch.current){busyRef.current=false;setBusy(false);}}
  };
  return <Modal opened={props.team !== null} onClose={() => {if(!busyRef.current)props.onClose();}} title="重置团队成员流量" centered closeOnClickOutside={false} closeOnEscape={!busy} withCloseButton={!busy}>
    <Stack>
      <Text size="sm">仅重置所选成员在当前团队订阅下的已用流量，其他成员不变；节点最终流量结算后生效。</Text>
      <Select label="选择成员" placeholder="请选择要重置的成员" data={(props.team?.members ?? []).map(item => ({value:item.userId,label:`${item.displayName} · ${item.email}`}))} value={member ? userId : null} onChange={setUserId} searchable disabled={busy} nothingFoundMessage="没有匹配的成员"/>
      {!props.team?.members.length && <Alert color="yellow">当前团队没有可选择的成员。</Alert>}
      {error && <Alert color="red">{error}</Alert>}
      <Group justify="flex-end"><Button variant="default" disabled={busy} onClick={props.onClose}>取消</Button><Button color="red" disabled={!member} loading={busy} onClick={() => void submit()}>重置所选成员流量</Button></Group>
    </Stack>
  </Modal>;
}
