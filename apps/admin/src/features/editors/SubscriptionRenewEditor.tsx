import { useState, type Dispatch, type SetStateAction } from "react";
import { Alert, Button, Collapse, NumberInput, Stack, Switch, TextInput } from "@mantine/core";
import { IconArrowRight, IconChevronDown } from "@tabler/icons-react";
import type { AdminSubscriptionRecordDto } from "@chordv/shared";
import type { SubscriptionRenewFormState } from "../../utils/admin-forms";
import { formatDateTimeWithYear, formatTrafficGb } from "../../utils/admin-format";
import { renewalDate } from "./renewal-date";
import styles from "./EditorDialog.module.css";

export function SubscriptionRenewEditorSection(props: {
  subscriptionRenewForm: SubscriptionRenewFormState;
  setSubscriptionRenewForm: Dispatch<SetStateAction<SubscriptionRenewFormState>>;
  subscription?: AdminSubscriptionRecordDto | null;
}) {
  const [custom, setCustom] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const form = props.subscriptionRenewForm;
  const dateValid = Boolean(form.expireAt) && Number.isFinite(Date.parse(form.expireAt));
  const beforeTotal = props.subscription?.totalTrafficGb;
  const beforeUsed = props.subscription?.usedTrafficGb;
  const total = form.totalTrafficGb === "" ? beforeTotal : Number(form.totalTrafficGb);
  const used = form.resetTraffic ? 0 : beforeUsed;
  const remaining = total !== undefined && used !== undefined ? Math.max(0, total - used) : null;
  return <Stack gap="lg">
    <section><h3 className={styles.sectionTitle}>延长有效期</h3><div className={styles.presets}>
      {[1, 3, 12].map(months => {
        const next = renewalDate(form.baseExpireAt, months);
        return <button type="button" key={months} aria-pressed={!custom && form.expireAt === next} onClick={() => { setCustom(false); props.setSubscriptionRenewForm(current => ({ ...current, expireAt: next })); }}>{months === 12 ? "1 年" : `${months} 个月`}</button>;
      })}
      <button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>指定日期</button>
    </div><Collapse in={custom}><TextInput mt="md" label="新的到期时间" type="datetime-local" value={form.expireAt} onChange={event => props.setSubscriptionRenewForm(current => ({ ...current, expireAt: event.currentTarget.value }))}/></Collapse></section>
    <section className={styles.preview}><h3 className={styles.sectionTitle}>续期预览</h3><div className={styles.dateChange}><div><small>当前到期</small><strong>{props.subscription ? formatDateTimeWithYear(props.subscription.expireAt) : "—"}</strong></div><IconArrowRight size={19}/><div><small>续期后到期</small><strong>{dateValid ? formatDateTimeWithYear(form.expireAt) : "请选择日期"}</strong></div></div>
      <p className={styles.hint}>未到期从原到期时间顺延，已到期从本次打开表单的时间起算。</p>
      <dl className={styles.previewFacts}><div><dt>续后总额度</dt><dd>{total === undefined ? "待同步" : `${formatTrafficGb(total)} GB`}</dd></div><div><dt>续后已用</dt><dd>{used === undefined ? "待同步" : `${formatTrafficGb(used)} GB`}</dd></div><div><dt>续后剩余</dt><dd>{remaining === null ? "待同步" : `${formatTrafficGb(remaining)} GB`}</dd></div></dl>
    </section>
    <section><Button variant="subtle" color="#596e5c" px={0} type="button" rightSection={<IconChevronDown size={16}/>} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>流量设置（可选）</Button>
      {!advanced && <p className={styles.hint}>{form.totalTrafficGb !== "" || form.resetTraffic ? "已修改流量设置，请核对上方预览。" : "默认保留总额度和已用流量。"}</p>}
      <Collapse in={advanced}><Stack gap="md" mt="sm"><NumberInput label="续后总额度（GB）" description="留空保留当前额度" min={0} value={form.totalTrafficGb} onChange={value => props.setSubscriptionRenewForm(current => ({ ...current, totalTrafficGb: value === "" || value === null ? "" : Number(value) }))}/>
        <Switch color="#1c4d37" label="重置已用流量" checked={form.resetTraffic} onChange={event => props.setSubscriptionRenewForm(current => ({ ...current, resetTraffic: event.currentTarget.checked }))}/></Stack></Collapse>
      {form.resetTraffic && <Alert mt="md" color="orange">{props.subscription?.ownerType === "team" ? "本次续期会重置整个团队订阅的已用流量，影响所有成员。" : "本次续期会将此订阅的已用流量重置为零。"}</Alert>}
    </section>
  </Stack>;
}
