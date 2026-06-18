import { Alert, Button, Checkbox, FileInput, Group, Modal, SegmentedControl, Stack, TextInput } from "@mantine/core";
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
  const close = () => {
    if (!props.saving) {
      props.onClose();
    }
  };
  const savingMessage =
    !props.saving
      ? null
      : props.form.source === "uploaded" && props.form.selectedFile
        ? "正在上传安装包，大文件上传期间请等待当前请求返回。"
        : "正在保存安装包信息，请等待当前请求返回。";

  return (
    <Modal
      opened={props.opened}
      onClose={close}
      title={props.title}
      centered
      size="lg"
      closeOnClickOutside={!props.saving}
      closeOnEscape={!props.saving}
    >
      <Stack gap="md">
        {savingMessage ? (
          <Alert color="yellow" variant="light">
            {savingMessage}
          </Alert>
        ) : null}

        <SegmentedControl
          value={props.form.source}
          onChange={(value) =>
            props.onChange({
              ...props.form,
              source: value as ArtifactEditorFormState["source"],
              externalDeliveryMode:
                value === "external" && props.platform === "windows"
                  ? "windows_full_replace_zip"
                  : props.form.externalDeliveryMode,
              selectedFile: value === "external" ? null : props.form.selectedFile
            })
          }
          data={[
            { value: "external", label: "外链地址" },
            { value: "uploaded", label: "上传文件" }
          ]}
          disabled={props.saving}
        />

        {props.form.source === "external" ? (
          <>
            <TextInput
              label="外链下载地址"
              placeholder="https://example.com/ChordV_1.1.6_x64-full.zip"
              value={props.form.downloadUrl}
              onChange={(event) => props.onChange({ ...props.form, downloadUrl: event.currentTarget.value })}
              disabled={props.saving}
            />
            {props.platform === "windows" ? (
              <Checkbox
                label="按 Windows 全量替换 ZIP 发布"
                description="外链地址即使没有 .zip 后缀，也会让客户端执行静默全量替换。"
                checked={props.form.externalDeliveryMode === "windows_full_replace_zip"}
                onChange={(event) =>
                  props.onChange({
                    ...props.form,
                    externalDeliveryMode: event.currentTarget.checked ? "windows_full_replace_zip" : "auto"
                  })
                }
                disabled={props.saving}
              />
            ) : null}
          </>
        ) : (
          <FileInput
            description={`单文件最大 ${formatUploadBytes(props.uploadMaxBytes)}。大文件上传需要等待，请不要重复点击。`}
            label="上传安装包文件"
            placeholder="选择安装包文件"
            accept={acceptedArtifactExtensionForPlatform(props.platform)}
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
            disabled={props.saving}
          />
        )}

        <Alert color="blue" variant="light">
          {props.form.source === "external"
            ? "外链会直接下发给客户端，不经过本地服务器中转下载。"
            : props.creatingRelease
              ? "保存后会创建发布记录，并上传这个安装包。"
              : "选择“上传文件”并选择新文件后保存，即可替换安装包；选择“外链地址”则直接保存外链。"}
        </Alert>

        <Group justify="flex-end">
          <Button variant="default" onClick={close} disabled={props.saving}>
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

function acceptedArtifactExtensionForPlatform(platform: AdminReleasePlatform) {
  if (platform === "windows") {
    return ".zip";
  }
  if (platform === "android") {
    return ".apk";
  }
  if (platform === "ios") {
    return ".ipa";
  }
  return ".dmg";
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
