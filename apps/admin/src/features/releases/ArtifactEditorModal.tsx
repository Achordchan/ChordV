import styles from "./ArtifactEditor.module.css";
import releaseStyles from "./ReleaseWorkspace.module.css";
import { Button, FileInput, Group, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import dialogStyles from "../editors/EditorDialog.module.css";
import { RemoteArtifactSourceFields } from "./RemoteArtifactSourceFields";
import { ArtifactImportProgress } from "./ArtifactImportProgress";
import type { ArtifactImportProgress as ImportProgress } from "../../api/client";
import type { ArtifactEditorFormState } from "./types";
import type { AdminReleasePlatform } from "../../api/client";

type ArtifactEditorModalProps = {
  opened: boolean;
  saving: boolean;
  importProgress: ImportProgress | null;
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
        : "正在获取安装包并保存到本站…";

  return (
    <Modal
      opened={props.opened}
      onClose={close}
      title={props.title}
      centered
      size={540}
      classNames={{content: styles.content, header: styles.header, title: styles.title, body: styles.body}}
      closeOnClickOutside={!props.saving}
      closeOnEscape={!props.saving}
    >
      <div className={`${dialogStyles.form} ${styles.form}`}><div className={styles.scroll}><Stack gap="md">
        {savingMessage && !props.importProgress ? (
          <Text size="sm" c="dimmed" role="status">{savingMessage}</Text>
        ) : null}

        <SegmentedControl
          classNames={{root: releaseStyles.sourcePicker, label: releaseStyles.sourceLabel, indicator: releaseStyles.sourceIndicator}}
          aria-label="安装包来源"
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
            { value: "external", label: "远程获取" },
            { value: "uploaded", label: "上传文件" }
          ]}
          disabled={props.saving}
        />

        {props.form.source === "external" ? (
          <RemoteArtifactSourceFields value={props.form.downloadUrl} platform={props.platform} disabled={props.saving}
            onChange={downloadUrl => props.onChange({ ...props.form, downloadUrl, fileSizeBytes: "", fileHash: "" })} />
        ) : (
          <FileInput
            description={`单文件最大 ${formatUploadBytes(props.uploadMaxBytes)}。`}
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

        <ArtifactImportProgress value={props.saving ? props.importProgress : null} />
        </Stack></div>
        <Group justify="flex-end" className={styles.footer}>
          <Button radius="sm" variant="default" onClick={close} disabled={props.saving}>
            取消
          </Button>
          <Button radius="sm" color="teal.9" onClick={props.onSubmit} loading={props.saving} disabled={props.form.source === "external" && !props.form.downloadUrl.trim()}>
            {props.submitLabel}
          </Button>
        </Group>
      </div>
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
