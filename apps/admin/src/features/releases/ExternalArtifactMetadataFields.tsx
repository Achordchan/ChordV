import styles from "./ReleaseWorkspace.module.css";
import { TextInput } from "@mantine/core";
import { DESKTOP_UPDATE_DOWNLOAD_LIMIT_LABEL } from "./artifactPayloads";

type ExternalArtifactMetadataValue = {
  fileSizeBytes: string;
  fileHash: string;
};

type ExternalArtifactMetadataFieldsProps = {
  value: ExternalArtifactMetadataValue;
  disabled: boolean;
  onChange: (patch: Partial<ExternalArtifactMetadataValue>) => void;
};

export function ExternalArtifactMetadataFields(props: ExternalArtifactMetadataFieldsProps) {
  return (
    <>
      <TextInput
        label="文件大小（字节）"
        description={`填写文件实际字节数，上限 ${DESKTOP_UPDATE_DOWNLOAD_LIMIT_LABEL}。`}
        placeholder="例如 104857600"
        inputMode="numeric"
        value={props.value.fileSizeBytes}
        onChange={(event) => props.onChange({ fileSizeBytes: event.currentTarget.value })}
        disabled={props.disabled}
      />
      <details className={styles.optionalMetadata}><summary>附加校验（选填）</summary><TextInput
        label="SHA-256 校验值（选填）"
        description="有效的 SHA-256 用于核对文件完整性。"
        placeholder="选填，64 位十六进制字符串"
        value={props.value.fileHash}
        onChange={(event) => props.onChange({ fileHash: event.currentTarget.value })}
        disabled={props.disabled}
      /></details>
    </>
  );
}
