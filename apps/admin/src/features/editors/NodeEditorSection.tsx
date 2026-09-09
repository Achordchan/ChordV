import { Alert, Group, Select, Switch, TextInput, Text } from "@mantine/core";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { countryOptions } from "@chordv/shared";
import type { NodeFormState } from "../../utils/admin-forms";
import { CountryFlag } from "../../components/CountryFlag";

type NodeEditorSectionProps = {
  node: AdminNodeRecordDto | null;
  nodeForm: NodeFormState;
  setNodeForm: React.Dispatch<React.SetStateAction<NodeFormState>>;
};

export function NodeEditorSection(props: NodeEditorSectionProps) {
  return (
    <>
      <Alert color="green" variant="light">
        Agent 负责用户写入和计量，连接参数由 Agent 上报；本抽屉只修改节点资料，入站部署请在节点列表的“节点控制器”中操作。
      </Alert>
      <TextInput
        label="节点名称"
        value={props.nodeForm.name}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, name: event.currentTarget.value }))}
      />
      <Group grow>
        <Select
          label="国家"
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
        placeholder="Los Angeles / Tokyo / Singapore"
        value={props.nodeForm.region}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, region: event.currentTarget.value }))}
      />
      <TextInput
        label="标签"
        description="使用英文逗号分隔"
        value={props.nodeForm.tags}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, tags: event.currentTarget.value }))}
      />
      <Switch
        checked={props.nodeForm.isActive}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, isActive: event.currentTarget.checked }))}
        label="启用节点"
      />
      <Switch
        checked={props.nodeForm.recommended}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, recommended: event.currentTarget.checked }))}
        label="推荐节点"
      />
    </>
  );
}
