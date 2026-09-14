import { Group, Select, Switch, TextInput, Text } from "@mantine/core";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { countryOptions } from "@chordv/shared";
import type { NodeFormState } from "../../utils/admin-forms";
import styles from "./EditorDialog.module.css";
import { CountryFlag } from "../../components/CountryFlag";

type NodeEditorSectionProps = {
  node: AdminNodeRecordDto | null;
  nodeForm: NodeFormState;
  setNodeForm: React.Dispatch<React.SetStateAction<NodeFormState>>;
};

export function NodeEditorSection(props: NodeEditorSectionProps) {
  return (
    <>
      <div className={styles.context}><div><Text fw={600}>{props.node?.name || "节点资料"}</Text><Text size="xs" c="dimmed" mt={4}>{props.node ? props.node.serverHost + ":" + props.node.serverPort : ""}</Text></div><CountryFlag code={props.nodeForm.countryCode}/></div>
      <TextInput
        label="节点名称"
        value={props.nodeForm.name}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, name: event.currentTarget.value }))}
      />
      <Group grow>
        <Select
          label="国家 / 地区"
          placeholder="选择国家"
          searchable
          clearable={false}
          data={countryOptions.map((item) => ({ value: item.code, label: item.label }))}
          value={props.nodeForm.countryCode || null}
          onChange={(value) =>
            props.setNodeForm((current) => ({
              ...current,
              countryCode: value ?? ""
            }))
          }
          renderOption={({ option }) => (
            <Group gap="xs" wrap="nowrap">
              <CountryFlag code={option.value} size="sm" />
              <Text size="sm">{option.label}</Text>
            </Group>
          )}
        />
        <TextInput
          label="供应商"
          value={props.nodeForm.provider}
          onChange={(event) => props.setNodeForm((current) => ({ ...current, provider: event.currentTarget.value }))}
        />
      </Group>
      <TextInput
        label="地区/城市"
        placeholder="如：东京"
        value={props.nodeForm.region}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, region: event.currentTarget.value }))}
      />
      <TextInput
        label="标签"
        description="使用英文逗号分隔"
        value={props.nodeForm.tags}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, tags: event.currentTarget.value }))}
      />
      <div className={styles.switchRow}><div><strong>启用节点</strong><p>控制节点是否可供客户端使用</p></div><Switch color="teal.9"
        checked={props.nodeForm.isActive}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, isActive: event.currentTarget.checked }))}
        aria-label="启用节点"
      /></div>
      <div className={styles.switchRow}><div><strong>推荐节点</strong><p>在客户端标记为推荐</p></div><Switch color="teal.9"
        checked={props.nodeForm.recommended}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, recommended: event.currentTarget.checked }))}
        aria-label="推荐节点"
      /></div>
    </>
  );
}
