import { Alert, NumberInput, Select, SimpleGrid, Stack, Switch, TextInput } from "@mantine/core";
import type { AdminPlanRecordDto, PlanScope } from "@chordv/shared";
import type { Dispatch, SetStateAction } from "react";
import type { PlanFormState } from "../../utils/admin-forms";
import styles from "./EditorDialog.module.css";

export function PlanEditorSection({ planForm: form, setPlanForm: setForm, record }: {
  planForm: PlanFormState; setPlanForm: Dispatch<SetStateAction<PlanFormState>>; record?: AdminPlanRecordDto | null;
}) {
  return <Stack gap="lg">
    <section><h3 className={styles.sectionTitle}>基本信息</h3><Stack gap="md"><TextInput required label="套餐名称" value={form.name} onChange={event => setForm(current => ({ ...current, name: event.currentTarget.value }))}/>
      <Select label="适用对象" allowDeselect={false} disabled={Boolean(record?.subscriptionCount)} description={record?.subscriptionCount ? "已有订阅使用，不能更改适用对象。" : undefined}
        data={[{ value: "personal", label: "个人客户" }, { value: "team", label: "团队共享" }]} value={form.scope} onChange={value => setForm(current => ({ ...current, scope: (value ?? "personal") as PlanScope }))}/></Stack></section>
    <section><h3 className={styles.sectionTitle}>默认权益</h3><SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md"><NumberInput label="流量额度（GB）" min={0} value={form.totalTrafficGb} onChange={value => setForm(current => ({ ...current, totalTrafficGb: Number(value) || 0 }))}/>
      <NumberInput label="最大并发会话" min={1} allowDecimal={false} value={form.maxConcurrentSessions} onChange={value => setForm(current => ({ ...current, maxConcurrentSessions: Number(value) || 1 }))}/></SimpleGrid></section>
    <section><h3 className={styles.sectionTitle}>使用规则</h3><div className={styles.switchRow}><div><strong>允许续期</strong><p>是否支持续期操作</p></div><Switch color="#1c4d37" aria-label="允许续期" checked={form.renewable} onChange={event => setForm(current => ({ ...current, renewable: event.currentTarget.checked }))}/></div>
      <div className={styles.switchRow}><div><strong>启用套餐</strong><p>停用后不再用于新开通选择</p></div><Switch color="#1c4d37" aria-label="启用套餐" checked={form.isActive} onChange={event => setForm(current => ({ ...current, isActive: event.currentTarget.checked }))}/></div></section>
    {record && record.subscriptionCount > 0 && form.maxConcurrentSessions !== record.maxConcurrentSessions && <Alert color="orange">此套餐关联 {record.subscriptionCount} 个订阅。修改并发上限可能触发现有连接调整。</Alert>}
  </Stack>;
}
