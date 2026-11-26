import { useEffect, useRef, useState } from "react";
import { Alert, Button, CopyButton, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import QRCode from "qrcode";
import type { AdminSubscriptionLinkStateDto, AdminTeamMemberRecordDto } from "@chordv/shared";
import { fetchSubscriptionLink, issueSubscriptionLink, resetSubscriptionLink } from "../../api/subscription-links";
import { readError } from "../../utils/admin-filters";
import { formatDateTimeWithYear } from "../../utils/admin-format";
import { useActionConfirmation } from "../modals/useActionConfirmation";
import { DataSkeleton } from "../shared/DataSkeleton";
import { describeLinkDistribution, describeLinkPreview, describeLinkRevocation } from "./subscription-link-model";
import styles from "./CustomerSubscriptionLink.module.css";

/** A team has one link per member; pick the member, then show theirs. */
export function TeamSubscriptionLinks({ members }: { members: AdminTeamMemberRecordDto[] }) {
  const [userId, setUserId] = useState<string | null>(members[0]?.userId ?? null);
  const selected = members.some(member => member.userId === userId) ? userId : members[0]?.userId ?? null;
  if (!members.length) return <section className={styles.root}><h3>订阅链接</h3><Text className={styles.empty}>团队还没有成员。每位成员有自己的订阅链接，添加成员后在这里签发。</Text></section>;
  return <Stack gap="lg">
    <Select label="团队成员" description="每位成员有自己的订阅链接，只包含他自己的节点凭据。" allowDeselect={false} maw={420}
      data={members.map(member => ({ value: member.userId, label: `${member.displayName}（${member.email}）` }))} value={selected} onChange={setUserId}/>
    {selected && <CustomerSubscriptionLink key={selected} userId={selected}/>}
  </Stack>;
}

export function CustomerSubscriptionLink({ userId }: { userId: string }) {
  const [state, setState] = useState<AdminSubscriptionLinkStateDto | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const epoch = useRef(0);
  const confirmation = useActionConfirmation(true);

  const run = async (action: () => Promise<AdminSubscriptionLinkStateDto>, fallback: string, done?: string) => {
    const id = ++epoch.current;
    setBusy(true); setError("");
    try {
      const next = await action();
      if (id !== epoch.current) return;
      // A response for another customer must never be shown as this one's link.
      if (next.link && next.link.userId !== userId) throw new Error("订阅链接归属与当前客户不一致");
      setState(next);
      if (done) notifications.show({ color: "teal", message: done });
    } catch (reason) { if (id === epoch.current) setError(readError(reason, fallback)); }
    finally { if (id === epoch.current) setBusy(false); }
  };
  useEffect(() => {
    setState(null); setQr(null);
    void run(() => fetchSubscriptionLink(userId), "订阅链接读取失败");
    return () => { epoch.current++; };
  }, [userId]);

  const url = state?.link?.url ?? null;
  useEffect(() => {
    let active = true;
    setQr(null);
    if (url) QRCode.toDataURL(url, { margin: 1, width: 400, errorCorrectionLevel: "M" }).then(data => { if (active) setQr(data); }).catch(() => { if (active) setQr(null); });
    return () => { active = false; };
  }, [url]);

  const reset = async () => {
    const accepted = await confirmation.confirm({ title: "重置订阅链接", confirmLabel: "重置", danger: true,
      message: "重置会立刻生成新链接，并开始从分发层撤销旧链接。撤销通常在一分钟内完成，分发层故障或被限流时会更久；完成之前旧链接仍可使用，本页会显示是否已经撤销。\n重置只影响今后的订阅更新：已经导入客户端的节点不受影响，仍可继续使用。\n需要把新链接重新发给客户。" });
    if (accepted) await run(() => resetSubscriptionLink(userId), "重置失败，请重新读取确认当前链接", "新链接已生成，请发给客户。旧链接的撤销结果见“旧链接”一栏");
  };

  const link = state?.link ?? null;
  const distribution = state ? describeLinkDistribution(state.distribution) : null;
  const revocation = state ? describeLinkRevocation(state.distribution) : null;
  return <section className={styles.root}>
    {confirmation.dialog}
    <Group justify="space-between" mb="sm"><h3>订阅链接</h3>
      <Button variant="subtle" color="#1c4d37" disabled={busy} onClick={() => void run(() => fetchSubscriptionLink(userId), "订阅链接读取失败")}>刷新</Button></Group>
    <Text size="sm" c="dimmed" mb="lg">给小火箭、v2rayN 等第三方客户端使用。链接本身不会过期：账号到期、停用或换节点后，客户端更新订阅就会得到最新结果，不需要换链接。</Text>
    {error ? <div role="alert" className={styles.error}><Text size="sm">{error}</Text></div> : null}
    {!state && !error ? <DataSkeleton rows={3}/> : null}
    {state && !link ? <div className={styles.empty}><Text size="sm" mb="md">还没有给这位客户签发订阅链接。</Text>
      <Button color="#1c4d37" loading={busy} onClick={() => void run(() => issueSubscriptionLink(userId), "签发失败", "订阅链接已生成")}>生成订阅链接</Button></div> : null}
    {link && distribution ? <div className={styles.layout}>
      <Stack gap="md" className={styles.main}>
        {link.url ? <>
          <LinkField label="订阅链接" value={link.url}/>
          {link.backupUrl ? <LinkField label="备用链接" description="主域名打不开时使用，内容相同。" value={link.backupUrl}/> : null}
        </> : <Alert color="yellow">还没有配置订阅域名，链接暂时没有可用地址。请到“系统设置 → 订阅链接”填写订阅域名。</Alert>}
        <div><span className={`${styles.state} ${styles[distribution.tone]}`}>{distribution.label}</span>
          <Text size="sm" c="dimmed" mt={4}>{distribution.hint}</Text></div>
        <div><Text size="sm" fw={550}>{describeLinkPreview(link.preview)}</Text>
          {link.preview.kind === "nodes" ? <ul className={styles.nodes}>{link.preview.nodes.map(node => <li key={node.nodeId}>{node.name}</li>)}</ul> : null}</div>
        <dl className={styles.facts}><div><dt>签发时间</dt><dd>{formatDateTimeWithYear(link.createdAt)}</dd></div>
          {link.rotatedAt ? <div><dt>上次重置</dt><dd>{formatDateTimeWithYear(link.rotatedAt)}</dd></div> : null}
          {link.rotatedAt && revocation ? <div><dt>旧链接</dt><dd><span className={`${styles.state} ${styles[revocation.tone]}`}>{revocation.label}</span></dd></div> : null}</dl>
        <Group><Button variant="default" color="red" disabled={busy} onClick={() => void reset()}>重置链接</Button>
          <Text size="xs" c="dimmed">怀疑链接被转发或泄露时使用。已经导入客户端的节点不受影响。</Text></Group>
      </Stack>
      {link.url && qr ? <div className={styles.qr}><img src={qr} alt="订阅链接二维码"/><small>用客户端扫码导入</small></div> : null}
    </div> : null}
  </section>;
}

function LinkField({ label, description, value }: { label: string; description?: string; value: string }) {
  return <TextInput className={styles.url} label={label} description={description} value={value} readOnly onFocus={event => event.currentTarget.select()}
    rightSectionWidth={76} rightSection={<CopyButton value={value}>{({ copied, copy }) => <Button size="compact-sm" variant="subtle" color={copied ? "teal" : "#1c4d37"} onClick={copy}>{copied ? "已复制" : "复制"}</Button>}</CopyButton>}/>;
}
