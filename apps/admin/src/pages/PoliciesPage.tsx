import { Button, Checkbox, Group, SegmentedControl, Select, Stack, Switch, Text } from "@mantine/core";
import type { ConnectionMode } from "@chordv/shared";
import type { Dispatch, SetStateAction } from "react";
import type { PolicyFormState } from "../utils/admin-forms";
import { modeOptions } from "../utils/admin-forms";
import policyStyles from "../features/system-settings/PolicySettings.module.css";
import styles from "../features/editors/EditorDialog.module.css";

type PoliciesPageProps = {
  policyForm: PolicyFormState;
  setPolicyForm: Dispatch<SetStateAction<PolicyFormState | null>>;
  policySaving: boolean;
  onSave: () => void;
};

export function PoliciesPage(props: PoliciesPageProps) {
  const rules = [
    { key: "blockAds" as const, title: "广告拦截", description: "按 GeoSite 广告名单拦截匹配域名" },
    { key: "chinaDirect" as const, title: "大陆直连", description: "按 GeoIP、GeoSite 中国分类匹配直连" }
  ];
  return <form className={styles.form} onSubmit={event=>{event.preventDefault();if(!props.policySaving)props.onSave();}}>
    <fieldset className={styles.fields} disabled={props.policySaving}><Stack gap="xl">
      <section><h3 className={styles.sectionTitle}>连接模式</h3><Stack gap="lg">
        <Select label="默认模式" description="客户端默认选择的连接方式" data={modeOptions} value={props.policyForm.defaultMode}
          onChange={value=>props.setPolicyForm(current=>current?{...current,defaultMode:(value||"rule") as ConnectionMode}:current)}/>
        <Checkbox.Group label="允许用户选择的模式" value={props.policyForm.modes} onChange={value=>props.setPolicyForm(current=>current?{...current,modes:value as ConnectionMode[]}:current)}>
          <Group mt="sm" gap="lg"><Checkbox color="teal.9" value="rule" label="规则模式"/><Checkbox color="teal.9" value="global" label="全局代理"/><Checkbox color="teal.9" value="direct" label="直连模式"/></Group>
        </Checkbox.Group>
        {!props.policyForm.modes.includes(props.policyForm.defaultMode)?<Text size="sm" c="red" role="alert">默认模式必须包含在允许选择的模式中。</Text>:null}
      </Stack></section>
      <section className={policyStyles.routing}><h3 className={styles.sectionTitle}>分流规则</h3><Text size="sm" c="#56634f" mb="sm">仅规则模式生效，用户自定义规则优先。</Text>{rules.map(rule=><div className={styles.switchRow} key={rule.key}><div><strong>{rule.title}</strong><p>{rule.description}</p></div><Switch color="teal.9" aria-label={rule.title} checked={props.policyForm[rule.key]} onChange={event=>{const checked=event.currentTarget.checked;props.setPolicyForm(current=>current?{...current,[rule.key]:checked}:current);}}/></div>)}
        <div className={policyStyles.aiRow}><div><strong id="ai-routing-label">AI 服务路由</strong><p>指定内置 AI 域名列表的连接方式</p></div><SegmentedControl aria-labelledby="ai-routing-label" disabled={props.policySaving} value={props.policyForm.aiServicesProxy ? "proxy" : "direct"} onChange={value=>props.setPolicyForm(current=>current?{...current,aiServicesProxy:value==="proxy"}:current)} data={[{value:"proxy",label:"代理"},{value:"direct",label:"直连"}]} classNames={{root:policyStyles.selector,label:policyStyles.label,indicator:policyStyles.indicator}}/></div>
        {!props.policyForm.modes.includes("rule")?<Text size="sm" c="#56634f" mt="md">当前未开放规则模式，以上设置会保留，在规则模式开放后使用。</Text>:null}
      </section>
    </Stack></fieldset>
    <footer className={styles.footer}><Button type="submit" color="teal.9" loading={props.policySaving} disabled={!props.policyForm.modes.includes(props.policyForm.defaultMode)}>保存策略</Button></footer>
  </form>;
}
