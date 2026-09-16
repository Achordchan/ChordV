import styles from "./ArtifactEditor.module.css";
import releaseStyles from "./ReleaseWorkspace.module.css";
import { Button, FileInput, Group, Modal, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import dialogStyles from "../editors/EditorDialog.module.css";
import { RemoteArtifactSourceFields } from "./RemoteArtifactSourceFields";
import { ArtifactImportProgress } from "./ArtifactImportProgress";
import type { ArtifactImportProgress as ImportProgress } from "../../api/client";
import type { ArtifactEditorFormState } from "./types";
import type { AdminReleasePlatform } from "../../api/client";

type ArtifactEditorModalProps = {
  opened: boolean;
  mode: "external" | "uploaded" | "existing";
  onModeChange: (mode: "external" | "uploaded" | "existing")=>void;
  existingFiles: Array<{value:string;label:string}>;
  reuseId: string | null;
  onReuseChange: (id:string|null)=>void;
  currentFile: { fileName?:string|null; fileSizeBytes?:string|null; downloadUrl:string; sourceUrl?:string|null } | null;
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
      : props.mode === "existing" ? "正在校验并复用已有文件…" : props.form.source === "uploaded" && props.form.selectedFile
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

        {props.currentFile ? <section><Text size="sm" fw={600}>当前文件：{props.currentFile.fileName||"外链安装包"}</Text><Text size="xs" c="dimmed" style={{overflowWrap:"anywhere"}}>{props.currentFile.fileSizeBytes?`${(Number(props.currentFile.fileSizeBytes)/1048576).toFixed(1)} MB · `:""}{props.currentFile.downloadUrl}</Text><Text size="xs" c="dimmed">选择新来源或文件后才会替换，原文件会保留到保存成功。</Text></section> : null}
        <SegmentedControl
          classNames={{root: releaseStyles.sourcePicker, label: releaseStyles.sourceLabel, indicator: releaseStyles.sourceIndicator}}
          aria-label="安装包来源"
          value={props.mode}
          onChange={value=>props.onModeChange(value as ArtifactEditorModalProps["mode"])}
          data={[
            { value: "external", label: "远程获取" },
            { value: "uploaded", label: "上传文件" },
            { value: "existing", label: "已有文件" }
          ]}
          disabled={props.saving}
        />

        {props.mode === "existing" ? <Select label="选择已托管文件" searchable data={props.existingFiles} value={props.reuseId} onChange={props.onReuseChange} disabled={props.saving} nothingFoundMessage="没有可复用的同平台文件"/> : props.mode === "external" ? (
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
                signatureFile: null,
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
        {props.platform === "windows" && props.mode === "uploaded" && props.form.selectedFile && (
          <FileInput label="更新签名文件" description="选择此安装包对应的 .sig 文件。" accept=".sig" value={props.form.signatureFile ?? null}
            disabled={props.saving} onChange={signatureFile => props.onChange({ ...props.form, signatureFile })} />
        )}
        <Group justify="flex-end" className={styles.footer}>
          <Button radius="sm" variant="default" onClick={close} disabled={props.saving}>
            取消
          </Button>
          <Button radius="sm" color="teal.9" onClick={props.onSubmit} loading={props.saving} disabled={props.mode === "existing" ? !props.reuseId : props.mode === "external" && !props.form.downloadUrl.trim()}>
            {props.submitLabel}
          </Button>
        </Group>
      </div>
    </Modal>
  );
}

function defaultArtifactTypeForPlatform(platform: AdminReleasePlatform): ArtifactEditorFormState["type"] {
  if (platform === "windows") {
    return "setup.exe";
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
    return ".exe";
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
