import { Alert, Button, Group, NumberInput, Select, Switch, TextInput } from "@mantine/core";
import type { AccessMode, AdminNodePanelInboundDto } from "@chordv/shared";
import type { NodeFormState } from "../../utils/admin-forms";

type NodeEditorSectionProps = {
  currentAccessMode: AccessMode;
  nodeForm: NodeFormState;
  setNodeForm: React.Dispatch<React.SetStateAction<NodeFormState>>;
  nodePanelInbounds: AdminNodePanelInboundDto[];
  nodePanelInboundsLoading: boolean;
  onLoadNodePanelInbounds: () => void;
};

export function NodeEditorSection(props: NodeEditorSectionProps) {
  const nodePanelInboundOptions = props.nodePanelInbounds.map((item) => ({
    value: String(item.id),
    label: `${item.remark} · ID ${item.id} · ${item.protocol.toUpperCase()} · ${item.port} 端口 · ${item.clientCount} 客户端`
  }));

  return (
    <>
      {props.currentAccessMode === "relay" ? (
        <TextInput
          label="订阅地址"
          value={props.nodeForm.subscriptionUrl}
          onChange={(event) => props.setNodeForm((current) => ({ ...current, subscriptionUrl: event.currentTarget.value }))}
        />
      ) : (
        <Alert color="blue" variant="light">
          当前为 3x-ui 直连模式，节点运行参数会直接从面板入站读取，无需填写订阅地址。
        </Alert>
      )}
      <TextInput
        label="节点名称"
        value={props.nodeForm.name}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, name: event.currentTarget.value }))}
      />
      <Group grow>
        <TextInput
          label="地区"
          value={props.nodeForm.region}
          onChange={(event) => props.setNodeForm((current) => ({ ...current, region: event.currentTarget.value }))}
        />
        <TextInput
          label="供应商"
          value={props.nodeForm.provider}
          onChange={(event) => props.setNodeForm((current) => ({ ...current, provider: event.currentTarget.value }))}
        />
      </Group>
      <TextInput
        label="标签"
        description="使用英文逗号分隔"
        value={props.nodeForm.tags}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, tags: event.currentTarget.value }))}
      />
      <Switch
        checked={props.nodeForm.recommended}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, recommended: event.currentTarget.checked }))}
        label="推荐节点"
      />
      <Switch
        checked={props.nodeForm.panelEnabled}
        onChange={(event) => props.setNodeForm((current) => ({ ...current, panelEnabled: event.currentTarget.checked }))}
        label="启用 3x-ui 面板"
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
          读取入站
        </Button>
      </Group>
      <NumberInput
        label="手动入站 ID（兜底）"
        description="仅在无法读取面板入站时使用"
        min={1}
        value={props.nodeForm.panelInboundId}
        onChange={(value) => props.setNodeForm((current) => ({ ...current, panelInboundId: Number(value) || 1 }))}
      />
    </>
  );
}
