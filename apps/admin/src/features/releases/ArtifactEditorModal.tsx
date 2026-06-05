import { Alert, Button, FileInput, Group, Modal, Stack } from "@mantine/core";
import type { ArtifactEditorFormState } from "./types";
import type { AdminReleasePlatform } from "../../api/client";

type ArtifactEditorModalProps = {
  opened: boolean;
  saving: boolean;
  creatingRelease: boolean;
  title: string;
  submitLabel: string;
  platform: AdminReleasePlatform;
  form: ArtifactEditorFormState;
  uploadMaxBytes: number;
  uploadFileRequired: boolean;
  onClose: () => void;
  onChange: (value: ArtifactEditorFormState) => void;
  onSubmit: () => void;
};

export function ArtifactEditorModal(props: ArtifactEditorModalProps) {
  return (
    <Modal opened={props.opened} onClose={props.onClose} title={props.title} centered size="lg">
      <Stack gap="md">
        <FileInput
          description={`单文件最大 ${formatUploadBytes(props.uploadMaxBytes)}。大文件上传可能需要数分钟，请等待按钮完成。`}
          label="安装包文件"
          placeholder="选择安装包文件"
          value={props.form.selectedFile}
          onChange={(file) =>
            props.onChange({
              ...props.form,
              source: "uploaded",
              type: defaultArtifactTypeForPlatform(props.platform),
              selectedFile: file,
              fileName: file?.name ?? props.form.fileName
            })
          }
          error={props.uploadFileRequired && !props.form.selectedFile ? "请先选择要上传的安装包文件。" : undefined}
          clearable
        />
        <Alert color="blue" variant="light">
          {props.creatingRelease
            ? "保存时会创建发布记录并上传这个安装包。"
            : "选择新文件后保存即可替换安装包。"}
        </Alert>

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

function formatUploadBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  }
  return `${value} B`;
}
