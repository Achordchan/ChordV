import { Alert, Button, Group, Modal, Select, Stack, Switch, TextInput, Textarea } from "@mantine/core";
import type { ReleaseEditorFormState } from "./types";
import { releaseChannelOptions, releasePlatformOptions, releaseStatusOptions } from "./types";

type ReleaseEditorModalProps = {
  opened: boolean;
  saving: boolean;
  title: string;
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
          />
          <Select
            label="渠道"
            data={releaseChannelOptions as unknown as { value: string; label: string }[]}
            value={props.form.channel}
            onChange={(value) => value && props.onChange({ ...props.form, channel: value as ReleaseEditorFormState["channel"] })}
          />
          <Select
            label="状态"
            data={releaseStatusOptions as unknown as { value: string; label: string }[]}
            value={props.form.status}
            onChange={(value) => value && props.onChange({ ...props.form, status: value as ReleaseEditorFormState["status"] })}
          />
        </Group>

        <Group grow align="flex-start">
          <TextInput
            label="版本号"
            placeholder="例如 1.0.3"
            value={props.form.version}
            onChange={(event) => props.onChange({ ...props.form, version: event.currentTarget.value })}
          />
          <TextInput
            label="最低可用版本"
            placeholder="例如 1.0.2"
            value={props.form.minimumVersion}
            onChange={(event) => props.onChange({ ...props.form, minimumVersion: event.currentTarget.value })}
          />
        </Group>

        <TextInput
          label="展示标题"
          placeholder="例如 1.0.3 日常更新"
          value={props.form.title}
          onChange={(event) => props.onChange({ ...props.form, title: event.currentTarget.value })}
        />
        <Switch
          checked={props.form.forceUpgrade}
          onChange={(event) => props.onChange({ ...props.form, forceUpgrade: event.currentTarget.checked })}
          label="本版要求立即更新"
        />

        <Alert color="blue" variant="light">
          “最低可用版本”表示低于这个版本就不能继续使用；“本版要求立即更新”表示即使没有低于最低可用版本，也必须先更新当前版本。
        </Alert>

        <Textarea
          label="发布说明"
          minRows={3}
          placeholder="简要说明这版适合哪些用户、是否建议立即更新。"
          value={props.form.releaseNotes}
          onChange={(event) => props.onChange({ ...props.form, releaseNotes: event.currentTarget.value })}
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
            保存发布
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
