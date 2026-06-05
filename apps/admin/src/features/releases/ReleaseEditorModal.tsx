import { Badge, Button, Group, Modal, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import type { ReleaseEditorFormState } from "./types";
import { releasePlatformOptions } from "./types";

type ReleaseEditorModalProps = {
  opened: boolean;
  editing: boolean;
  saving: boolean;
  title: string;
  submitLabel: string;
  form: ReleaseEditorFormState;
  onClose: () => void;
  onChange: (value: ReleaseEditorFormState) => void;
  onSubmit: () => void;
};

export function ReleaseEditorModal(props: ReleaseEditorModalProps) {
  return (
    <Modal opened={props.opened} onClose={props.onClose} title={props.title} centered size="lg">
      <Stack gap="md">
        <Group grow align="flex-start">
          <Select
            label="平台"
            data={releasePlatformOptions as unknown as { value: string; label: string }[]}
            value={props.form.platform}
            onChange={(value) => value && props.onChange({ ...props.form, platform: value as ReleaseEditorFormState["platform"] })}
            disabled={props.editing}
          />
          {props.editing ? (
            <Stack gap={6}>
              <Text size="sm" fw={500}>
                当前状态
              </Text>
              <Badge variant="light" size="lg" color={props.form.status === "published" ? "green" : "blue"} style={{ width: "fit-content" }}>
                {props.form.status === "published" ? "已发布" : "草稿"}
              </Badge>
              <Text size="xs" c="dimmed">
                发布和撤回请直接在列表卡片里操作，避免编辑内容和状态变更混在一起。
              </Text>
            </Stack>
          ) : (
            <Stack gap={6}>
              <Text size="sm" fw={500}>
                发布渠道
              </Text>
              <Badge variant="light" size="lg" style={{ width: "fit-content" }}>
                正式版
              </Badge>
              <Text size="xs" c="dimmed">
                新建记录先保存为草稿，补完安装包后再发布。
              </Text>
            </Stack>
          )}
        </Group>

        <TextInput
          label="版本号"
          placeholder="例如 1.0.3"
          value={props.form.version}
          onChange={(event) =>
            props.onChange({
              ...props.form,
              version: event.currentTarget.value,
              minimumVersion: props.editing ? props.form.minimumVersion : event.currentTarget.value
            })
          }
          disabled={props.editing}
        />

        <TextInput
          label="展示标题（可选）"
          placeholder="留空则使用版本号，例如 1.0.3"
          value={props.form.title}
          onChange={(event) => props.onChange({ ...props.form, title: event.currentTarget.value })}
        />

        <Textarea
          label="更新日志"
          minRows={6}
          placeholder={"每行一条更新说明\n例如：修复 Windows 托盘断开异常"}
          value={props.form.changelog}
          onChange={(event) => props.onChange({ ...props.form, changelog: event.currentTarget.value })}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            取消
          </Button>
          <Button onClick={props.onSubmit} loading={props.saving}>
            {props.submitLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
