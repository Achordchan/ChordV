import { Alert, Button, FileInput, Group, Modal, Select, SegmentedControl, Stack, Switch, TextInput } from "@mantine/core";
import type { ArtifactEditorFormState } from "./types";
import { releaseArtifactTypeOptionsForPlatform } from "./types";
import type { AdminReleasePlatform } from "../../api/client";

type ArtifactEditorModalProps = {
  opened: boolean;
  saving: boolean;
  creatingRelease: boolean;
  title: string;
  submitLabel: string;
  platform: AdminReleasePlatform;
  form: ArtifactEditorFormState;
  uploadFileRequired: boolean;
  onClose: () => void;
  onChange: (value: ArtifactEditorFormState) => void;
  onSubmit: () => void;
};

export function ArtifactEditorModal(props: ArtifactEditorModalProps) {
  const usesExternalLink = props.form.source === "external" || props.form.type === "external";
  const typeOptions = releaseArtifactTypeOptionsForPlatform(props.platform, props.form.type);
  const defaultType = defaultArtifactTypeForPlatform(props.platform);

  return (
    <Modal opened={props.opened} onClose={props.onClose} title={props.title} centered size="lg">
      <Stack gap="md">
        <SegmentedControl
          value={usesExternalLink ? "external" : "uploaded"}
          onChange={(value) =>
            props.onChange({
              ...props.form,
              source: value as ArtifactEditorFormState["source"],
              type: props.form.type === "external" ? defaultType : props.form.type,
              allowClientMirror: value === "external"
            })
          }
          data={[
            { label: "上传安装包", value: "uploaded" },
            { label: "外部安装包链接", value: "external" }
          ]}
        />

        <Select
          label="产物类型"
          data={typeOptions as unknown as { value: string; label: string }[]}
          value={props.form.type}
          onChange={(value) =>
            value &&
            props.onChange({
              ...props.form,
              type: value as ArtifactEditorFormState["type"],
              source: value === "external" ? "external" : props.form.source
            })
          }
        />

        {props.platform === "macos" || props.platform === "windows" ? (
          <Alert color="blue" variant="light">
            桌面端发布中心：macOS 使用 DMG，Windows 使用 ZIP 全量更新包。
          </Alert>
        ) : null}

        {usesExternalLink ? (
          <>
            <TextInput
              label="下载地址"
              placeholder={
                props.platform === "windows"
                  ? "https://github.com/your/repo/releases/download/v1.0.2/ChordV_1.0.2_x64-full.zip"
                  : "https://github.com/your/repo/releases/download/v1.0.2/ChordV_1.0.2.dmg"
              }
              value={props.form.downloadUrl}
              onChange={(event) => props.onChange({ ...props.form, downloadUrl: event.currentTarget.value })}
              error={!props.form.downloadUrl.trim() ? "请填写外部安装包下载地址。" : undefined}
            />
            <TextInput
              label="默认加速前缀"
              description="可选。直接填写加速域名前缀即可，比如 https://ghfast.top/。留空时直接使用原始下载地址。"
              placeholder="例如 https://ghfast.top/"
              value={props.form.defaultMirrorPrefix}
              onChange={(event) => props.onChange({ ...props.form, defaultMirrorPrefix: event.currentTarget.value })}
            />
            <Switch
              checked={props.form.allowClientMirror}
              onChange={(event) => props.onChange({ ...props.form, allowClientMirror: event.currentTarget.checked })}
              label="允许客户端自定义加速前缀覆盖默认值"
            />
          </>
        ) : (
          <>
            <FileInput
              label="安装包文件"
              placeholder="选择安装包文件"
              value={props.form.selectedFile}
              onChange={(file) => props.onChange({ ...props.form, selectedFile: file, fileName: file?.name ?? props.form.fileName })}
              error={props.uploadFileRequired && !props.form.selectedFile ? "请先选择要上传的安装包文件。" : undefined}
              clearable
            />
            <Alert color="blue" variant="light">
              {props.creatingRelease
                ? "上传模式下会先创建发布记录，再上传首个安装包；如果上传失败，系统会自动清理，不会留下空白草稿。"
                : "上传后会生成下载地址，保存即可。"}
            </Alert>
          </>
        )}

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

function defaultArtifactTypeForPlatform(platform: AdminReleasePlatform): ArtifactEditorFormState["type"] {
  if (platform === "windows") {
    return "zip";
  }
  if (platform === "android") {
    return "apk";
  }
  if (platform === "ios") {
    return "ipa";
  }
  return "dmg";
}
