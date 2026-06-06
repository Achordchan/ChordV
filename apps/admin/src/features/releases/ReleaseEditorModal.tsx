import { Button, Group, Modal, Select, Stack, TextInput, Textarea } from "@mantine/core";
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
        <Select
          label="平台"
          data={releasePlatformOptions as unknown as { value: string; label: string }[]}
          value={props.form.platform}
          onChange={(value) => value && props.onChange({ ...props.form, platform: value as ReleaseEditorFormState["platform"] })}
          disabled={props.editing}
        />

        <TextInput
          label="版本号"
          placeholder="例如 1.1.6"
          value={props.form.version}
          onChange={(event) => props.onChange({ ...props.form, version: event.currentTarget.value })}
          disabled={props.editing}
        />

        <TextInput
          label="发布标题"
          placeholder="例如 ChordV 1.1.6 · Windows"
          value={props.form.title}
          onChange={(event) => props.onChange({ ...props.form, title: event.currentTarget.value })}
        />

        {!props.editing ? (
          <TextInput
            label="外链下载地址"
            placeholder="https://example.com/ChordV_1.1.6_x64-full.zip"
            value={props.form.downloadUrl}
            onChange={(event) => props.onChange({ ...props.form, downloadUrl: event.currentTarget.value })}
          />
        ) : null}

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
