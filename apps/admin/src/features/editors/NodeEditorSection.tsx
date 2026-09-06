import { Accordion, Alert, Button, Group, NumberInput, Select, Stack, Switch, TextInput, Text } from "@mantine/core";
import type { AdminNodePanelInboundDto, AdminNodeRecordDto } from "@chordv/shared";
import { countryOptions } from "@chordv/shared";
import type { NodeFormState } from "../../utils/admin-forms";
import { CountryFlag } from "../../components/CountryFlag";
import {
  nodeControlModeColor,
  translateNodeControlMode
} from "../../utils/admin-translate";

type NodeEditorSectionProps = {
  node: AdminNodeRecordDto | null;
  nodeForm: NodeFormState;
  setNodeForm: React.Dispatch<React.SetStateAction<NodeFormState>>;
  nodePanelInbounds: AdminNodePanelInboundDto[];
  nodePanelInboundsLoading: boolean;
  onLoadNodePanelInbounds: () => void;
};

export function NodeEditorSection(props: NodeEditorSectionProps) {
  const controlMode = props.node?.controlMode ?? "xui_primary";

  return (
    <>
      {controlMode === "xui_primary" ? (
        <Alert color="blue" variant="light">
          当前由 3X-UI 管理用户和计量，节点运行参数会直接从面板入站读取。
        </Alert>
      ) : (
        <Alert color={nodeControlModeColor(controlMode)} variant="light" title={`当前控制链路：${translateNodeControlMode(controlMode)}`}>
          控制模式、Agent 健康度和迁移操作请在节点列表的“节点控制器”中管理；本抽屉只修改节点资料和保留的回退配置。
        </Alert>
      )}
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
        label="订阅地址"
        placeholder="https://example.com/sub"
        value={props.nodeForm.subscriptionUrl}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, subscriptionUrl: event.currentTarget.value }))}
      />
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
      {controlMode === "xui_primary" ? (
        <PanelConfigurationFields {...props} />
      ) : (
        <Accordion variant="contained" radius="md">
          <Accordion.Item value="migration-panel-config">
            <Accordion.Control>迁移与回退：保留的 3X-UI 配置</Accordion.Control>
            <Accordion.Panel>
              <Stack gap="md">
                <Alert color="yellow" variant="light">
                  这些配置只用于迁移核对和人工回退，不是当前 Agent 控制链路的运行状态。
                </Alert>
                <PanelConfigurationFields {...props} />
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
    </>
  );
}

function PanelConfigurationFields(props: NodeEditorSectionProps) {
  const nodePanelInboundOptions = props.nodePanelInbounds.map((item) => ({
    value: String(item.id),
    label: `${item.remark} · ID ${item.id} · ${item.protocol.toUpperCase()} · ${item.port} 端口 · ${item.clientCount} 客户端`
  }));

  return (
    <>
      <Switch
        checked={props.nodeForm.panelEnabled}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, panelEnabled: event.currentTarget.checked }))}
        label="启用 3X-UI 面板"
      />
      <TextInput
        label="面板地址"
        placeholder="https://panel.example.com:2053"
        value={props.nodeForm.panelBaseUrl}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, panelBaseUrl: event.currentTarget.value }))}
      />
      <TextInput
        label="面板路径"
        placeholder="/"
        value={props.nodeForm.panelApiBasePath}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, panelApiBasePath: event.currentTarget.value }))}
      />
      <Group grow>
        <TextInput
          label="面板账号"
          value={props.nodeForm.panelUsername}
          onChange={(event) => props.setNodeForm((current) => ({ ...current, panelUsername: event.currentTarget.value }))}
        />
        <TextInput
          label="面板密码"
          type="password"
          value={props.nodeForm.panelPassword}
          placeholder="留空则保留已保存密码"
          onChange={(event) => props.setNodeForm((current) => ({ ...current, panelPassword: event.currentTarget.value }))}
        />
      </Group>
      <Group align="end">
        <Select
          style={{ flex: 1 }}
          label="面板入站（推荐）"
          placeholder={props.nodePanelInboundsLoading ? "正在读取入站..." : "读取面板后选择入站"}
          data={nodePanelInboundOptions}
          value={String(props.nodeForm.panelInboundId)}
          onChange={(value) => {
            if (!value) return;
            props.setNodeForm((current) => ({ ...current, panelInboundId: Number(value) || current.panelInboundId }));
          }}
          searchable
          clearable={false}
          nothingFoundMessage="暂无入站"
        />
        <Button variant="light" onClick={props.onLoadNodePanelInbounds} loading={props.nodePanelInboundsLoading}>
          读取远端入站
        </Button>
      </Group>
      <NumberInput
        label="手动入站 ID（兜底）"
        description="读取远端入站会直接访问 3x-ui；面板离线或路径错误时可在这里手动填写"
        min={1}
        value={props.nodeForm.panelInboundId}
        onChange={(value) => props.setNodeForm((current) => ({ ...current, panelInboundId: Number(value) || 1 }))}
      />
    </>
  );
}
